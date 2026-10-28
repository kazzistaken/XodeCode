'use strict';

const { app, BrowserWindow, ipcMain, dialog, net, protocol, shell, clipboard, webContents } = require('electron');

// Dev/test hook: run against a throwaway profile instead of the real one.
if (process.env.XODECODE_USERDATA) app.setPath('userData', process.env.XODECODE_USERDATA);
// The stress test must never start a Claude process (Director, chats or agents).
const NO_CLAUDE = ['stress', 'onboard'].includes(process.env.XODECODE_TEST_KIND);
if (NO_CLAUDE) {
  // Measure real frames: never throttle the test window when it is covered.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const pty = require('node-pty');
const { createControlServer } = require('./control');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEME = 'app';
const HOST = 'xodecode';
const CLI_PATH = path.join(ROOT, 'bin', 'xode.js');

/* ------------------------------------------------------------------ *
 * Model policy
 *   Defaults: Sonnet 5.5 for normal work, Opus 5.5 for hard work.
 *   Other models (Haiku, Fable) are only used when the user asks for them
 *   by name — the Director is instructed never to pick them on its own.
 * ------------------------------------------------------------------ */

// The Director only opens, closes and arranges windows and writes prompts, so
// a fast model at low effort answers in a second or two. Settings can raise it.
const DIRECTOR_MODEL = 'claude-sonnet-5-5';
const DIRECTOR_EFFORT = 'low';
const MINIMUM_MODEL = 'claude-sonnet-5-5';
const MODEL_ALIASES = {
  sonnet: 'claude-sonnet-5-5',
  'sonnet 5.5': 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  'opus 5.5': 'claude-opus-5-5',
  haiku: 'claude-haiku-5-5',
  'haiku 5.5': 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
  'fable 5.1': 'claude-fable-5-1',
};
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// The distinct model ids the aliases resolve to (used by the Settings picker).
const ALLOWED_MODELS = [...new Set(Object.values(MODEL_ALIASES))];

function normalizeModel(model) {
  const text = String(model || '')
    .trim()
    .toLowerCase();
  if (!text) return MINIMUM_MODEL;
  if (MODEL_ALIASES[text]) return MODEL_ALIASES[text];
  if (/^[a-z0-9][a-z0-9._-]{1,60}$/i.test(text)) return text;
  return MINIMUM_MODEL;
}

function normalizeEffort(effort) {
  return EFFORTS.has(effort) ? effort : 'medium';
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

const userDataDir = () => app.getPath('userData');
const contextFile = () => path.join(userDataDir(), 'fleet-context.md');
const directorFile = () => path.join(userDataDir(), 'director.md');
const directorMcpFile = () => path.join(userDataDir(), 'director-mcp.json');
const chatsDir = () => path.join(userDataDir(), 'chats');
// Chat ids map 1:1 onto file names. Anything else is refused rather than
// "cleaned", so two conversations can never share (and leak into) one file.
const chatFile = (id) => (/^[\w-]+$/.test(String(id ?? '')) ? path.join(chatsDir(), `${id}.json`) : null);
const MCP_PATH = path.join(ROOT, 'bin', 'xode-mcp.js');
const agentsDir = () => path.join(userDataDir(), 'agents');
// Every Claude agent reaches the app through its own MCP server named "xode".
const AGENT_TOOLS = 'mcp__xode';
const AGENT_TOOLS_HINT =
  'You are running inside XodeCode, a canvas of app windows. Your xode tools (mcp__xode__*) let you' +
  ' see the canvas, open browser windows on it, navigate, read pages, take screenshots, click, type and' +
  ' run JavaScript in browsers you opened, and pin notes. Use a browser to check web work you build' +
  ' (open its local URL, screenshot it, fix what looks wrong). Only windows you opened are yours to' +
  " control; leave the user's and other agents' windows alone.";
const jointsDir = () => path.join(userDataDir(), 'joints');
const jointContextFile = (id) => path.join(jointsDir(), `${String(id).replace(/[^\w.-]/g, '')}.md`);

function jointTemplate(name) {
  return [
    `# Joint context — ${name}`,
    '',
    '_Shared brief for every member of this joint. Read this first and keep it current._',
    '',
    '## Goal',
    '',
    '_What the team is building._',
    '',
    '## Split',
    '',
    '_Who owns which part, and which files each member owns._',
    '',
    '## Interfaces',
    '',
    '_Types, names, routes and contracts the members agreed on._',
    '',
    '## Decisions',
    '',
    '- (none yet)',
    '',
    '## Open questions',
    '',
    '- (none)',
    '',
  ].join('\n');
}

function ensureSupportFiles() {
  const dir = userDataDir();
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(directorFile(), directorInstructions(), 'utf8');

  if (!fs.existsSync(contextFile())) {
    fs.writeFileSync(
      contextFile(),
      [
        '# Fleet context',
        '',
        `Project: ${defaultWorkspace()}`,
        '',
        '## Brief',
        '',
        '_No brief yet. The Director keeps this file current so every agent starts with the same picture._',
        '',
        '## Decisions',
        '',
        '- (none yet)',
        '',
        '## Ownership',
        '',
        '- (no files claimed yet)',
        '',
        '## Open questions',
        '',
        '- (none)',
        '',
      ].join('\n'),
      'utf8'
    );
  }
}

/**
 * The Director's whole system prompt. It replaces Claude Code's default prompt
 * (the Director has no file or shell tools, only `canvas` and `run`), which
 * keeps every turn small and fast.
 */
function directorInstructions() {
  return `You are the Director of XodeCode, a desktop app whose screen is a canvas of app windows.
You are the user's hands inside the app. Your job: open, close, arrange and focus windows, and
start or prompt Claude Code sessions (single agents or jointed teams) when the user asks. You do
not write code yourself, and you never touch anything outside the app.
You are an AI agent, not the user. The user is the human talking to you; they outrank you and
every agent. Refer to yourself as "I" (or "the Director") and to the user as "you". In a team
(joint) the order is: user > you, the Director > the team lead > its workers.

# How to work (be fast)
- Each user message begins with a [canvas] snapshot: the active page, layout, every window in
  tile order (id, kind, name, title, status) and other pages. Trust it. Call \`canvas\` only if you
  need something it lacks (exact rects, urls on other pages).
- Then come [context] blocks: the fleet context (the shared brief every standalone session reads)
  and each team's brief (what that joint is working on, its split and decisions). A block is
  shown in full when new or changed, otherwise marked "unchanged" - rely on the version you saw
  earlier. Use them to answer questions about the work and to write good prompts; update them
  with {op:"context"} / {op:"joint_brief"} only when the user asks.
- Do the entire request in ONE \`run\` call: put every action in its \`actions\` array. Actions run
  at the same time and the windows settle into one smooth layout. Never spread independent actions
  over several calls or turns.
- Trust what \`run\` returns: each action reports ok or an error. Do not call \`canvas\` afterwards to
  double-check, and never wait for an agent to finish its work.
- Then reply with ONE short plain sentence (under 15 words) saying what you did, e.g. "Opened
  YouTube and GitHub side by side." No markdown, no caveats. If an action failed, say which.
- Only act when asked. If the user is just chatting or asking a question, answer briefly and do
  nothing. Never spawn or prompt agents on your own initiative and never invent tasks.
- Messages starting with [Team report] come from a team lead, not the user. You may act on them
  within that team's existing goal (e.g. send the lead its next step or unblock it) but never
  start new work, and never raise a team's budget unless the user asks. If nothing is needed,
  reply with one short sentence summarising the report for the user.
- Refer to windows by id, name (e.g. "Skye") or title. "it"/"that" means the focused window or the
  one you last opened.

# Actions for \`run\` (op + fields)
Windows
- {op:"terminal", count?, title?, cwd?}  plain shell. "terminal", "shell", "console" mean this.
- {op:"browser", url, title?}  in-app browser. Bare site names are fine ("youtube").
- {op:"navigate", node, url}  send an open browser somewhere else.
- {op:"music", url?, spotify?} · {op:"board", title?} · {op:"note", text} · {op:"text", text}
- {op:"close", node} · {op:"close", kind:"browser"|"terminal"|"agent"|"music"|"note"|...} ·
  {op:"close", all:true}  closes windows to the dock (bottom-left), where they keep running.
  Add forever:true only if the user says "permanently", "for good", "kill" or "delete".
- {op:"focus", node}  bring a window into view and give it the keyboard.
- {op:"clear"}  clear the canvas: every window goes to the dock.
- {op:"restore", node} · {op:"restore", all:true}  bring windows back from the dock.

Arranging (windows auto-tile to fill the screen; this changes how)
- {op:"arrange", mode:"grid"|"columns"|"rows"|"focus", main?}  "focus" = one big main window
  (main = node) with the rest stacked beside it. "side by side" = columns, "stacked" = rows.
- {op:"swap", a, b}  swap two windows' places. {op:"order", nodes:[...]}  set the tile order.
- {op:"zoom", to:"in"|"out"|"reset"|"fit"} or {op:"zoom", scale}
- {op:"move", node, x, y} / {op:"resize", node, w, h}  free placement (turns auto-tiling off).
- {op:"tile"}  turn auto-tiling back on and re-tile.

Claude Code sessions
- {op:"agent", prompt?, model?, effort?, title?, cwd?}  one Claude Code session. With no prompt
  it opens idle and waits. Never write a filler prompt.
- {op:"send", agent, text}  prompt an existing session.
- {op:"model", agent, model} · {op:"effort", agent, effort}
- {op:"joint", name, brief, members:[{role, prompt, model, effort, title?, lead?}]}  a jointed
  team: 2-5 agents in one folder sharing one brief. All members start together. Exactly one
  member is the team lead (lead:true, else the first); the rest are workers under it.
- {op:"joint_add", joint, role, prompt, model, effort}  adds a worker under the team's lead.
- {op:"joint_brief", joint, text, append?}
- {op:"team_budget", joint, usd}  cap a team's spend (0 = no cap) · {op:"board", joint}  open that
  team's live task board · {op:"open", target:"hierarchy"}  the org-chart view.
- {op:"lead", agent} make it its team's lead (old lead becomes a worker) · {op:"demote", agent}
  hand the lead role to the next member · {op:"move_team", agent, joint} move into a team as a
  worker; joint:"none" takes it out of every team.
  Teams (joints) only: ranks are user > you (the Director) > lead > workers. Standalone sessions
  have no rank. Team members have their own team tools: leads start/prompt their own workers and
  edit the brief; everyone reports up. Latest reports show in the snapshot as [reported ...].
- {op:"context", text, append?}  the shared brief every agent reads.

Pages and app
- {op:"page", index} · {op:"page", add:true, name?} · {op:"page", close:index} ·
  {op:"page", rename:index, name}
- {op:"workspace", path} · {op:"theme", id:"graphite"|"slate"|"ash"} · {op:"notify", text}
- {op:"background", id:"aurora"|"sunset"|"nebula"|"deepsea"|"dusk-forest"|"midnight-grid"|"none"}  switch the canvas background.
- {op:"undo"} · {op:"redo"} · {op:"open", target:"settings"|"map"}

# Writing prompts for agents (agent, send, joint, joint_add, joint_brief)
An agent sees only your prompt and the code. It never sees the user's message, this chat or the
canvas. Write every prompt as a self-contained brief a strong engineer could act on alone:
1. Goal: the outcome and why it matters, in one or two sentences. Keep the user's intent and
   quote their exact words when wording matters ("make it feel less cluttered").
2. Context: the files, folders, functions, URLs, errors (pasted exactly) and prior decisions
   that matter. Name things; never "the bug" or "that file".
3. Scope: what to change, what to leave alone, conventions to match (style, libraries, tests).
   No new dependencies or broad refactors unless the task needs them.
4. Done when: concrete checks, e.g. "npm test passes", "the page loads at localhost:5173 with no
   console errors", "clicking Save persists after reload". For UI work: open it in a browser with
   your xode tools and screenshot it.
5. Report: what to say when finished (a short summary, files changed, anything left open). In a
   team: "call report with done / blocked / question".
Write plain, direct prose, usually 4-12 lines: no role-play openers ("You are an expert..."), no
filler, no shouting. Decide cheap ambiguities yourself and state the assumption in the prompt;
if an ambiguity would change the outcome, ask the user before prompting. One task per agent;
split independent work across agents instead of one giant prompt. For a follow-up (send), say
what to change relative to what the agent just did, plus the new done-when.
Joint briefs: goal, the split (who owns which files), shared interfaces/contracts between the
parts, and the team's done-when. Lead prompt: coordinate, review and integrate the workers'
changes, keep the brief current, report up. Worker prompt: its slice, its files, the interfaces
it must honour, its done-when.

# Sessions: models and joints
- Use a joint only when the user asks for one ("jointed", "a team", "N agents on X") or the work
  clearly splits. You write every member's prompt: split the request into independent
  workstreams, give each member its own files, and put goal + split + file ownership in the brief.
- In a joint, the lead coordinates (default claude-opus-5-5, high) and workers build (default
  claude-sonnet-5-5, medium); give the lead a coordinating prompt, workers concrete tasks.
- Route by difficulty: hard, logical or architectural work -> claude-opus-5-5, effort high.
  Simple, mechanical or UI work -> claude-sonnet-5-5, effort low or medium. Default for a single
  agent: claude-sonnet-5-5, medium.
- If the user names a model (sonnet, opus, haiku, fable or a full id) use exactly that. Never pick
  haiku or fable on your own.
- If the active page has no workspace and the user wants agent work, ask them to pick a folder.
`;
}
/* ------------------------------------------------------------------ *
 * Protocol + window
 * ------------------------------------------------------------------ */

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** @type {Map<string, import('node-pty').IPty>} */
const terminals = new Map();
let terminalSeq = 0;

/**
 * PTY output arrives in hundreds of tiny chunks per second. Coalescing them
 * into one frame (16ms) cuts IPC traffic by an order of magnitude without
 * losing a byte or delaying the first keystroke echo beyond a single frame.
 */
const OUTPUT_FRAME_MS = 16;
/** @type {Map<string, {chunks: string[], timer: NodeJS.Timeout | null}>} */
const outputBuffers = new Map();

function queueOutput(id, data) {
  let entry = outputBuffers.get(id);
  if (!entry) {
    entry = { chunks: [], timer: null };
    outputBuffers.set(id, entry);
  }
  entry.chunks.push(data);
  if (entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (!entry.chunks.length) return;
    const text = entry.chunks.join('');
    entry.chunks.length = 0;
    send('pty:data', { id, data: text });
  }, OUTPUT_FRAME_MS);
}

function flushOutput(id) {
  const entry = outputBuffers.get(id);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.chunks.length) {
    send('pty:data', { id, data: entry.chunks.join('') });
  }
  outputBuffers.delete(id);
}

