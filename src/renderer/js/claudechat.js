import { el, uid, truncate } from './util.js';
import { store } from './store.js';
import { buildNodeChrome, statusClass } from './node-chrome.js';
import { renderMessage, welcomeBox, spinnerRow } from './ccview.js';

/**
 * Claude GUI mode — a Claude agent rendered exactly like the Claude Code
 * terminal UI: the welcome box, "> prompt" lines, ⏺ bullets, tool calls with
 * their ⎿ results and diffs, the ✻ spinner, and the bordered input box with
 * slash commands — but drawn as crisp, scalable HTML instead of an xterm.
 *
 * It talks to `claude -p --output-format stream-json`, resuming the same
 * session for every message. Each conversation is saved to disk
 * (userData/chats/<id>.json), so chats survive restarts, and /resume (or the
 * history button) reopens any earlier one in this window.
 */

const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];
const MODEL_ALIASES = {
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_MESSAGES = 600;

const SLASH_COMMANDS = [
  { name: '/clear', desc: 'Start a new conversation' },
  { name: '/resume', desc: 'Resume an earlier conversation' },
  { name: '/model', desc: 'Set the model (sonnet, opus, haiku, fable)' },
  { name: '/effort', desc: 'Set the effort (low, medium, high, xhigh, max)' },
  { name: '/cost', desc: 'Show what this conversation has cost' },
  { name: '/help', desc: 'Show the commands' },
];

let wired = false;
const handlers = new Map();

function ensureWired() {
  if (wired) return;
  wired = true;
  window.api.claude.onEvent((payload) => {
    handlers.get(payload.nodeId)?.(payload);
  });
}

function relativeTime(at) {
  const minutes = Math.round((Date.now() - (at || 0)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function modelLabel(id) {
  return MODELS.find((model) => model.id === id)?.label || id;
}

/** Small anchored menu; closes on outside click or Escape. */
function openMenu(anchor, items, { className = '', empty = 'Nothing here yet' } = {}) {
  document.querySelector('.cc-menu')?.remove();
  const menu = el('div', { class: `cc-menu ${className}` });
  if (!items.length) menu.append(el('div', { class: 'cc-menu-empty', text: empty }));
  for (const item of items) {
    menu.append(
      el(
        'button',
        {
          class: `cc-menu-item${item.active ? ' is-active' : ''}`,
          type: 'button',
          onclick: (event) => {
            event.stopPropagation();
            menu.remove();
            item.onClick();
          },
        },
        el('span', { class: 'cc-menu-mark', text: item.active ? '❯' : ' ' }),
        el('span', { class: 'cc-menu-label', text: item.label }),
        item.hint ? el('span', { class: 'cc-menu-hint', text: item.hint }) : null
      )
    );
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, rect.left))}px`;
  const above = rect.top - height - 6;
  menu.style.top = `${above > 8 ? above : rect.bottom + 6}px`;
  const dismiss = (event) => {
    if (event.type === 'keydown' && event.key !== 'Escape') return;
    if (event.type === 'pointerdown' && menu.contains(event.target)) return;
    menu.remove();
    window.removeEventListener('pointerdown', dismiss, true);
    window.removeEventListener('keydown', dismiss, true);
  };
  setTimeout(() => {
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', dismiss, true);
  }, 0);
  menu.addEventListener('pointerdown', (event) => event.stopPropagation());
}

/**
 * @param {object} meta  the node
 * @param {object} canvas
 * @param {{ session?: { set: Function, clear: Function }, appendPrompt?: string | (() => string) }} [options]
 */
export function createChatView(meta, canvas, options = {}) {
  ensureWired();

  meta.model = meta.model || 'claude-sonnet-5-5';
  meta.effort = meta.effort || 'medium';
  if (!meta.chatId) meta.chatId = uid('chat');

  // The conversation itself lives on disk, not in the canvas state.
  const chat = {
    id: meta.chatId,
    title: '',
    sessionId: meta.chatSessionId || '',
    cost: 0,
    messages: Array.isArray(meta.messages) ? meta.messages : [],
  };
  delete meta.messages;

  const chrome = buildNodeChrome(meta, {
    brand: 'claude',
    iconName: 'claude',
    actions: [
      // /resume and /clear are typed in the chat; the header only closes.
      { icon: 'x', title: 'Close', danger: true, onClick: () => canvas.closeNode(meta.id) },
    ],
  });
  chrome.titleEl.textContent = meta.callSign;
  chrome.subEl.textContent = meta.title || 'Claude Code';

  const cwd = () => meta.cwd || store.page?.workspace || store.state.workspace || '';

  /* ------------------------------ layout ------------------------------ */

  const log = el('div', { class: 'cc-log' });
  const scroller = el('div', { class: 'cc-scroll' }, log);

  const input = el('textarea', {
    class: 'cc-input',
    rows: '1',
    placeholder: 'Try "how does <filepath> work?"',
    spellcheck: 'false',
  });
  const inputBox = el('div', { class: 'cc-input-box' }, el('span', { class: 'cc-prompt', text: '>' }), input);
  const slash = el('div', { class: 'cc-slash' });
  const hint = el('span', { class: 'cc-hint' });
  const modelEl = el('button', { class: 'cc-model', type: 'button', title: 'Model and effort' });
  const footer = el('div', { class: 'cc-footer' }, hint, modelEl);

  chrome.body.classList.add('cc-body');
  chrome.body.append(scroller, el('div', { class: 'cc-dock' }, slash, inputBox, footer));

  let busy = false;
  let streaming = null;
  let spinner = null;
  let saveTimer = null;
  let historyIndex = -1;

  function persist() {
    if (chat.messages.length > MAX_MESSAGES) chat.messages = chat.messages.slice(-MAX_MESSAGES);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  }

  function save() {
    return window.api.chats
      .save({
        id: chat.id,
        title: chat.title,
        sessionId: chat.sessionId,
        cost: chat.cost,
        model: meta.model,
        effort: meta.effort,
        cwd: meta.cwd || '',
        messages: chat.messages,
      })
      .catch(() => {});
  }

  function setStatus(status) {
    if (meta.status === status) return;
    meta.status = status;
    chrome.dotEl.className = statusClass(status);
    store.emit('status', meta);
  }

  function syncFooter() {
    const bypass = store.state.settings.agentFullPermissions !== false;
    hint.className = `cc-hint${bypass ? ' is-bypass' : ''}`;
    hint.textContent = busy
      ? 'esc to interrupt'
      : bypass
        ? '⏵⏵ bypass permissions on'
        : '? for shortcuts';
    modelEl.textContent = `${modelLabel(meta.model)} · ${meta.effort}`;
  }

  /* ----------------------------- rendering ---------------------------- */

  // Rendering is incremental: each message keeps its row until something it
  // shows changes, and many updates in one frame (a streaming reply) render
  // once. Long conversations stay cheap, and expanded outputs stay expanded.
  const rowCache = new WeakMap(); // message -> { key, row }
  let welcome = null; // { cwd, row }
  let renderFrame = 0;
  let renderToBottom = false;

  function rowFor(message) {
    const running = busy && message.role === 'tool' && !message.result;
    const key = `${String(message.text ?? '').length}|${message.result ? 1 : 0}|${running ? 1 : 0}|${cwd()}`;
    const cached = rowCache.get(message);
    if (cached && cached.key === key) return cached.row;
    const row = renderMessage(message, { cwd: cwd(), running });
    rowCache.set(message, { key, row });
    return row;
  }

  function render({ toBottom = false } = {}) {
    if (toBottom) renderToBottom = true;
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(renderNow);
  }

  function renderNow() {
    renderFrame = 0;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    if (!welcome || welcome.cwd !== cwd()) welcome = { cwd: cwd(), row: welcomeBox(cwd()) };
    const rows = [welcome.row];
    for (const message of chat.messages) rows.push(rowFor(message));
    if (busy) {
      // One spinner per turn, so its timer keeps counting across re-renders.
      if (!spinner) spinner = spinnerRow();
      rows.push(spinner);
    } else {
      spinner = null;
    }
    // Touch only what changed: rows already in place stay put.
    rows.forEach((row, index) => {
      const current = log.children[index];
      if (current !== row) log.insertBefore(row, current || null);
    });
    while (log.children.length > rows.length) log.lastElementChild.remove();
    if (nearBottom || busy || renderToBottom) scroller.scrollTop = scroller.scrollHeight;
    renderToBottom = false;
    syncFooter();
  }

  function add(role, text, extra = {}) {
    chat.messages.push({ role, text, at: Date.now(), ...extra });
    persist();
    render();
  }

  /** A line from the app itself (slash command output), like Claude Code's dim notices. */
  function notice(text) {
    add('meta', text);
  }

  /* ------------------------------ actions ----------------------------- */

  function stop() {
    if (!busy) return;
    try {
      window.api.claude.cancel({ nodeId: meta.id });
    } catch {
      /* ignore */
    }
    busy = false;
    streaming = null;
    setStatus('idle');
    add('error', 'Interrupted by user');
  }

  function newChat() {
    if (busy) stop();
    chat.id = uid('chat');
    chat.title = '';
    chat.sessionId = '';
    chat.cost = 0;
    chat.messages = [];
    meta.chatId = chat.id;
    meta.chatSessionId = '';
    meta.title = 'New conversation';
    syncTitles();
    store.save();
    render();
    input.focus();
  }

  async function loadChat(id) {
    const saved = await window.api.chats.load(id).catch(() => null);
    if (!saved) return false;
    if (busy) stop();
    chat.id = saved.id;
    chat.title = saved.title || '';
    chat.sessionId = saved.sessionId || '';
    chat.cost = Number(saved.cost) || 0;
    chat.messages = Array.isArray(saved.messages) ? saved.messages : [];
    meta.chatId = chat.id;
    meta.chatSessionId = chat.sessionId;
    if (saved.model) meta.model = saved.model;
    if (saved.effort) meta.effort = saved.effort;
    if (chat.title) meta.title = chat.title;
    syncTitles();
    store.save();
    render({ toBottom: true });
    return true;
  }

  async function showHistory(anchor) {
    const list = await window.api.chats.list().catch(() => []);
    openMenu(
      anchor || inputBox,
      list.map((item) => ({
        label: truncate(item.title, 52),
        hint: relativeTime(item.updatedAt),
        active: item.id === chat.id,
        onClick: () => loadChat(item.id),
      })),
      { className: 'cc-history', empty: 'No conversations to resume' }
    );
  }

  function setModel(id) {
    meta.model = id;
    store.save();
    persist();
    syncFooter();
  }

  function setEffort(effort) {
    meta.effort = effort;
    store.save();
    persist();
    syncFooter();
  }

  function pickModel() {
    openMenu(
      modelEl,
      [
        ...MODELS.map((model) => ({
          label: model.label,
          active: model.id === meta.model,
          onClick: () => {
            setModel(model.id);
            notice(`Set model to ${model.label}`);
          },
        })),
        ...EFFORTS.map((effort) => ({
          label: `effort: ${effort}`,
          active: effort === meta.effort,
          onClick: () => {
            setEffort(effort);
            notice(`Set effort to ${effort}`);
          },
        })),
      ],
      { className: 'cc-model-menu' }
    );
  }

  /** Slash commands, handled locally like Claude Code's built-ins. */
  function runSlash(text) {
    const [command, ...rest] = text.trim().split(/\s+/);
    const arg = rest.join(' ').toLowerCase();
    switch (command.toLowerCase()) {
      case '/clear':
      case '/new':
        newChat();
        return true;
      case '/resume':
        showHistory(inputBox);
        return true;
      case '/model': {
        if (!arg) {
          pickModel();
          return true;
        }
        const id = MODEL_ALIASES[arg] || MODELS.find((model) => model.id === arg)?.id || arg;
        setModel(id);
        notice(`Set model to ${modelLabel(id)}`);
        return true;
      }
      case '/effort':
        if (EFFORTS.includes(arg)) {
          setEffort(arg);
          notice(`Set effort to ${arg}`);
        } else {
          notice(`Effort is ${meta.effort}. Use /effort ${EFFORTS.join(' | ')}`);
        }
        return true;
      case '/cost':
        notice(`Total cost: $${chat.cost.toFixed(4)}`);
        return true;
      case '/help':
        notice(SLASH_COMMANDS.map((item) => `${item.name.padEnd(9)} ${item.desc}`).join('\n'));
        return true;
      default:
        return false;
    }
  }

  async function sendText(raw) {
    const text = String(raw || '').trim();
    if (!text) return false;
    if (text.startsWith('/') && runSlash(text)) return true;
    if (busy) stop();
    busy = true;
    streaming = null;
    if (!chat.title) {
      chat.title = truncate(text.replace(/\s+/g, ' '), 60);
      meta.title = chat.title;
      syncTitles();
      store.save();
    }
    add('user', text);
    setStatus('working');
    try {
      await window.api.claude.send({
        nodeId: meta.id,
        sessionId: chat.sessionId || '',
        message: text,
        model: meta.model,
        effort: meta.effort,
        // Read fresh each turn so a promotion or team move applies to the next message.
        appendPrompt:
          (typeof options.appendPrompt === 'function' ? options.appendPrompt() : options.appendPrompt) || '',
        cwd: cwd(),
        fullPermissions: store.state.settings.agentFullPermissions !== false,
        team: Boolean(meta.joint),
        // Who is speaking, for the shared-context log.
        agentName: meta.callSign || '',
        joint: meta.joint ? { id: meta.joint, name: meta.jointName || store.joints[meta.joint]?.name || '' } : null,
        rank: meta.joint ? meta.rank || null : null,
      });
    } catch (error) {
      busy = false;
      setStatus('idle');
      add('error', `Error: ${error?.message || error}`);
    }
    return true;
  }

  function submit() {
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    historyIndex = -1;
    autosize();
    showSlash();
    sendText(text);
  }

  function onEvent(payload) {
    if (payload.type === 'init') {
      if (payload.sessionId && payload.sessionId !== chat.sessionId) {
        chat.sessionId = payload.sessionId;
        meta.chatSessionId = payload.sessionId;
        store.save();
        persist();
      }
      return;
    }
    if (payload.type === 'assistant') {
      if (streaming && chat.messages[chat.messages.length - 1] === streaming) {
        streaming.text += `\n\n${payload.text}`;
      } else {
        streaming = { role: 'assistant', text: payload.text, at: Date.now() };
        chat.messages.push(streaming);
      }
      persist();
      render();
      return;
    }
    if (payload.type === 'tool') {
      streaming = null;
      chat.messages.push({
        role: 'tool',
        id: payload.id,
        tool: payload.tool || payload.name,
        input: payload.input || {},
        at: Date.now(),
      });
      persist();
      render();
      return;
    }
    if (payload.type === 'tool-result') {
      const call = [...chat.messages].reverse().find((message) => message.role === 'tool' && message.id === payload.id);
      if (call) {
        call.result = { isError: payload.isError, text: payload.text || '', lines: payload.lines || 0 };
        persist();
        render();
      }
      return;
    }
    if (payload.type === 'tool-error') return;
    if (payload.type === 'result') {
      busy = false;
      streaming = null;
      setStatus('idle');
      if (payload.costUsd) {
        chat.cost += Number(payload.costUsd) || 0;
        store.addSpend(payload.costUsd, meta.model, meta.id);
      }
      if (!payload.ok && payload.result) add('error', String(payload.result));
      persist();
      render();
      drainInbox();
      return;
    }
    if (payload.type === 'error') {
      busy = false;
      streaming = null;
      setStatus('idle');
      add('error', payload.message);
      drainInbox();
      return;
    }
    if (payload.type === 'exit') {
      if (!busy) return;
      busy = false;
      streaming = null;
      setStatus('idle');
      render();
      drainInbox();
    }
  }

  // Messages from the Director, a lead or a report wait for the current turn
  // to finish instead of interrupting it (typing yourself still interrupts).
  const inbox = [];
  function drainInbox() {
    if (busy || !inbox.length) return;
    sendText(inbox.shift());
  }

  handlers.set(meta.id, onEvent);
  options.session?.set({
    write: (text) => {
      inbox.push(text);
      drainInbox();
    },
  });

  /* ------------------------------- input ------------------------------ */

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(220, Math.max(20, input.scrollHeight))}px`;
  }

  function showSlash() {
    const value = input.value;
    if (!value.startsWith('/') || /\s/.test(value)) {
      slash.replaceChildren();
      slash.classList.remove('is-open');
      return;
    }
    const matches = SLASH_COMMANDS.filter((item) => item.name.startsWith(value.toLowerCase()));
    slash.replaceChildren(
      ...matches.map((item, index) =>
        el(
          'button',
          {
            class: `cc-slash-item${index === 0 ? ' is-active' : ''}`,
            type: 'button',
            onclick: () => {
              input.value = `${item.name} `;
              input.focus();
              showSlash();
            },
          },
          el('span', { class: 'cc-slash-name', text: item.name }),
          el('span', { class: 'cc-slash-desc', text: item.desc })
        )
      )
    );
    slash.classList.toggle('is-open', matches.length > 0);
  }

  function pastPrompts() {
    return chat.messages.filter((message) => message.role === 'user').map((message) => message.text);
  }

  input.addEventListener('input', () => {
    autosize();
    showSlash();
  });
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // Enter on a half-typed slash command completes it first.
      const first = slash.querySelector('.cc-slash-item');
      if (first && slash.classList.contains('is-open') && !input.value.includes(' ')) {
        const name = first.querySelector('.cc-slash-name').textContent;
        if (name !== input.value.trim()) {
          input.value = name;
        }
      }
      submit();
    } else if (event.key === 'Tab' && slash.classList.contains('is-open')) {
      event.preventDefault();
      slash.querySelector('.cc-slash-item')?.click();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (busy) stop();
      else {
        input.value = '';
        autosize();
        showSlash();
      }
    } else if (event.key === 'ArrowUp' && !input.value.includes('\n') && input.selectionStart === 0) {
      // Up/Down walk through earlier prompts, like the terminal.
      const past = pastPrompts();
      if (!past.length) return;
      event.preventDefault();
      historyIndex = historyIndex < 0 ? past.length - 1 : Math.max(0, historyIndex - 1);
      input.value = past[historyIndex];
      autosize();
    } else if (event.key === 'ArrowDown' && historyIndex >= 0 && !input.value.includes('\n')) {
      event.preventDefault();
      const past = pastPrompts();
      historyIndex += 1;
      input.value = historyIndex < past.length ? past[historyIndex] : '';
      if (historyIndex >= past.length) historyIndex = -1;
      autosize();
    }
  });
  modelEl.addEventListener('click', (event) => {
    event.stopPropagation();
    pickModel();
  });
  for (const node of [inputBox, footer, slash]) {
    node.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      if (event.target === inputBox) input.focus();
    });
  }
  // Clicking the transcript (not selecting text) puts the cursor in the box.
  scroller.addEventListener('click', () => {
    if (!window.getSelection()?.toString()) input.focus();
  });
  const offSettings = store.on('settings', syncFooter);

  function syncTitles() {
    chrome.titleEl.textContent = meta.callSign;
    chrome.subEl.textContent = meta.title || 'Claude Code';
  }

  // Load the saved conversation, then run the task this agent was spawned with.
  render();
  window.api.chats
    .load(chat.id)
    .then((saved) => {
      if (saved && Array.isArray(saved.messages) && saved.messages.length >= chat.messages.length) {
        chat.title = saved.title || chat.title;
        chat.sessionId = saved.sessionId || chat.sessionId;
        chat.cost = Number(saved.cost) || 0;
        chat.messages = saved.messages;
        render({ toBottom: true });
      } else if (chat.messages.length) {
        persist();
      }
    })
    .catch(() => {})
    .finally(() => {
      const prompt = String(meta.prompt || '').trim();
      if (prompt && !busy) {
        meta.prompt = '';
        sendText(prompt);
      }
    });

  return {
    el: chrome.root,
    focus: () => {
      try {
        input.focus();
      } catch {
        /* ignore */
      }
    },
    syncTitles,
    /** The last few turns as text, for the dock preview. */
    previewText: () =>
      chat.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .slice(-4)
        .map((message) => `${message.role === 'user' ? '>' : '⏺'} ${truncate(message.text.replace(/\s+/g, ' '), 220)}`)
        .join('\n\n'),
    setModel: (model) => {
      setModel(model);
    },
    setEffort: (effort) => {
      setEffort(effort);
    },
    resize: () => {},
    destroy: () => {
      handlers.delete(meta.id);
      offSettings();
      options.session?.clear();
      clearTimeout(saveTimer);
      if (busy) {
        try {
          window.api.claude.cancel({ nodeId: meta.id });
        } catch {
          /* ignore */
        }
      }
      // Flush the last state so nothing is lost.
      save();
    },
  };
}
