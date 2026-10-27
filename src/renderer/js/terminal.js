import { Terminal } from '../../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebLinksAddon } from '../../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';
import { WebglAddon } from '../../../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';

import { el, stripAnsi, truncate, pickUnused } from './util.js';
import { store, CALL_SIGNS } from './store.js';
import { buildNodeChrome, statusClass } from './node-chrome.js';
import { registerNodeType } from './canvas.js';
import { contentScaleFor } from './layout.js';
import { createChatView } from './claudechat.js';

const CLI_LABEL = { claude: 'Claude Code', shell: 'Terminal' };

/** Extra system prompt for a JointedAgents team member. */
function jointAppendPrompt(meta) {
  return [
    `You are one member of a jointed team ("${meta.jointName || meta.joint}") — several agents`,
    'working on different parts of the same task in the same folder.',
    `The team shares one brief at ${meta.jointContextPath}. Read and follow it before you begin,`,
    'and keep it current (append decisions, the files you own, interfaces, open questions) so',
    'teammates do not duplicate work or collide. Stay in your lane and do not edit files another',
    'member owns.',
  ].join(' ');
}

/**
 * Terminal glyphs are rasterised into a canvas, so scaling that canvas with
 * the canvas zoom (a CSS transform) upscales a fixed bitmap and the text goes
 * soft. Instead, every terminal renders at `fontSize * zoom` into a host that
 * is inverse-scaled by `1 / zoom`, which nets out to the same on-screen size
 * while keeping the glyph bitmap at the zoomed resolution.
 */
const BASE_FONT_SIZE = 12.5;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const ZOOM_COMMIT_MS = 90;
/**
 * Supersample the terminal bitmap: render at `zoom * RENDER_SCALE` and
 * inverse-scale back down, so text stays the same on-screen size but is drawn
 * with more pixels (crisper). Clamped so huge canvases stay reasonable.
 */
const RENDER_SCALE = 1.5;
const MAX_RENDER_SCALE = 6;
let zoomCommitSeq = 0;

const NEEDS_PATTERNS = [
  /do you want to (proceed|make this edit|create|run|apply|continue)/i,
  /allow this (tool|command|action)/i,
  /❯\s*1\.\s*(yes|allow)/i,
  /\[y\/n\]|\(y\/n\)/i,
  /press enter to (continue|confirm)/i,
];

const WORKING_PATTERNS = [/esc to interrupt/i, /thinking…/i, /running…/i];

const THEME = {
  background: 'rgba(0, 0, 0, 0)',
  foreground: '#dcdce2',
  cursor: '#d0d0d0',
  cursorAccent: '#141414',
  selectionBackground: 'rgba(255, 255, 255, 0.22)',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.12)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.22)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.3)',
  black: '#2a2a31',
  red: '#e06c75',
  green: '#4fc99b',
  yellow: '#e6a53c',
  blue: '#6ea8f7',
  magenta: '#a98bf5',
  cyan: '#56b6c2',
  white: '#dcdce2',
  brightBlack: '#5b5b64',
  brightRed: '#ff8a8a',
  brightGreen: '#6fe0b6',
  brightYellow: '#f2c069',
  brightBlue: '#94bdf9',
  brightMagenta: '#c3aef8',
  brightCyan: '#7fd4de',
  brightWhite: '#f4f4f7',
};

/* ------------------------------------------------------------------ *
 * PTY routing
 * ------------------------------------------------------------------ */

const routes = new Map();
const sessions = new Map();
let wired = false;

/** Type a line into a live session, the same way the user would. */
export function writeToNode(nodeId, text) {
  const session = sessions.get(nodeId);
  if (!session) return false;
  session.write(text);
  return true;
}

export function hasSession(nodeId) {
  return sessions.has(nodeId);
}

function ensureWired() {
  if (wired) return;
  wired = true;
  window.api.pty.onData(({ id, data }) => routes.get(id)?.onData(data));
  window.api.pty.onExit(({ id, exitCode }) => routes.get(id)?.onExit(exitCode));
}

/* ------------------------------------------------------------------ *
 * Node view
 * ------------------------------------------------------------------ */