const control = createControlServer({
  sendToRenderer: (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  },
});

function serveProjectFile(request) {
  const url = new URL(request.url);
  const filePath = path.join(ROOT, decodeURIComponent(url.pathname));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return new Response('Not found', { status: 404 });
  }
  return net.fetch(pathToFileURL(filePath).toString());
}

/* ------------------------------------------------------------------ *
 * Environment helpers
 * ------------------------------------------------------------------ */

function existsInPath(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, bin + ext)).isFile()) return path.join(dir, bin + ext);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function resolveShell() {
  if (process.platform === 'win32') {
    const pwsh = existsInPath('pwsh');
    if (pwsh) return { file: pwsh, args: ['-NoLogo'], label: 'pwsh' };
    return { file: process.env.ComSpec || 'cmd.exe', args: [], label: 'cmd' };
  }
  const sh = process.env.SHELL || '/bin/bash';
  return { file: sh, args: ['-l'], label: path.basename(sh) };
}

function defaultWorkspace() {
  return process.env.USERPROFILE || os.homedir() || ROOT;
}

/** Make a value safe to pass as a single quoted argument to the shell. */
function quote(value) {
  const clean = String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .trim();
  return `"${clean}"`;
}

/**
 * Find the real Claude Code executable. npm installs a `.cmd` shim on Windows
 * that just forwards to a bundled `claude.exe`; launching that exe directly
 * skips cmd.exe entirely, so arguments need no shell quoting and the process
 * starts faster.
 */
