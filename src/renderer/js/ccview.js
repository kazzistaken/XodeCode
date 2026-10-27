import { el } from './util.js';
import { renderRich } from './richtext.js';

/**
 * Renders a conversation the way the Claude Code terminal UI does:
 *
 *   > your prompt
 *   ⏺ Assistant text…
 *   ⏺ Bash(npm test)
 *     ⎿  first lines of output
 *        … +12 lines (click to expand)
 *   ⏺ Update(src/app.js)
 *     ⎿  Updated src/app.js with 2 additions and 1 removal
 *          12 - old line
 *          12 + new line
 *
 * Messages come from claudechat.js: { role: 'user' | 'assistant' | 'tool' |
 * 'error' | 'meta', ... }. Tool messages carry { tool, input, result }.
 */

const PREVIEW_LINES = 4;

/** Show a path relative to the session folder, like Claude Code does. */
function rel(path, cwd) {
  const value = String(path || '');
  if (!cwd) return value;
  const base = String(cwd).replace(/[\\/]+$/, '');
  if (value.toLowerCase().startsWith(base.toLowerCase() + '\\') || value.toLowerCase().startsWith(base.toLowerCase() + '/')) {
    return value.slice(base.length + 1);
  }
  return value;
}

function oneLine(text, max = 140) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function lineCount(text) {
  const value = String(text || '').replace(/\n$/, '');
  return value ? value.split('\n').length : 0;
}

/** The "Name(args)" header Claude Code prints for a tool call. */
export function toolTitle(tool, input = {}, cwd = '') {
  const name = String(tool || 'Tool');
  switch (name) {
    case 'Bash':
      return { name: 'Bash', args: oneLine(input.command, 160) };
    case 'PowerShell':
      return { name: 'PowerShell', args: oneLine(input.command, 160) };
    case 'Read':
      return { name: 'Read', args: rel(input.file_path, cwd) };
    case 'Edit':
    case 'MultiEdit':
      return { name: 'Update', args: rel(input.file_path, cwd) };
    case 'Write':
      return { name: 'Write', args: rel(input.file_path, cwd) };
    case 'NotebookEdit':
      return { name: 'Edit Notebook', args: rel(input.notebook_path, cwd) };
    case 'Glob':
    case 'Grep': {
      const parts = [`pattern: "${oneLine(input.pattern, 80)}"`];
      if (input.path) parts.push(`path: "${rel(input.path, cwd)}"`);
      if (input.glob) parts.push(`glob: "${input.glob}"`);
      return { name: 'Search', args: parts.join(', ') };
    }
    case 'LS':
      return { name: 'List', args: rel(input.path, cwd) };
    case 'TodoWrite':
      return { name: 'Update Todos', args: '' };
    case 'Task':
    case 'Agent':
      return { name: 'Task', args: oneLine(input.description || input.prompt, 100) };
    case 'WebFetch':
      return { name: 'Fetch', args: oneLine(input.url, 120) };
    case 'WebSearch':
      return { name: 'Web Search', args: `"${oneLine(input.query, 100)}"` };
    default: {
      const mcp = name.match(/^mcp__(.+?)__(.+)$/);
      const args = Object.entries(input)
        .slice(0, 3)
        .map(([key, value]) => `${key}: ${typeof value === 'string' ? `"${oneLine(value, 50)}"` : oneLine(JSON.stringify(value), 50)}`)
        .join(', ');
      if (mcp) return { name: `${mcp[1]} - ${mcp[2]} (MCP)`, args };
      return { name, args };
    }
  }
}

/* ----------------------------- results ------------------------------ */

/** "⎿  text" with optional collapsed overflow ("… +N lines"). */
function outputBlock(text, { error = false } = {}) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n');
  const box = el('div', { class: `cc-out${error ? ' is-error' : ''}` });
  const shown = el('div', { class: 'cc-out-text', text: lines.slice(0, PREVIEW_LINES).join('\n') });
  box.append(shown);
  if (lines.length > PREVIEW_LINES) {
    const more = el('button', {
      class: 'cc-more',
      type: 'button',
      text: `… +${lines.length - PREVIEW_LINES} lines (click to expand)`,
    });
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = box.classList.toggle('is-open');
      shown.textContent = open ? lines.join('\n') : lines.slice(0, PREVIEW_LINES).join('\n');
      more.textContent = open ? 'collapse' : `… +${lines.length - PREVIEW_LINES} lines (click to expand)`;
    });
    box.append(more);
  }
  return box;
}