function createTerminalView(meta, canvas) {
  // Claude GUI mode renders a chat instead of an xterm.
  if (meta.cli === 'claude' && store.state.settings.guiTerminals) {
    return createChatView(meta, canvas, {
      // Lets the Director prompt this chat exactly like a terminal agent.
      session: {
        set: (session) => sessions.set(meta.id, session),
        clear: () => sessions.delete(meta.id),
      },
      appendPrompt: meta.joint ? jointAppendPrompt(meta) : undefined,
    });
  }

  ensureWired();

  const isClaude = meta.cli === 'claude';
  const chrome = buildNodeChrome(meta, {
    brand: isClaude ? 'claude' : 'shell',
    iconName: isClaude ? 'claude' : 'shell',
    actions: [
      { icon: 'x', title: 'Close terminal', danger: true, onClick: () => canvas.closeNode(meta.id) },
    ],
  });
  chrome.titleEl.textContent = meta.callSign;
  chrome.subEl.textContent = meta.title || CLI_LABEL[meta.cli] || 'Terminal';

  const host = el('div', { class: 'xterm-host' });
  chrome.body.append(host);

  /* ---- zoom compensation ---- */
  let zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, store.page.viewport?.scale || 1));
  let zoomTimer = null;
  // Font grows and shrinks with the window (see contentScaleFor).
  let contentScale = contentScaleFor(meta);

  function renderScale() {
    return Math.min(MAX_RENDER_SCALE, Math.max(MIN_ZOOM, zoom) * RENDER_SCALE);
  }

  function applyHostSize() {
    const w = Math.max(1, meta.w);
    const h = Math.max(1, meta.h);
    const s = renderScale();
    host.style.width = `${w * s}px`;
    host.style.height = `${h * s}px`;
    host.style.transformOrigin = '0 0';
    host.style.transform = `scale(${1 / s})`;
  }

  const term = new Terminal({
    fontFamily:
      '"Cascadia Mono","Cascadia Code","JetBrains Mono",Consolas,"Segoe UI Symbol","SF Mono",ui-monospace,monospace',
    fontSize: BASE_FONT_SIZE,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 6000,
    allowProposedApi: true,
    allowTransparency: true,
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  try {
    term.open(host);
  } catch (error) {
    console.error('[terminal] failed to open xterm', error);
    chrome.body.append(
      el('div', { class: 'term-fallback', text: 'Could not start the terminal renderer.' })
    );
  }

  // The DOM renderer repaints every cell on the CPU, so upgrade to the GPU
  // renderer once the node is on screen. Deferring the upgrade keeps node
  // creation cheap (shader compilation is the expensive part) and does not
  // change the final render quality.
  let webgl = null;
  let webglRaf = 0;

  function attachWebgl() {
    webglRaf = 0;
    if (destroyed || webgl) return;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try {
          webgl.dispose();
        } catch {
          /* ignore */
        }
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      webgl = null;
    }
  }

  /* ---------------------------- clipboard ---------------------------- */

  function copySelection() {
    if (!term.hasSelection()) return false;
    try {
      window.api.clipboard.writeText(term.getSelection());
      term.clearSelection();
    } catch {
      return false;
    }
    return true;
  }

  function pasteClipboard() {
    try {
      const text = window.api.clipboard.readText();
      if (text) term.paste(text);
    } catch {
      /* ignore */
    }
  }

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const key = event.key.toLowerCase();

    // Windows terminal conventions.
    if (event.ctrlKey && key === 'insert') {
      event.preventDefault();
      copySelection();
      return false;
    }
    if (event.shiftKey && key === 'insert' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      pasteClipboard();
      return false;
    }

    if (!event.ctrlKey && !event.metaKey) return true;

    if (key === 'c') {
      if (term.hasSelection()) {
        event.preventDefault();
        copySelection();
        return false;
      }
      // No selection: let Ctrl+C reach the PTY as SIGINT. Cmd+C is copy.
      if (event.metaKey || event.shiftKey) {
        event.preventDefault();
        return false;
      }
      return true;
    }
    if (key === 'v') {
      event.preventDefault();
      pasteClipboard();
      return false;
    }
    return true;
  });

  /* ---- runtime state ---- */
  let ptyId = null;
  let started = false;
  let destroyed = false;
  let buffer = '';
  let pending = '';
  let analyseTimer = null;
  let sawOutput = false;
  let idleTimer = null;
  let fullPermissions = false;
  let bypassBuffer = '';
  let bypassAttempts = 0;
  let bypassCooldown = 0;

  /**
   * Bypass-permissions mode shows a one-time warning with "No, exit"
   * preselected. Nobody is watching an agent terminal, so confirm it the
   * moment it appears or the agent would sit there forever. The TUI draws with
   * cursor moves, so the stripped text has no spaces — compare against a
   * whitespace-free copy.
   */
  function acceptBypassWarning(data) {
    if (!fullPermissions || bypassAttempts >= 2) return;
    bypassBuffer = (bypassBuffer + stripAnsi(data)).slice(-1800);
    const now = Date.now();
    if (now < bypassCooldown) return;
    const compact = bypassBuffer.replace(/\s+/g, '');
    if (
      !/BypassPermissionsmode/i.test(compact) ||
      !/Yes,Iaccept/i.test(compact) ||
      !/Entertoconfirm/i.test(compact)
    ) {
      return;
    }
    bypassAttempts += 1;
    bypassCooldown = now + 4000;
    setTimeout(() => {
      if (!ptyId) return;
      // Down arrow to "Yes, I accept", then confirm.
      window.api.pty.write(ptyId, '\u001b[B');
      setTimeout(() => {
        if (ptyId) window.api.pty.write(ptyId, '\r');
      }, 300);
    }, 350);
  }

  function setStatus(status) {
    if (meta.status === status) return;
    meta.status = status;
    chrome.dotEl.className = statusClass(status);
    store.emit('status', meta);
  }

  function snippet() {
    const lines = buffer
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 1 && !/^[>❯$#%]/.test(line));
    const tail = lines.slice(-3).join(' ');
    return truncate(tail, 190) || 'Session is idle.';
  }

  /**
   * Output is painted as soon as it arrives, but status detection only runs
   * on a short frame. Claude Code emits hundreds of tiny chunks per second;
   * stripping ANSI and testing five regexes per chunk was the main renderer
   * cost while a session was busy.
   */
  function analyseOutput() {
    analyseTimer = null;
    if (destroyed) return;

    buffer = stripAnsi(pending).slice(-1600);
    pending = '';

    const tail = buffer.slice(-400);
    if (NEEDS_PATTERNS.some((re) => re.test(tail))) {
      clearTimeout(idleTimer);
      setStatus('needs');
      if (!canvas.isFocused(meta.id) || !canvas.isOnScreen(meta.id)) {
        meta.unread = true;
        store.emit('attention', {
          id: meta.id,
          kind: 'needs',
          snippet: snippet(),
          raw: buffer.slice(-400),
        });
      }
      return;
    }

    setStatus('working');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (destroyed) return;
      setStatus('idle');
      if (sawOutput && !canvas.isOnScreen(meta.id)) {
        meta.unread = true;
        store.emit('attention', {
          id: meta.id,
          kind: 'finished',
          snippet: snippet(),
          raw: buffer.slice(-400),
        });
      }
      sawOutput = false;
    }, 1700);
  }

  function handleOutput(data) {
    term.write(data);
    sawOutput = true;
    pending = (pending + data).slice(-2400);
    acceptBypassWarning(data);
    if (!analyseTimer) analyseTimer = setTimeout(analyseOutput, 70);
  }

  function startSession() {
    const cols = term.cols || 80;
    const rows = term.rows || 24;
    fullPermissions = meta.cli === 'claude' && store.state.settings.agentFullPermissions !== false;
    window.api.pty
      .create({
        cols,
        rows,
        cwd: meta.cwd || store.page?.workspace || store.state.workspace || '',
        command: meta.cli === 'claude' ? 'claude' : 'shell',
        prompt: meta.prompt || '',
        model: meta.model || undefined,
        effort: meta.effort || undefined,
        appendPrompt: meta.joint ? jointAppendPrompt(meta) : undefined,
        fullPermissions: store.state.settings.agentFullPermissions !== false,
      })
      .then((result) => {
        if (destroyed) {
          window.api.pty.kill(result.id);
          return;
        }
        ptyId = result.id;
        meta.subtitle = result.shell;
        routes.set(ptyId, { onData: handleOutput, onExit: onExit });
        sessions.set(meta.id, {
          write: (text) => {
            if (!ptyId) return;
            const clean = String(text || '')
              .replace(/\r?\n+/g, ' ')
              .trim();
            if (!clean) return;
            const id = ptyId;
            window.api.pty.write(id, clean);
            setTimeout(() => {
              if (ptyId !== id) return;
              try {
                window.api.pty.write(id, '\r');
              } catch {
                /* ignore */
              }
            }, 90);
          },
        });
      })
      .catch((error) => {
        console.error('[terminal] spawn failed', error);
        term.write(`\r\n\x1b[31mCould not start terminal: ${error.message}\x1b[0m\r\n`);
        setStatus('dead');
      });
  }

  function onExit(exitCode) {
    if (ptyId) routes.delete(ptyId);
    ptyId = null;
    clearTimeout(idleTimer);
    clearTimeout(analyseTimer);
    analyseTimer = null;
    pending = '';
    setStatus('dead');
    term.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
    term.write('\x1b[90mPress Enter to start a new session.\x1b[0m\r\n');
    restartOnEnter = true;
  }

  let restartOnEnter = false;

  term.onData((data) => {
    if (ptyId) {
      window.api.pty.write(ptyId, data);
      return;
    }
    if (restartOnEnter && (data === '\r' || data === '\n')) {
      restartOnEnter = false;
      term.reset();
      buffer = '';
      pending = '';
      clearTimeout(analyseTimer);
      analyseTimer = null;
      setStatus('idle');
      startSession();
    }
  });

  term.onResize(({ cols, rows }) => {
    if (ptyId) window.api.pty.resize(ptyId, cols, rows);
  });

  const scheduleFit = () => {
    if (destroyed) return;
    if (host.clientWidth < 60 || host.clientHeight < 40) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    if (!started) {
      started = true;
      startSession();
    }
  };

  function commitZoom() {
    zoomTimer = null;
    if (destroyed) return;
    term.options.fontSize = Math.max(2, BASE_FONT_SIZE * contentScale * renderScale());
    applyHostSize();
    scheduleFit();
  }

  const observer = new ResizeObserver(() => scheduleFit());
  observer.observe(host);

  term.options.fontSize = Math.max(2, BASE_FONT_SIZE * contentScale * renderScale());
  applyHostSize();
  requestAnimationFrame(scheduleFit);
  webglRaf = requestAnimationFrame(attachWebgl);

  chrome.body.addEventListener('pointerdown', () => term.focus());
  chrome.root.addEventListener('dblclick', (event) => {
    if (!event.target.closest('.node-head')) term.focus();
  });

  return {
    el: chrome.root,
    focus: () => {
      try {
        term.focus();
      } catch {
        /* ignore */
      }
    },
    syncTitles: () => {
      chrome.titleEl.textContent = meta.callSign;
      chrome.subEl.textContent = meta.title || CLI_LABEL[meta.cli] || 'Terminal';
    },
    /** The visible screen as text, for the dock preview. */
    previewText: () => {
      try {
        const buffer = term.buffer.active;
        const end = buffer.baseY + buffer.cursorY;
        const lines = [];
        for (let i = Math.max(0, end - 18); i <= end; i += 1) {
          lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
        }
        return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      } catch {
        return '';
      }
    },
    resize: () => {
      applyHostSize();
      scheduleFit();
    },
    setContentScale: (scale) => {
      if (Math.abs(scale - contentScale) < 0.01) return;
      contentScale = scale;
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(commitZoom, ZOOM_COMMIT_MS);
    },
    setZoom: (scale) => {
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(scale) || 1));
      if (Math.abs(next - zoom) < 0.002) return;
      zoom = next;
      clearTimeout(zoomTimer);
      // Stagger the re-render across terminals so a zoom gesture does not make
      // every terminal resize on the same frame.
      zoomCommitSeq += 1;
      zoomTimer = setTimeout(commitZoom, ZOOM_COMMIT_MS + (zoomCommitSeq % 6) * 14);
    },
    destroy: () => {
      destroyed = true;
      clearTimeout(idleTimer);
      clearTimeout(analyseTimer);
      clearTimeout(zoomTimer);
      if (webglRaf) cancelAnimationFrame(webglRaf);
      sessions.delete(meta.id);
      observer.disconnect();
      if (ptyId) {
        routes.delete(ptyId);
        window.api.pty.kill(ptyId);
      }
      try {
        webgl?.dispose();
      } catch {
        /* ignore */
      }
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}