function resolveClaude() {
  const found = existsInPath('claude');
  if (!found) return null;
  if (/\.(cmd|bat)$/i.test(found)) {
    const exe = path.join(
      path.dirname(found),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe'
    );
    if (fs.existsSync(exe)) return { file: exe, shell: false };
    return { file: found, shell: true };
  }
  return { file: found, shell: false };
}

/** Spawn `claude` headless with real argv (falls back to a quoted shell line). */
function spawnClaudeProcess(args, { cwd, env }) {
  const bin = resolveClaude();
  if (!bin) throw new Error('claude not found on PATH');
  const options = { cwd, env, windowsHide: true };
  if (!bin.shell) return spawn(bin.file, args, options);
  const line = [quote(bin.file), ...args.map((arg) => (/^[\w.:\\/=@,-]+$/.test(arg) ? arg : quote(arg)))];
  return spawn(line.join(' '), { ...options, shell: true });
}

function claudeCommand({ prompt, model, effort, appendPrompt, name, director, fullPermissions, mcpConfig }) {
  const parts = ['claude'];
  // Both flags take lists, so they go first: the next "--" flag ends each list.
  if (mcpConfig) parts.push('--mcp-config', quote(mcpConfig), '--allowedTools', AGENT_TOOLS);
  parts.push('--model', quote(model || MINIMUM_MODEL));
  parts.push('--effort', quote(effort || 'medium'));
  if (appendPrompt) parts.push('--append-system-prompt', quote(appendPrompt));
  if (name) parts.push('-n', quote(name));
  // The Director always runs unattended. Regular agents run unattended too
  // unless the user turns "Full permissions" off in Settings.
  if (director || fullPermissions) {
    parts.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions');
  }
  if (prompt) parts.push(quote(prompt));
  return parts.join(' ');
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* ------------------------------------------------------------------ *
 * Terminal (PTY) bridge
 * ------------------------------------------------------------------ */

ipcMain.on('clipboard:read', (event) => {
  event.returnValue = clipboard.readText();
});

ipcMain.on('clipboard:write', (event, text) => {
  clipboard.writeText(String(text ?? ''));
  event.returnValue = true;
});

ipcMain.handle('pty:create', (_event, options = {}) => {
  const id = `pty_${++terminalSeq}`;
  const shellInfo = resolveShell();
  const cwd = options.cwd && fs.existsSync(options.cwd) ? options.cwd : defaultWorkspace();
  const cols = Math.max(20, Math.floor(options.cols) || 80);
  const rows = Math.max(6, Math.floor(options.rows) || 24);

  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
  };

  let launch = null;

  if (options.command === 'claude' && !NO_CLAUDE) {
    launch = claudeCommand({
      model: normalizeModel(options.model),
      effort: normalizeEffort(options.effort),
      appendPrompt: agentAppendPrompt(options.appendPrompt, Boolean(options.nodeId)),
      name: options.name || undefined,
      prompt: options.prompt ? String(options.prompt) : '',
      fullPermissions: options.fullPermissions !== false,
      mcpConfig: options.nodeId ? writeAgentMcpConfig(options.nodeId, Boolean(options.team)) : null,
    });
  }

  const proc = pty.spawn(shellInfo.file, shellInfo.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });

  terminals.set(id, proc);
  proc.onData((data) => queueOutput(id, data));
  proc.onExit(({ exitCode }) => {
    flushOutput(id);
    terminals.delete(id);
    send('pty:exit', { id, exitCode });
  });

  if (launch) {
    setTimeout(() => {
      try {
        proc.write(`${launch}\r`);
      } catch {
        /* terminal already gone */
      }
    }, 450);
  }

  return { id, shell: shellInfo.label, cwd };
});

