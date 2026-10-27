import { el, uid, truncate } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { buildNodeChrome, statusClass } from './node-chrome.js';
import { renderRich } from './richtext.js';

/**
 * Claude GUI mode — a Claude agent rendered as Claude Desktop's chat view
 * (just the conversation: transcript, composer, model + effort pickers).
 *
 * It talks to `claude -p --output-format stream-json`, resuming the same
 * session for every message. Each conversation is saved to disk
 * (userData/chats/<id>.json), so chats survive restarts, and the history
 * menu reopens any earlier one in this window.
 */

const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_MESSAGES = 600;

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

/** A pill that opens a small menu of choices (model / effort). */
function pickerPill(options, value, onPick, label) {
  const text = el('span', { class: 'cx-pill-text' });
  const pill = el(
    'button',
    { class: 'cx-pill', type: 'button', 'aria-label': label, title: label },
    text,
    el('span', { class: 'cx-pill-caret', html: icon('chevronDown') })
  );
  let current = value;
  const show = () => {
    text.textContent = options.find((option) => option.id === current)?.label || current;
  };
  show();
  pill.addEventListener('click', (event) => {
    event.stopPropagation();
    openMenu(
      pill,
      options.map((option) => ({
        label: option.label,
        active: option.id === current,
        onClick: () => {
          current = option.id;
          show();
          onPick(option.id);
        },
      }))
    );
  });
  return {
    el: pill,
    set: (next) => {
      current = next;
      show();
    },
  };
}

