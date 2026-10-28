'use strict';

/* ------------------------------------------------------------------ *
 * Shared-context log (main process)
 *
 * Every finished agent turn becomes one entry, appended to
 *   <workspace>/.xode/context-log.jsonl   (source of truth, one JSON per line)
 *   <workspace>/.xode/context-log.md      (readable mirror, never read back)
 *
 * Writes are synchronous, so turns that finish at the same moment are
 * serialised by the event loop and never interleave. Each entry goes out in
 * one write; a torn last line from a crash is skipped on read and fenced off
 * by a newline before the next append. Ids already on disk are remembered per
 * workspace, so a turn is never written twice, even across restarts.
 *
 * A turn is finalised exactly once: on its first `result`, or when its
 * process closes, errors or is replaced without one.
 * ------------------------------------------------------------------ */

const path = require('node:path');
const fs = require('node:fs');

const DIR = '.xode';
const JSONL = 'context-log.jsonl';
const MARKDOWN = 'context-log.md';
const MAX_FIELD = 1000000;
const DEFAULT_LIMIT = 500;
// Tools whose input names a file they write.
const FILE_TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

const logDir = (workspace) => path.join(workspace, DIR);
const jsonlFile = (workspace) => path.join(logDir(workspace), JSONL);
const markdownFile = (workspace) => path.join(logDir(workspace), MARKDOWN);

function workspaceKey(workspace) {
  const resolved = path.resolve(String(workspace));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Parse a jsonl file, skipping torn or corrupt lines and repeated ids. */
function readEntries(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry.id !== 'string' || seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    } catch {
      /* torn line from a crash */
    }
  }
  return entries;
}

/** Append text in one write; start on a fresh line if the file ends mid-line. */
function appendDurably(file, text) {
  const fd = fs.openSync(file, 'a+');
  try {
    const { size } = fs.fstatSync(fd);
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    fs.writeSync(fd, prefix + text);
  } finally {
    fs.closeSync(fd);
  }
}

/** A code fence longer than any backtick run inside `text`. */
function fence(text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function markdownEntry(entry) {
  const who = entry.joint ? `${entry.agentName} · ${entry.joint.name || entry.joint.id}` : entry.agentName;
  const lines = [
    `## ${entry.ts} — ${who} — ${entry.status}`,
    '',
    `- id: \`${entry.id}\``,
    `- agent: ${entry.agentName} (\`${entry.agentId}\`)${entry.rank ? `, ${entry.rank}` : ''}`,
    `- model: ${entry.model || 'unknown'}${entry.effort ? ` (${entry.effort})` : ''}`,
    `- joint: ${entry.joint ? `${entry.joint.name || ''} (\`${entry.joint.id}\`)` : 'none'}`,
    `- started: ${entry.startedAt}`,
  ];
  if (entry.durationMs != null) lines.push(`- duration: ${(entry.durationMs / 1000).toFixed(1)}s`);
  if (entry.costUsd != null) lines.push(`- cost: $${entry.costUsd.toFixed(4)}`);
  lines.push(`- tools used: ${entry.toolCount}`);
  if (entry.truncated) lines.push(`- truncated: fields over ${MAX_FIELD} characters were cut`);
  if (entry.filesChanged.length) {
    lines.push('- files changed:');
    for (const file of entry.filesChanged) lines.push(`  - \`${file}\``);
  } else {
    lines.push('- files changed: none');
  }
  const sections = [['Prompt', entry.prompt], ['Output', entry.output]];
  if (entry.error) sections.push(['Error', entry.error]);
  for (const [title, body] of sections) {
    const mark = fence(body);
    lines.push('', `### ${title}`, '', mark, body, mark);
  }
  lines.push('', '---', '', '');
  return lines.join('\n');
}

/**
 * @param {{ send: (channel: string, payload: any) => void, log?: Function }} options
 */