// Fire-and-forget: keystrokes must not wait for an IPC round-trip.
ipcMain.on('pty:write', (_event, { id, data } = {}) => {
  const proc = terminals.get(id);
  if (!proc) return;
  try {
    proc.write(data);
  } catch {
    /* ignore */
  }
});

ipcMain.on('pty:resize', (_event, { id, cols, rows } = {}) => {
  const proc = terminals.get(id);
  if (!proc) return;
  try {
    proc.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
  } catch {
    /* ignore */
  }
});

ipcMain.handle('pty:kill', (_event, { id } = {}) => {
  const proc = terminals.get(id);
  if (proc) {
    flushOutput(id);
    terminals.delete(id);
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
  return true;
});

/* ------------------------------------------------------------------ *
 * Voice dictation (offline, Windows Speech)
 * ------------------------------------------------------------------ */

const VOICE_SCRIPT = path.join(ROOT, 'scripts', 'dictate.ps1');
const SPEECH_SOURCE = path.join(ROOT, 'scripts', 'xode-speech.cs');

/**
 * Build the dictation helper (scripts/xode-speech.cs) with the C# compiler
 * that ships with Windows, once per version of the source. It drives Windows'
 * own speech engine with no Windows UI. Resolves to the .exe, or null when it
 * cannot be built (then the PowerShell engine is used).
 */
function speechHelper() {
  return new Promise((resolve) => {
    try {
      const source = fs.readFileSync(SPEECH_SOURCE);
      const hash = require('node:crypto').createHash('sha1').update(source).digest('hex').slice(0, 10);
      const out = path.join(userDataDir(), 'bin', `xode-speech-${hash}.exe`);
      if (fs.existsSync(out)) {
        resolve(out);
        return;
      }
      const windir = process.env.WINDIR || 'C:\Windows';
      const fw = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
      const meta = path.join(windir, 'System32', 'WinMetadata');
      const csc = path.join(fw, 'csc.exe');
      if (!fs.existsSync(csc)) {
        resolve(null);
        return;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      execFile(
        csc,
        [
          '-nologo',
          '-optimize',
          '-nowarn:1701',
          `-out:${out}`,
          `-r:${path.join(meta, 'Windows.Foundation.winmd')}`,
          `-r:${path.join(meta, 'Windows.Media.winmd')}`,
          `-r:${path.join(meta, 'Windows.Globalization.winmd')}`,
          `-r:${path.join(fw, 'System.Runtime.dll')}`,
          `-r:${path.join(fw, 'System.Runtime.InteropServices.WindowsRuntime.dll')}`,
          SPEECH_SOURCE,
        ],
        { windowsHide: true, timeout: 60000 },
        (error, stdout) => {
          if (error || !fs.existsSync(out)) {
            console.warn('[voice] could not build the dictation helper', String(stdout || error).slice(0, 400));
            resolve(null);
          } else {
            resolve(out);
          }
        }
      );
    } catch {
      resolve(null);
    }
  });
}
/** @type {import('node:child_process').ChildProcess | null} */
let voiceProc = null;
let voiceStopping = false;

function stopVoice() {
  if (!voiceProc) return;
  voiceStopping = true;
  const proc = voiceProc;
  voiceProc = null;
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
}

ipcMain.handle('voice:start', async () => {
  const helper = process.platform === 'win32' ? await speechHelper() : null;
  return startVoice(helper);
});

/**
 * Start dictation: the helper when it is available, otherwise the PowerShell
 * engine. Both print READY, then text lines; the helper also prints live
 * PARTIAL lines while you speak.
 */
function startVoice(helper) {
  return new Promise((resolve) => {
      if (voiceProc) {
        resolve({ ok: true });
        return;
      }
      if (process.platform !== 'win32') {
        resolve({ ok: false, error: 'Dictation currently uses the Windows speech engine.' });
        return;
      }
      if (!helper && !fs.existsSync(VOICE_SCRIPT)) {
        resolve({ ok: false, error: 'The dictation script is missing.' });
        return;
      }

      const powershell = existsInPath('powershell') || 'powershell.exe';
      let proc;
      try {
        proc = helper
          ? spawn(helper, [], { windowsHide: true })
          : spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VOICE_SCRIPT], {
              windowsHide: true,
            });
      } catch (error) {
        resolve({ ok: false, error: error.message });
        return;
      }

      voiceProc = proc;
      voiceStopping = false;
      let settled = false;
      let stdout = '';
      let stderr = '';
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        stdout += chunk;
        let index;
        while ((index = stdout.indexOf('\n')) !== -1) {
          const line = stdout.slice(0, index).replace(/\r$/, '').trim();
          stdout = stdout.slice(index + 1);
          if (!line) continue;
          const [kind, ...rest] = line.split('	');
          const text = rest.join('	');
          if (kind === 'READY') {
            send('voice:state', 'listening');
            settle({ ok: true });
          } else if (kind === 'PARTIAL') {
            send('voice:partial', text);
          } else if (kind === 'FINAL') {
            send('voice:text', text);
          } else if (kind === 'ERROR') {
            stderr += text;
          } else {
            send('voice:text', line);
          }
        }
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => {
        stderr += chunk;
      });

      proc.on('error', (error) => {
        if (voiceProc === proc) voiceProc = null;
        settle({ ok: false, error: error.message });
        send('voice:state', 'error');
      });

      proc.on('exit', (code) => {
        if (voiceProc === proc) voiceProc = null;
        const intentional = voiceStopping;
        voiceStopping = false;
        if (!settled) {
          settle({ ok: false, error: stderr.trim() || 'The speech engine could not start.' });
        }
        send('voice:state', intentional || code === 0 ? 'stopped' : 'error');
      });

      setTimeout(() => {
        if (settled) return;
        stopVoice();
        settle({ ok: false, error: 'The speech engine did not respond.' });
      }, 8000);
  });
}