registerNodeType('terminal', createTerminalView);

/* ------------------------------------------------------------------ *
 * Public helpers
 * ------------------------------------------------------------------ */

export function spawnTerminal(canvas, options = {}) {
  const { cli = 'claude', prompt = '', title, model, effort, joint, jointName, jointContextPath } =
    options;
  // Each tab has its own workspace; fall back to the global one, then home.
  const cwd = options.cwd || store.page?.workspace || store.state.workspace || '';
  const used = new Set(store.allNodes().map((node) => node.callSign));
  const callSign = pickUnused(CALL_SIGNS, used);
  const workTitle =
    title ||
    (prompt ? truncate(prompt, 46) : cli === 'claude' ? 'Waiting on the brief' : 'Shell session');

  const guiChat = cli === 'claude' && store.state.settings.guiTerminals;

  return canvas.createNode({
    kind: 'terminal',
    cli,
    prompt,
    cwd,
    w: guiChat ? 760 : undefined,
    h: guiChat ? 560 : undefined,
    callSign,
    title: workTitle,
    subtitle: '',
    model: model || (cli === 'claude' ? 'claude-sonnet-5-5' : null),
    effort: effort || (cli === 'claude' ? 'medium' : null),
    joint: joint || null,
    jointName: jointName || '',
    jointContextPath: jointContextPath || '',
  });
}

export function spawnClaude(canvas, prompt = '') {
  return spawnTerminal(canvas, { cli: 'claude', prompt });
}

export function spawnShell(canvas) {
  return spawnTerminal(canvas, { cli: 'shell' });
}

export { CLI_LABEL };