function createContextLog({ send, log = () => {} }) {
  /** workspaceKey -> Set of entry ids already on disk */
  const known = new Map();
  /** turnId -> turn in progress */
  const turns = new Map();
  /** agentId -> its open turnIds, oldest first */
  const open = new Map();
  let seq = 0;

  function idsFor(workspace) {
    const key = workspaceKey(workspace);
    let ids = known.get(key);
    if (!ids) {
      ids = new Set(readEntries(jsonlFile(workspace)).map((entry) => entry.id));
      known.set(key, ids);
    }
    return ids;
  }

  /** Write one finished entry. Returns false for a duplicate or a failed write. */
  function append(entry) {
    const ids = idsFor(entry.workspace);
    if (ids.has(entry.id)) return false;
    try {
      fs.mkdirSync(logDir(entry.workspace), { recursive: true });
      appendDurably(jsonlFile(entry.workspace), `${JSON.stringify(entry)}\n`);
    } catch (error) {
      log(`context-log: could not write ${jsonlFile(entry.workspace)}: ${error.message}`);
      return false;
    }
    ids.add(entry.id);
    try {
      appendDurably(markdownFile(entry.workspace), markdownEntry(entry));
    } catch (error) {
      log(`context-log: could not write ${markdownFile(entry.workspace)}: ${error.message}`);
    }
    send('context-log:updated', entry);
    return true;
  }

  /* ---------------------------- turn capture ---------------------------- */

  /**
   * Start tracking one turn and return its id. A chat runs one turn at a
   * time, so its previous open turn is finalised as interrupted first; pass
   * `queue: true` (the Director) to keep earlier turns open in FIFO order.
   */
  function begin(agentId, fields = {}) {
    const key = String(agentId);
    if (!fields.queue) interrupt(key);
    const startedAt = Date.now();
    const turn = {
      id: `${key}-${startedAt}-${++seq}`,
      startedAt,
      agentId: key,
      agentName: String(fields.agentName || '') || key,
      model: String(fields.model || ''),
      effort: fields.effort ? String(fields.effort) : null,
      joint: fields.joint && fields.joint.id ? { id: String(fields.joint.id), name: String(fields.joint.name || '') } : null,
      rank: fields.rank === 'lead' || fields.rank === 'worker' ? fields.rank : null,
      prompt: String(fields.prompt ?? ''),
      workspace: path.resolve(String(fields.workspace)),
      sessionId: String(fields.sessionId || ''),
      texts: [],
      files: new Set(),
      toolCount: 0,
      result: null,
      stderr: '',
    };
    turns.set(turn.id, turn);
    if (!open.has(key)) open.set(key, []);
    open.get(key).push(turn.id);
    return turn.id;
  }

  /** The agent's oldest open turn (the one the next `result` belongs to). */
  function head(agentId) {
    const queue = open.get(String(agentId));
    return queue && queue.length ? queue[0] : null;
  }

  /** Feed one raw stream-json line from the turn's process stdout. */
  function observe(turnId, line) {
    const turn = turnId && turns.get(turnId);
    if (!turn) return;
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    if (json.type === 'system' && json.subtype === 'init') {
      if (json.model) turn.model = json.model;
      if (json.session_id) turn.sessionId = json.session_id;
    } else if (json.type === 'assistant' && json.message) {
      for (const block of json.message.content || []) {
        if (block.type === 'text' && block.text) turn.texts.push(block.text);
        else if (block.type === 'tool_use') {
          turn.toolCount += 1;
          const target = FILE_TOOLS[block.name] && block.input && block.input[FILE_TOOLS[block.name]];
          if (target) turn.files.add(path.resolve(turn.workspace, String(target)));
        }
      }
    } else if (json.type === 'result') {
      turn.result = json;
      if (json.session_id) turn.sessionId = json.session_id;
      // The turn is over: log it now instead of waiting for the process to exit.
      finish(turnId);
    }
  }

  function noteStderr(turnId, chunk) {
    const turn = turnId && turns.get(turnId);
    if (turn) turn.stderr = (turn.stderr + chunk).slice(-4000);
  }

  /**
   * Finalise a turn and write its entry (at most once; later calls are no-ops).
   * Without a result the turn is 'interrupted', or 'error' when the process
   * failed (`{ failed: true }`, e.g. non-zero exit) and left an error behind.
   */
  function finish(turnId, { failed = false, error = '' } = {}) {
    const turn = turnId && turns.get(turnId);
    if (!turn) return null;
    turns.delete(turnId);
    const queue = open.get(turn.agentId);
    if (queue) {
      const index = queue.indexOf(turnId);
      if (index !== -1) queue.splice(index, 1);
      if (!queue.length) open.delete(turn.agentId);
    }

    const result = turn.result;
    const stderr = String(error || turn.stderr).trim();
    let status;
    let errorText = null;
    if (result) {
      status = result.is_error ? 'error' : 'ok';
      if (result.is_error) errorText = String(result.result || result.subtype || 'error');
    } else if ((failed || error) && stderr) {
      status = 'error';
      errorText = stderr;
    } else {
      status = 'interrupted';
      errorText = stderr || null;
    }
    let output = result && typeof result.result === 'string' ? result.result : '';
    if (!output) output = turn.texts.join('\n\n');

    let truncated = false;
    const cap = (text) => {
      if (text == null || text.length <= MAX_FIELD) return text;
      truncated = true;
      return text.slice(0, MAX_FIELD);
    };
    const entry = {
      v: 1,
      id: turn.id,
      ts: new Date().toISOString(),
      startedAt: new Date(turn.startedAt).toISOString(),
      workspace: turn.workspace,
      agentId: turn.agentId,
      agentName: turn.agentName,
      model: turn.model,
      effort: turn.effort,
      joint: turn.joint,
      rank: turn.rank,
      sessionId: turn.sessionId,
      prompt: cap(turn.prompt),
      output: cap(output),
      filesChanged: [...turn.files],
      toolCount: turn.toolCount,
      status,
      error: cap(errorText),
      costUsd: result && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
      durationMs: result && Number.isFinite(result.duration_ms) ? result.duration_ms : Date.now() - turn.startedAt,
    };
    if (truncated) entry.truncated = true;
    return append(entry) ? entry : null;
  }

  /** Finalise every turn the agent still has open (stopped, replaced, died). */
  function interrupt(agentId, options) {
    for (const turnId of [...(open.get(String(agentId)) || [])]) finish(turnId, options);
  }

  /** On quit: log every turn still running as interrupted. */
  function finishAll() {
    for (const turnId of [...turns.keys()]) finish(turnId);
  }

  /* ------------------------------- read API ------------------------------ */

  /** Entries for one workspace, newest first (default 500). */
  function list({ workspace, limit } = {}) {
    if (!workspace) return [];
    const entries = readEntries(jsonlFile(path.resolve(String(workspace))));
    const capped = Math.floor(Number(limit)) > 0 ? Math.floor(Number(limit)) : DEFAULT_LIMIT;
    return entries.slice(-capped).reverse();
  }

  function paths({ workspace } = {}) {
    if (!workspace) return { jsonl: '', md: '' };
    const resolved = path.resolve(String(workspace));
    return { jsonl: jsonlFile(resolved), md: markdownFile(resolved) };
  }

  return { begin, head, observe, noteStderr, finish, interrupt, finishAll, list, paths, append };
}

module.exports = { createContextLog, readEntries, markdownEntry };