/**
 * Windows voice typing (Win+H): the system dictation panel types into the
 * focused prompt box. The window must have focus for the keystroke to land.
 */
ipcMain.handle('voice:typing', async () => {
  if (process.platform !== 'win32') return { ok: false, error: 'Voice typing needs Windows.' };
  const script = path.join(ROOT, 'scripts', 'voicetyping.ps1');
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  const powershell = existsInPath('powershell') || 'powershell.exe';
  return new Promise((resolve) => {
    const proc = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', (error) => resolve({ ok: false, error: error.message }));
    proc.on('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || 'Win+H failed' }));
  });
});

ipcMain.handle('voice:stop', () => {
  stopVoice();
  send('voice:state', 'stopped');
  return true;
});

/**
 * Reload the renderer from disk, tearing down PTYs and dictation first so the
 * fresh window does not orphan them. Used by F5 and the File ▸ Reload menu.
 */
function reloadApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  for (const id of [...terminals.keys()]) flushOutput(id);
  for (const proc of terminals.values()) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
  terminals.clear();
  stopVoice();
  stopDirector();
  mainWindow.webContents.reloadIgnoringCache();
}

ipcMain.on('win:reload', reloadApp);

/* ------------------------------------------------------------------ *
 * Headless Claude — shared stream-json parsing
 * ------------------------------------------------------------------ */

/** Short, human description of a tool call for the chat transcripts. */
function describeTool(block) {
  const name = String(block.name || 'tool').replace(/^mcp__xode__/, '');
  const input = block.input || {};
  if (name === 'run' && Array.isArray(input.actions)) {
    return {
      name,
      detail: input.actions
        .map((action) => {
          const target =
            action.url || action.node || action.agent || action.mode || action.kind || action.name || '';
          return target ? `${action.op} ${String(target).slice(0, 60)}` : String(action.op);
        })
        .join(' · '),
    };
  }
  const detail =
    input.command || input.file_path || input.path || input.pattern || input.url || input.description || '';
  return { name, detail: String(detail).replace(/\s+/g, ' ').slice(0, 140) };
}

/** Copy a tool's input for the UI, trimming huge strings (file bodies, diffs). */
function compactInput(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > 6000 ? `${value.slice(0, 6000)}\n… (${value.length - 6000} more characters)` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => compactInput(item, depth + 1));
  if (value && typeof value === 'object' && depth < 4) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = compactInput(item, depth + 1);
    return out;
  }
  return value;
}

function toolResultText(content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === 'text' ? part.text || '' : part.type === 'image' ? '[image]' : ''))
      .join('\n');
  }
  return String(content ?? '');
}

/** Turn one stream-json line into zero or more UI events. */
function parseClaudeLine(line, emit) {
  let json;
  try {
    json = JSON.parse(line);
  } catch {
    return;
  }
  if (json.type === 'system' && json.subtype === 'init') {
    emit({ type: 'init', sessionId: json.session_id, model: json.model });
    return;
  }
  if (json.type === 'assistant' && json.message) {
    for (const block of json.message.content || []) {
      if (block.type === 'text' && block.text) emit({ type: 'assistant', text: block.text });
      else if (block.type === 'tool_use') {
        emit({ type: 'tool', id: block.id, tool: block.name, input: compactInput(block.input || {}), ...describeTool(block) });
      }
    }
    return;
  }
  if (json.type === 'user' && json.message && Array.isArray(json.message.content)) {
    for (const block of json.message.content) {
      if (block.type !== 'tool_result') continue;
      const text = toolResultText(block.content);
      emit({
        type: 'tool-result',
        id: block.tool_use_id,
        isError: Boolean(block.is_error),
        // Enough to show and expand; total line count kept for the summary.
        text: text.length > 20000 ? text.slice(0, 20000) : text,
        lines: text ? text.split('\n').length : 0,
      });
      if (block.is_error) emit({ type: 'tool-error', text: text.replace(/\s+/g, ' ').slice(0, 300) });
    }
    return;
  }
  if (json.type === 'result') {
    emit({
      type: 'result',
      ok: !json.is_error,
      result: json.result,
      costUsd: json.total_cost_usd,
      durationMs: json.duration_ms,
    });
  }
}

function pipeLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  });
}

/* ------------------------------------------------------------------ *
 * The Director — a persistent headless Claude session
 *
 * One long-lived `claude -p --input-format stream-json` process. Each prompt
 * is written to stdin as a user message and the reply streams back as JSON,
 * so there is no TUI to scrape, no idle guessing and no start-up cost per
 * request. Its only tools are `canvas` and `run` (bin/xode-mcp.js).
 * ------------------------------------------------------------------ */

let directorProc = null;
let directorOptions = {};

function directorEvent(event) {
  send('director:event', event);
}

function writeDirectorMcpConfig() {
  const config = {
    mcpServers: {
      xode: {
        // Electron's own binary runs plain Node scripts, so `node` need not be installed.
        command: process.execPath,
        args: [MCP_PATH],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          XODE_CONTROL_URL: control.url || '',
          XODE_CONTROL_TOKEN: control.token,
        },
      },
    },
  };
  fs.writeFileSync(directorMcpFile(), JSON.stringify(config, null, 2), 'utf8');
}

/** An agent's extra system prompt: its own (or the fleet default) plus the tools hint. */
function agentAppendPrompt(appendPrompt, withTools) {
  const base = String(
    appendPrompt ||
      `You are one agent in a coordinated fleet. Read and follow the shared fleet context at ${contextFile()} before you begin.`
  );
  return withTools ? `${base}

${AGENT_TOOLS_HINT}` : base;
}

/**
 * MCP config for one Claude agent: the same server in "agent" mode, holding a
 * token that identifies this window, so the app knows who is asking and can
 * check ownership and rank. Team members also get the team tools.
 */