/** Line diff for Edit/MultiEdit, in Claude Code's red/green style. */
function diffBlock(edits) {
  const rows = [];
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    const before = String(edit.old_string ?? '').split('\n');
    const after = String(edit.new_string ?? '').split('\n');
    // Trim the lines both sides share at the start and end, so only the
    // change itself is shown (with one line of context).
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
    let tail = 0;
    while (
      tail < before.length - head &&
      tail < after.length - head &&
      before[before.length - 1 - tail] === after[after.length - 1 - tail]
    ) {
      tail += 1;
    }
    if (rows.length) rows.push({ kind: 'gap', text: '…' });
    if (head > 0) rows.push({ kind: 'ctx', text: before[head - 1] });
    for (const line of before.slice(head, before.length - tail)) {
      rows.push({ kind: 'del', text: line });
      removed += 1;
    }
    for (const line of after.slice(head, after.length - tail)) {
      rows.push({ kind: 'add', text: line });
      added += 1;
    }
    if (tail > 0) rows.push({ kind: 'ctx', text: after[after.length - tail] });
  }
  const capped = rows.slice(0, 40);
  const box = el(
    'div',
    { class: 'cc-diff' },
    ...capped.map((row) =>
      el(
        'div',
        { class: `cc-diff-line is-${row.kind}` },
        el('span', { class: 'cc-diff-sign', text: row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ' }),
        el('span', { class: 'cc-diff-text', text: row.text || ' ' })
      )
    )
  );
  if (rows.length > capped.length) {
    box.append(el('div', { class: 'cc-diff-line is-gap', text: `… +${rows.length - capped.length} more lines` }));
  }
  return { box, added, removed };
}

function todoBlock(todos) {
  return el(
    'div',
    { class: 'cc-todos' },
    ...(Array.isArray(todos) ? todos : []).map((todo) => {
      const status = todo.status || 'pending';
      const mark = status === 'completed' ? '☒' : '☐';
      return el(
        'div',
        { class: `cc-todo is-${status}` },
        el('span', { class: 'cc-todo-mark', text: mark }),
        el('span', { class: 'cc-todo-text', text: todo.content || todo.activeForm || '' })
      );
    })
  );
}

/** The summary and body Claude Code shows under a finished tool call. */
function toolResult(message, cwd) {
  const { tool, input = {}, result } = message;
  const wrap = el('div', { class: 'cc-result' }, el('span', { class: 'cc-elbow', text: '⎿' }));
  const body = el('div', { class: 'cc-result-body' });
  wrap.append(body);

  if (result.isError) {
    body.append(outputBlock(`Error: ${result.text}`, { error: true }));
    return wrap;
  }

  const text = result.text || '';
  switch (tool) {
    case 'Read':
      body.append(el('div', { class: 'cc-summary', text: `Read ${plural(result.lines || lineCount(text), 'line')}` }));
      break;
    case 'Edit':
    case 'MultiEdit': {
      const edits = tool === 'MultiEdit' ? input.edits || [] : [input];
      const diff = diffBlock(edits);
      body.append(
        el('div', {
          class: 'cc-summary',
          html: `Updated <strong>${escape(rel(input.file_path, cwd))}</strong> with ${plural(diff.added, 'addition')} and ${plural(diff.removed, 'removal')}`,
        }),
        diff.box
      );
      break;
    }
    case 'Write': {
      const content = String(input.content || '');
      const lines = content.split('\n');
      body.append(
        el('div', {
          class: 'cc-summary',
          html: `Wrote ${plural(lineCount(content), 'line')} to <strong>${escape(rel(input.file_path, cwd))}</strong>`,
        }),
        outputBlock(lines.slice(0, 12).join('\n') + (lines.length > 12 ? `\n… +${lines.length - 12} lines` : ''))
      );
      break;
    }
    case 'Glob':
    case 'Grep': {
      const count = lineCount(text.replace(/^No files found\s*$/i, ''));
      body.append(el('div', { class: 'cc-summary', text: count ? `Found ${plural(count, input.output_mode === 'content' ? 'line' : 'file')}` : 'Found 0 files' }));
      break;
    }
    case 'LS':
      body.append(el('div', { class: 'cc-summary', text: `Listed ${plural(lineCount(text), 'path')}` }));
      break;
    case 'TodoWrite':
      body.append(todoBlock(input.todos));
      break;
    case 'WebFetch':
      body.append(el('div', { class: 'cc-summary', text: `Received ${(text.length / 1024).toFixed(1)}KB` }));
      break;
    default:
      body.append(text.trim() ? outputBlock(text) : el('div', { class: 'cc-summary', text: '(No content)' }));
  }
  return wrap;
}

function escape(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/* ------------------------------ messages ----------------------------- */

export function renderMessage(message, { cwd = '', running = false } = {}) {
  if (message.role === 'user') {
    return el('div', { class: 'cc-row cc-user' }, el('span', { class: 'cc-gt', text: '>' }), el('span', { class: 'cc-user-text', text: message.text }));
  }
  if (message.role === 'assistant') {
    const text = el('div', { class: 'cc-text' });
    text.innerHTML = renderRich(message.text);
    return el('div', { class: 'cc-row cc-assistant' }, el('span', { class: 'cc-dot', text: '⏺' }), text);
  }
  if (message.role === 'tool') {
    // Older saved chats stored only a name and a one-line detail.
    const tool = message.tool || message.text || 'Tool';
    const title = message.tool ? toolTitle(tool, message.input, cwd) : { name: tool, args: message.detail || '' };
    const state = message.result ? (message.result.isError ? 'is-error' : 'is-done') : running ? 'is-running' : 'is-done';
    const head = el(
      'div',
      { class: 'cc-tool-head' },
      el('span', { class: `cc-dot ${state}`, text: '⏺' }),
      el(
        'span',
        { class: 'cc-tool-title' },
        el('strong', { text: title.name }),
        title.args ? el('span', { class: 'cc-tool-args', text: `(${title.args})` }) : null
      )
    );
    const row = el('div', { class: 'cc-row cc-tool' }, head);
    if (message.result) row.append(toolResult({ ...message, tool }, cwd));
    else if (running) row.append(el('div', { class: 'cc-result' }, el('span', { class: 'cc-elbow', text: '⎿' }), el('span', { class: 'cc-summary is-dim', text: 'Running…' })));
    return row;
  }
  if (message.role === 'error') {
    return el('div', { class: 'cc-row cc-error' }, el('span', { class: 'cc-dot is-error', text: '⏺' }), el('span', { text: message.text }));
  }
  // meta: cost / timing, dim and right under the turn
  return el('div', { class: 'cc-meta', text: message.text });
}

/** Claude Code's welcome box, shown at the top of every conversation. */
export function welcomeBox(cwd) {
  return el(
    'div',
    { class: 'cc-welcome' },
    el('div', { class: 'cc-welcome-title' }, el('span', { class: 'cc-star', text: '✻' }), ' Welcome to ', el('strong', { text: 'Claude Code' }), '!'),
    el('div', { class: 'cc-welcome-dim', text: '/help for help, /model to switch models, /clear for a new chat' }),
    el('div', { class: 'cc-welcome-dim', text: `cwd: ${cwd || '~'}` })
  );
}

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const VERBS = [
  'Thinking', 'Pondering', 'Brewing', 'Cooking', 'Crafting', 'Musing', 'Noodling',
  'Percolating', 'Puzzling', 'Ruminating', 'Simmering', 'Synthesizing', 'Tinkering', 'Wrangling',
];

/** The animated "✻ Pondering… (12s · esc to interrupt)" line. */
export function spinnerRow() {
  const glyph = el('span', { class: 'cc-spin', text: SPINNER[0] });
  const verb = VERBS[Math.floor(Math.random() * VERBS.length)];
  const label = el('span', { class: 'cc-spin-verb', text: `${verb}…` });
  const meta = el('span', { class: 'cc-spin-meta', text: '(0s · esc to interrupt)' });
  const row = el('div', { class: 'cc-row cc-spinner' }, glyph, label, meta);
  const started = Date.now();
  let frame = 0;
  const timer = setInterval(() => {
    if (!row.isConnected) {
      clearInterval(timer);
      return;
    }
    frame = (frame + 1) % SPINNER.length;
    glyph.textContent = SPINNER[frame];
    meta.textContent = `(${Math.floor((Date.now() - started) / 1000)}s · esc to interrupt)`;
  }, 120);
  return row;
}