/** Small anchored menu; closes on outside click or Escape. */
function openMenu(anchor, items, { className = '', empty = 'Nothing here yet' } = {}) {
  document.querySelector('.cx-menu')?.remove();
  const menu = el('div', { class: `cx-menu ${className}` });
  if (!items.length) menu.append(el('div', { class: 'cx-menu-empty', text: empty }));
  for (const item of items) {
    menu.append(
      el(
        'button',
        {
          class: `cx-menu-item${item.active ? ' is-active' : ''}`,
          type: 'button',
          onclick: (event) => {
            event.stopPropagation();
            menu.remove();
            item.onClick();
          },
        },
        el('span', { class: 'cx-menu-label', text: item.label }),
        item.hint ? el('span', { class: 'cx-menu-hint', text: item.hint }) : null,
        item.active ? el('span', { class: 'cx-menu-check', html: icon('check') }) : null
      )
    );
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left));
  const above = rect.top - height - 6;
  menu.style.left = `${left}px`;
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
 * @param {{ session?: { set: Function, clear: Function }, appendPrompt?: string }} [options]
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
    messages: Array.isArray(meta.messages) ? meta.messages : [],
  };
  delete meta.messages;

  const chrome = buildNodeChrome(meta, {
    brand: 'claude',
    iconName: 'claude',
    actions: [
      { icon: 'history', title: 'Recent chats', onClick: (event) => showHistory(event) },
      { icon: 'compose', title: 'New chat', onClick: () => newChat() },
      { icon: 'x', title: 'Close', danger: true, onClick: () => canvas.closeNode(meta.id) },
    ],
  });
  chrome.titleEl.textContent = meta.callSign;
  chrome.subEl.textContent = meta.title || 'Claude';

  const log = el('div', { class: 'cx-log' });
  const scroller = el('div', { class: 'cx-scroll' }, el('div', { class: 'cx-column' }, log));

  const input = el('textarea', {
    class: 'cx-input',
    rows: '1',
    placeholder: 'Reply to Claude…',
    spellcheck: 'false',
  });
  const sendBtn = el('button', {
    class: 'cx-send',
    type: 'button',
    title: 'Send',
    'aria-label': 'Send',
    html: icon('arrowUp'),
  });
  const modelPill = pickerPill(MODELS, meta.model, (id) => {
    meta.model = id;
    store.save();
    persist();
  }, 'Model');
  const effortPill = pickerPill(
    EFFORTS.map((effort) => ({ id: effort, label: effort })),
    meta.effort,
    (id) => {
      meta.effort = id;
      store.save();
      persist();
    },
    'Effort'
  );
  const composer = el(
    'div',
    { class: 'cx-composer' },
    input,
    el(
      'div',
      { class: 'cx-composer-bar' },
      modelPill.el,
      effortPill.el,
      el('span', { class: 'cx-spacer' }),
      sendBtn
    )
  );

  chrome.body.classList.add('cx-body');
  chrome.body.append(scroller, el('div', { class: 'cx-dock' }, el('div', { class: 'cx-column' }, composer)));

  let busy = false;
  let streaming = null;
  let saveTimer = null;

  function persist() {
    if (chat.messages.length > MAX_MESSAGES) chat.messages = chat.messages.slice(-MAX_MESSAGES);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      window.api.chats
        .save({
          id: chat.id,
          title: chat.title,
          sessionId: chat.sessionId,
          model: meta.model,
          effort: meta.effort,
          cwd: meta.cwd || '',
          messages: chat.messages,
        })
        .catch(() => {});
    }, 300);
  }

  function setStatus(status) {
    if (meta.status === status) return;
    meta.status = status;
    chrome.dotEl.className = statusClass(status);
    store.emit('status', meta);
  }

  /* ----------------------------- rendering ----------------------------- */

  function row(message) {
    if (message.role === 'user') {
      return el('div', { class: 'cx-row is-user' }, el('div', { class: 'cx-bubble', text: message.text }));
    }
    if (message.role === 'tool') {
      return el(
        'div',
        { class: 'cx-tool' },
        el('span', { class: 'cx-tool-name', text: message.text }),
        message.detail ? el('span', { class: 'cx-tool-detail', text: message.detail }) : null
      );
    }
    if (message.role === 'meta') return el('div', { class: 'cx-meta', text: message.text });
    if (message.role === 'error') return el('div', { class: 'cx-error', text: message.text });
    const body = el('div', { class: 'cx-text' });
    body.innerHTML = renderRich(message.text);
    return el('div', { class: 'cx-row is-assistant' }, body);
  }

  function emptyState() {
    return el(
      'div',
      { class: 'cx-hello' },
      el('span', { class: 'cx-hello-mark', html: icon('claude') }),
      el('h2', { text: greeting() }),
      el('p', { text: meta.cwd || store.page?.workspace || 'Claude Code · this tab’s workspace' })
    );
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour < 5 || hour >= 22) return 'Burning the midnight oil?';
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function thinking() {
    return el(
      'div',
      { class: 'cx-row is-assistant' },
      el('span', { class: 'cx-spark', html: icon('claude') }),
      el('span', { class: 'cx-thinking-label', text: 'Thinking…' })
    );
  }

  function render() {
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    if (!chat.messages.length && !busy) {
      log.replaceChildren(emptyState());
      chrome.root.classList.add('is-empty-chat');
    } else {
      chrome.root.classList.remove('is-empty-chat');
      const rows = chat.messages.map(row);
      if (busy && !streaming) rows.push(thinking());
      log.replaceChildren(...rows);
    }
    if (nearBottom || busy) scroller.scrollTop = scroller.scrollHeight;
    sendBtn.innerHTML = icon(busy ? 'stop' : 'arrowUp');
    sendBtn.title = busy ? 'Stop' : 'Send';
    sendBtn.classList.toggle('is-stop', busy);
    syncSend();
  }

  function syncSend() {
    sendBtn.disabled = !busy && !input.value.trim();
  }

  function add(role, text, extra = {}) {
    chat.messages.push({ role, text, at: Date.now(), ...extra });
    persist();
    render();
  }

  /* ------------------------------ actions ------------------------------ */

  function stop() {
    try {
      window.api.claude.cancel({ nodeId: meta.id });
    } catch {
      /* ignore */
    }
    busy = false;
    streaming = null;
    setStatus('idle');
    render();
  }

  function newChat() {
    if (busy) stop();
    chat.id = uid('chat');
    chat.title = '';
    chat.sessionId = '';
    chat.messages = [];
    meta.chatId = chat.id;
    meta.chatSessionId = '';
    meta.title = 'New chat';
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
    chat.messages = Array.isArray(saved.messages) ? saved.messages : [];
    meta.chatId = chat.id;
    meta.chatSessionId = chat.sessionId;
    if (saved.model) {
      meta.model = saved.model;
      modelPill.set(saved.model);
    }
    if (saved.effort) {
      meta.effort = saved.effort;
      effortPill.set(saved.effort);
    }
    if (chat.title) meta.title = chat.title;
    syncTitles();
    store.save();
    render();
    scroller.scrollTop = scroller.scrollHeight;
    return true;
  }

  async function showHistory(event) {
    const anchor = event?.currentTarget || chrome.actionsEl;
    const list = await window.api.chats.list().catch(() => []);
    openMenu(
      anchor,
      list.map((item) => ({
        label: truncate(item.title, 52),
        hint: relativeTime(item.updatedAt),
        active: item.id === chat.id,
        onClick: () => loadChat(item.id),
      })),
      { className: 'cx-history', empty: 'No saved chats yet' }
    );
  }

  async function sendText(raw) {
    const text = String(raw || '').trim();
    if (!text) return false;
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
        appendPrompt: options.appendPrompt || '',
        cwd: meta.cwd || store.page?.workspace || store.state.workspace || '',
        fullPermissions: store.state.settings.agentFullPermissions !== false,
      });
    } catch (error) {
      busy = false;
      setStatus('idle');
      add('error', `Error: ${error?.message || error}`);
    }
    return true;
  }

  function submit() {
    if (busy && !input.value.trim()) {
      stop();
      return;
    }
    const text = input.value;
    input.value = '';
    autosize();
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
      add('tool', payload.name || 'tool', { detail: payload.detail || '' });
      return;
    }
    if (payload.type === 'tool-error') return;
    if (payload.type === 'result') {
      busy = false;
      streaming = null;
      setStatus('idle');
      if (payload.costUsd) {
        store.addSpend(payload.costUsd, meta.model);
        const seconds = payload.durationMs ? ` · ${(payload.durationMs / 1000).toFixed(1)}s` : '';
        add('meta', `$${Number(payload.costUsd).toFixed(3)}${seconds}`);
      } else {
        render();
      }
      return;
    }
    if (payload.type === 'error') {
      busy = false;
      streaming = null;
      setStatus('idle');
      add('error', payload.message);
      return;
    }
    if (payload.type === 'exit') {
      if (!busy) return;
      busy = false;
      streaming = null;
      setStatus('idle');
      render();
    }
  }

  handlers.set(meta.id, onEvent);
  options.session?.set({ write: (text) => sendText(text) });

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(200, Math.max(24, input.scrollHeight))}px`;
    syncSend();
  }

  function syncTitles() {
    chrome.titleEl.textContent = meta.callSign;
    chrome.subEl.textContent = meta.title || 'Claude';
  }

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  sendBtn.addEventListener('click', submit);
  composer.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    if (event.target === composer) input.focus();
  });

  // Load the saved conversation, then run the task this agent was spawned with.
  render();
  window.api.chats
    .load(chat.id)
    .then((saved) => {
      if (saved && Array.isArray(saved.messages) && saved.messages.length >= chat.messages.length) {
        chat.title = saved.title || chat.title;
        chat.sessionId = saved.sessionId || chat.sessionId;
        chat.messages = saved.messages;
        render();
        scroller.scrollTop = scroller.scrollHeight;
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
        .map((message) => `${message.role === 'user' ? 'You' : 'Claude'}: ${truncate(message.text.replace(/\s+/g, ' '), 220)}`)
        .join('\n\n'),
    setModel: (model) => {
      meta.model = model;
      modelPill.set(model);
      persist();
    },
    setEffort: (effort) => {
      meta.effort = effort;
      effortPill.set(effort);
      persist();
    },
    resize: () => {},
    destroy: () => {
      handlers.delete(meta.id);
      options.session?.clear();
      clearTimeout(saveTimer);
      if (busy) {
        try {
          window.api.claude.cancel({ nodeId: meta.id });
        } catch {
          /* ignore */
        }
      }
      // Flush the last state so nothing typed is lost.
      window.api.chats
        .save({
          id: chat.id,
          title: chat.title,
          sessionId: chat.sessionId,
          model: meta.model,
          effort: meta.effort,
          cwd: meta.cwd || '',
          messages: chat.messages,
        })
        .catch(() => {});
    },
  };
}