function writeAgentMcpConfig(nodeId, team = false) {
  const file = path.join(agentsDir(), `${String(nodeId).replace(/[^\w-]/g, '') || 'agent'}-mcp.json`);
  const config = {
    mcpServers: {
      xode: {
        command: process.execPath,
        args: [MCP_PATH],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          XODE_MCP_MODE: 'agent',
          XODE_MCP_TEAM: team ? '1' : '0',
          XODE_CONTROL_URL: control.url || '',
          XODE_CONTROL_TOKEN: control.agentToken(nodeId),
        },
      },
    },
  };
  try {
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
    return file;
  } catch {
    return null;
  }
}

function stopDirector() {
  const proc = directorProc;
  directorProc = null;
  if (!proc) return;
  try {
    proc.stdin.end();
  } catch {
    /* ignore */
  }
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
}

function startDirector(options = {}) {
  stopDirector();
  directorOptions = { ...directorOptions, ...options };
  try {
    fs.writeFileSync(directorFile(), directorInstructions(), 'utf8');
    writeDirectorMcpConfig();
  } catch (error) {
    directorEvent({ type: 'error', message: `could not write Director files: ${error.message}` });
  }

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', normalizeModel(directorOptions.model || DIRECTOR_MODEL),
    '--effort', normalizeEffort(directorOptions.effort || DIRECTOR_EFFORT),
    '--system-prompt-file', directorFile(),
    '--mcp-config', directorMcpFile(),
    '--strict-mcp-config',
    // No built-in tools at all: the Director only has `canvas` and `run`.
    '--tools', '',
    '--allowedTools', 'mcp__xode__canvas,mcp__xode__run',
    '--disable-slash-commands',
    // Skip the user's plugins and hooks; they are for coding sessions.
    '--setting-sources', 'project',
    '--no-session-persistence',
  ];

  let proc;
  try {
    proc = spawnClaudeProcess(args, {
      // userData has no CLAUDE.md or project settings to load.
      cwd: userDataDir(),
      env: { ...process.env, FORCE_COLOR: '0' },
    });
  } catch (error) {
    directorEvent({ type: 'dead', message: error.message });
    return { error: error.message };
  }

  directorProc = proc;
  let stderr = '';
  pipeLines(proc.stdout, (line) => {
    if (directorProc === proc) parseClaudeLine(line, directorEvent);
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  proc.on('error', (error) => {
    if (directorProc === proc) directorEvent({ type: 'dead', message: error.message });
  });
  proc.on('close', (code) => {
    if (directorProc !== proc) return;
    directorProc = null;
    directorEvent({ type: 'dead', code, message: stderr.trim().slice(-300) });
  });
  proc.stdin.on('error', () => {});

  directorEvent({ type: 'ready' });
  return { started: true };
}

ipcMain.handle('director:start', (_event, options = {}) =>
  NO_CLAUDE ? { error: 'Claude is disabled for this test run' } : startDirector(options)
);

ipcMain.handle('director:send', (_event, { text } = {}) => {
  const message = String(text || '').trim();
  if (!message) return { error: 'empty message' };
  if (!directorProc) {
    const started = startDirector();
    if (started.error) return started;
  }
  try {
    directorProc.stdin.write(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: message } })}\n`
    );
    return { sent: true };
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('director:stop', () => {
  stopDirector();
  return true;
});

/* ------------------------------------------------------------------ *
 * Claude GUI mode — headless streaming chat
 * ------------------------------------------------------------------ */

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const chatProcs = new Map();

function chatEvent(nodeId, event) {
  send('claude:event', { nodeId, ...event });
}

ipcMain.handle('claude:send', (_event, options = {}) => {
  if (NO_CLAUDE) return { error: 'Claude is disabled for this test run' };
  const nodeId = String(options.nodeId || '');
  if (!nodeId) return { error: 'missing nodeId' };

  const existing = chatProcs.get(nodeId);
  if (existing) {
    try {
      existing.kill();
    } catch {
      /* ignore */
    }
    chatProcs.delete(nodeId);
  }

  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  const agentMcp = writeAgentMcpConfig(nodeId, Boolean(options.team));
  if (agentMcp) args.push('--mcp-config', agentMcp, '--allowedTools', AGENT_TOOLS);
  args.push('--model', normalizeModel(options.model));
  args.push('--effort', normalizeEffort(options.effort));
  args.push(
    '--append-system-prompt',
    agentAppendPrompt(options.appendPrompt, Boolean(agentMcp))
  );
  // Print mode cannot answer a permission prompt, so tools would be denied.
  // Bypass unless the user has turned full permissions off.
  if (options.fullPermissions !== false) {
    args.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions');
  }
  const sessionId = String(options.sessionId || '').trim();
  if (sessionId) args.push('--resume', sessionId);

  const cwd = options.cwd && fs.existsSync(options.cwd) ? options.cwd : defaultWorkspace();

  let proc;
  try {
    proc = spawnClaudeProcess(args, {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '0' },
    });
  } catch (error) {
    chatEvent(nodeId, { type: 'error', message: error.message });
    return { error: error.message };
  }

  chatProcs.set(nodeId, proc);

  let stderr = '';
  pipeLines(proc.stdout, (line) => parseClaudeLine(line, (event) => chatEvent(nodeId, event)));
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  proc.on('error', (error) => chatEvent(nodeId, { type: 'error', message: error.message }));
  proc.on('close', (code) => {
    if (chatProcs.get(nodeId) === proc) chatProcs.delete(nodeId);
    if (code !== 0 && code !== null && stderr.trim()) {
      chatEvent(nodeId, { type: 'error', message: stderr.trim().slice(0, 300) });
    }
    chatEvent(nodeId, { type: 'exit', code });
  });

  try {
    proc.stdin.on('error', () => {});
    proc.stdin.write(`${String(options.message || '')}\n`);
    proc.stdin.end();
  } catch {
    /* ignore */
  }

  return { started: true };
});

ipcMain.on('claude:cancel', (_event, { nodeId } = {}) => {
  const id = String(nodeId || '');
  const proc = chatProcs.get(id);
  if (proc) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    chatProcs.delete(id);
  }
});

/* ------------------------------------------------------------------ *
 * Saved chats — one JSON file per conversation in userData/chats
 * ------------------------------------------------------------------ */

ipcMain.handle('chat:save', (_event, chat = {}) => {
  const id = String(chat.id || '');
  if (!id) return false;
  try {
    fs.mkdirSync(chatsDir(), { recursive: true });
    fs.writeFileSync(chatFile(id), JSON.stringify({ ...chat, updatedAt: Date.now() }), 'utf8');
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('chat:load', (_event, id) => {
  try {
    const chat = JSON.parse(fs.readFileSync(chatFile(id), 'utf8'));
    // Only ever hand a window its own conversation.
    return chat && chat.id === id ? chat : null;
  } catch {
    return null;
  }
});

ipcMain.handle('chat:list', () => {
  try {
    return fs
      .readdirSync(chatsDir())
      .filter((name) => name.endsWith('.json') && name !== 'director.json')
      .map((name) => {
        try {
          const chat = JSON.parse(fs.readFileSync(path.join(chatsDir(), name), 'utf8'));
          // Skip files shared by several chats under the old file naming.
          if (name !== `${chat.id}.json`) return null;
          const messages = Array.isArray(chat.messages) ? chat.messages : [];
          const first = messages.find((message) => message.role === 'user');
          if (!first) return null;
          return {
            id: chat.id,
            title: chat.title || String(first.text || '').slice(0, 60) || 'Chat',
            updatedAt: chat.updatedAt || 0,
            count: messages.length,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 40);
  } catch {
    return [];
  }
});

ipcMain.handle('chat:delete', (_event, id) => {
  try {
    fs.unlinkSync(chatFile(id));
    return true;
  } catch {
    return false;
  }
});


/* ------------------------------------------------------------------ *
 * Music — internet radio search (Radio Browser API, no key)
 * ------------------------------------------------------------------ */

ipcMain.handle('radio:search', async (_event, { query = '', limit = 30 } = {}) => {
  const q = String(query || '').trim();
  const capped = Math.max(1, Math.min(60, Number(limit) || 30));
  const params = new URLSearchParams({
    limit: String(capped),
    hidebroken: 'true',
    order: 'votes',
    reverse: 'true',
  });
  if (q) params.set('name', q);

  try {
    const response = await net.fetch(
      `https://de1.api.radio-browser.info/json/stations/search?${params.toString()}`,
      { headers: { 'User-Agent': 'XodeCode/0.1' } }
    );
    if (!response.ok) return { error: `radio api ${response.status}` };
    const list = await response.json();
    return {
      stations: (Array.isArray(list) ? list : [])
        .map((station) => ({
          name: String(station.name || '').trim(),
          url: station.url_resolved || station.url || '',
          country: station.country || '',
          codec: station.codec || '',
          bitrate: Number(station.bitrate) || 0,
        }))
        .filter((station) => /^https?:/i.test(station.url)),
    };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
});

/* ------------------------------------------------------------------ *
 * Control bridge + shared context
 * ------------------------------------------------------------------ */

ipcMain.on('control:response', (_event, payload) => control.respond(payload));

ipcMain.handle('context:read', () => {
  try {
    return fs.readFileSync(contextFile(), 'utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('context:sync', (_event, content) => {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(contextFile(), String(content ?? ''), 'utf8');
    return true;
  } catch (error) {
    return false;
  }
});

/* ------------------------------------------------------------------ *
 * JointedAgents — shared context files for jointed teams
 * ------------------------------------------------------------------ */

ipcMain.handle('joint:create', (_event, { id, name } = {}) => {
  try {
    fs.mkdirSync(jointsDir(), { recursive: true });
    const file = jointContextFile(id);
    if (!fs.existsSync(file)) fs.writeFileSync(file, jointTemplate(name || id), 'utf8');
    return { id, name, path: file };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
});

ipcMain.handle('joint:read', (_event, id) => {
  try {
    return fs.readFileSync(jointContextFile(id), 'utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('joint:write', (_event, { id, content } = {}) => {
  try {
    fs.mkdirSync(jointsDir(), { recursive: true });
    fs.writeFileSync(jointContextFile(id), String(content ?? ''), 'utf8');
    return true;
  } catch {
    return false;
  }
});

/* ------------------------------------------------------------------ *
 * Window + system
 * ------------------------------------------------------------------ */

ipcMain.handle('win:minimize', () => mainWindow?.minimize());

ipcMain.handle('win:toggle-maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});

ipcMain.handle('win:close', () => mainWindow?.close());

// Snapshot part of the window (a canvas window about to be parked in the dock).
ipcMain.handle('win:capture', async (_event, rect = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const [width, height] = mainWindow.getContentSize();
  const x = Math.max(0, Math.floor(rect.x || 0));
  const y = Math.max(0, Math.floor(rect.y || 0));
  const w = Math.min(width - x, Math.ceil(rect.width || 0));
  const h = Math.min(height - y, Math.ceil(rect.height || 0));
  if (w < 8 || h < 8) return null;
  try {
    const image = await mainWindow.webContents.capturePage({ x, y, width: w, height: h });
    const size = image.getSize();
    const maxWidth = Math.max(120, Math.floor(rect.maxWidth || 520));
    const scaled = size.width > maxWidth ? image.resize({ width: maxWidth, quality: 'good' }) : image;
    return `data:image/jpeg;base64,${scaled.toJPEG(90).toString('base64')}`;
  } catch {
    return null;
  }
});

/**
 * Screenshot of one browser window's page for an agent, straight from its
 * webContents, so it works even when the window is covered or off screen.
 */
ipcMain.handle('web:capture', async (_event, { id, maxWidth = 1280 } = {}) => {
  const contents = webContents.fromId(Number(id));
  if (!contents || contents.isDestroyed()) return { error: 'that browser is gone' };
  try {
    // A guest page that has not painted recently can leave capturePage
    // hanging; ask for a frame and give up after a few seconds.
    contents.invalidate();
    const image = await Promise.race([
      contents.capturePage(),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    if (!image) return { error: 'capture timed out' };
    if (image.isEmpty()) return { error: 'the page has not painted yet' };
    const size = image.getSize();
    const scaled = size.width > maxWidth ? image.resize({ width: maxWidth, quality: 'good' }) : image;
    const out = scaled.getSize();
    return { data: scaled.toJPEG(72).toString('base64'), mime: 'image/jpeg', width: out.width, height: out.height };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
});

/**
 * First-run setup: is Claude Code installed, and is anyone signed in?
 * Uses `claude auth status` (JSON); never sends anything anywhere.
 */
ipcMain.handle(
  'claude:auth-status',
  () =>
    new Promise((resolve) => {
      let proc;
      try {
        proc = spawnClaudeProcess(['auth', 'status'], { cwd: defaultWorkspace(), env: process.env });
      } catch {
        resolve({ installed: false, loggedIn: false });
        return;
      }
      let out = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => (out += chunk));
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        resolve({ installed: true, loggedIn: false });
      }, 15000);
      proc.on('error', () => {
        clearTimeout(timer);
        resolve({ installed: false, loggedIn: false });
      });
      proc.on('exit', () => {
        clearTimeout(timer);
        try {
          const status = JSON.parse(out.slice(out.indexOf('{')));
          resolve({ installed: true, loggedIn: Boolean(status.loggedIn), method: status.authMethod || '' });
        } catch {
          resolve({ installed: true, loggedIn: false });
        }
      });
    })
);

/**
 * Open a console window that signs in to Claude or installs Claude Code, so
 * the user sees (and answers) the real prompts. Only these fixed commands.
 */
const SETUP_COMMANDS = {
  login: 'claude auth login',
  install: 'npm install -g @anthropic-ai/claude-code',
};
ipcMain.handle('claude:setup-console', (_event, { action } = {}) => {
  const command = SETUP_COMMANDS[action];
  if (!command) return { ok: false, error: 'unknown setup action' };
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'XodeCodeSetup', 'cmd', '/k', command], {
        detached: true,
        windowsHide: false,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell application "Terminal" to do script "${command}"`], { detached: true }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', `bash -lc '${command}; exec bash'`], { detached: true }).unref();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('sys:info', () => ({
  platform: process.platform,
  shell: resolveShell().label,
  home: defaultWorkspace(),
  claude: Boolean(existsInPath('claude')),
  version: app.getVersion(),
  paths: {
    userData: userDataDir(),
    context: contextFile(),
    director: directorFile(),
    cli: CLI_PATH,
  },
  models: {
    director: DIRECTOR_MODEL,
    minimum: MINIMUM_MODEL,
    allowed: [...ALLOWED_MODELS],
    efforts: [...EFFORTS],
  },
}));

ipcMain.handle('dialog:pick-folder', async (_event, startPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a workspace folder',
    defaultPath: startPath || defaultWorkspace(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:pick-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Place an image',
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;

  const file = result.filePaths[0];
  const stat = fs.statSync(file);
  if (stat.size > 8 * 1024 * 1024) throw new Error('Image is larger than 8 MB');

  const ext = path.extname(file).slice(1).toLowerCase();
  const mime =
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
    }[ext] || 'application/octet-stream';

  return {
    name: path.basename(file),
    dataUrl: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`,
  };
});

ipcMain.handle('sys:open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) shell.openExternal(url);
  return true;
});

const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
};

// Read an image from disk into a data URL (used by the Director to place images).
ipcMain.handle('sys:read-image', (_event, filePath) => {
  const full = path.resolve(String(filePath || ''));
  const ext = path.extname(full).slice(1).toLowerCase();
  if (!IMAGE_MIME[ext]) throw new Error(`not a supported image: ${ext || '(no extension)'}`);
  const stat = fs.statSync(full);
  if (stat.size > 16 * 1024 * 1024) throw new Error('image is larger than 16 MB');
  return {
    name: path.basename(full),
    dataUrl: `data:${IMAGE_MIME[ext]};base64,${fs.readFileSync(full).toString('base64')}`,
  };
});

/* ------------------------------------------------------------------ *
 * App lifecycle
 * ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#08080a',
    title: 'XodeCode',
    icon: path.join(ROOT, 'assets', 'xodecode.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.removeMenu();
  // Test runs open without stealing focus from whatever the user is doing.
  mainWindow.once('ready-to-show', () => (NO_CLAUDE ? mainWindow.showInactive() : mainWindow.show()));

  // Dev convenience: F5 reloads the renderer from disk (ignoring cache) so
  // edited HTML/CSS/JS takes effect.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F5') return;
    event.preventDefault();
    reloadApp();
  });

  mainWindow.webContents.on('console-message', (event, level, message, sourceId) => {
    const text =
      typeof event === 'object' && event !== null && 'message' in event ? event.message : message;
    const where =
      typeof event === 'object' && event !== null && 'sourceId' in event ? event.sourceId : sourceId;
    console.log(`[renderer] ${text}${where ? ` (${where})` : ''}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone:', details);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
  });

  // In-app browser: keep guests locked down and make target=_blank links load
  // in the same webview instead of spawning windows or the system browser.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) guest.loadURL(url);
      return { action: 'deny' };
    });
  });

  mainWindow.on('maximize', () => send('win:maximized', true));
  mainWindow.on('unmaximize', () => send('win:maximized', false));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`${SCHEME}://${HOST}/src/renderer/index.html`);

  if (process.env.XODECODE_TEAMTEST) {
    const { runTeamTest, runAgentToolTest } = require('./teamtest');
    const { runStressTest } = require('./stresstest');
    const { runOnboardTest } = require('./onboardtest');
    const kind = process.env.XODECODE_TEST_KIND;
    const runTest =
      kind === 'agent' ? runAgentToolTest : kind === 'stress' ? runStressTest : kind === 'onboard' ? runOnboardTest : runTeamTest;
    mainWindow.webContents.once('did-finish-load', () => {
      runTest(mainWindow, { url: control.url, token: control.token, agentToken: control.agentToken }).catch((error) => {
        console.log(`TEAMTEST_FAIL ${error && error.message}`);
        app.quit();
      });
    });
  }

  if (process.env.XODECODE_SMOKE) {
    const { runSmoke } = require('./smoke');
    mainWindow.webContents.once('did-finish-load', () => {
      runSmoke(mainWindow, process.env.XODECODE_SMOKE, {
        url: control.url,
        token: control.token,
        ptyCount: () => terminals.size,
        // Test hook: lets the smoke run inspect the command an agent would get.
        claudeCommand,
      }).catch((error) => {
        console.error(`SMOKE_FAIL ${error && error.message}`);
        app.quit();
      });
    });
  }
}

app.whenReady().then(async () => {
  protocol.handle(SCHEME, serveProjectFile);
  ensureSupportFiles();
  try {
    await control.start();
  } catch (error) {
    // The window is still usable without the Director bridge.
    console.error('[control] failed to start:', error);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  control.stop();
  stopVoice();
  stopDirector();
  for (const proc of chatProcs.values()) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
  for (const id of [...terminals.keys()]) flushOutput(id);
  for (const proc of terminals.values()) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
  terminals.clear();
  if (process.platform !== 'darwin') app.quit();
});
