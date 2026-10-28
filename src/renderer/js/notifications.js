import { $, el } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { writeToNode } from './terminal.js';
import { setBarAttention } from './topbar.js';

/** Agents shown before the rest fold into "N more". */
const VISIBLE = 3;

function extractOptions(raw) {
  const options = [];
  const re = /(?:^|\n)\s*[❯>»]?\s*(\d)\.\s+([^\n]{2,46})/g;
  let match = re.exec(raw || '');
  while (match && options.length < 3) {
    const label = match[2].replace(/\s+/g, ' ').trim();
    if (label && !options.includes(label)) options.push(label);
    match = re.exec(raw || '');
  }
  return options;
}

/**
 * Agents that finished or need you, as compact rows in the top-right
 * notification stack (toasts sit just above them; see app.js).
 */
export function initNotifications(ctx) {
  const listEl = $('#tiles');

  /** @type {Map<string, {kind: string, snippet: string, raw: string, at: number}>} */
  const attention = new Map();
  let expanded = false;

  function dismiss(id) {
    attention.delete(id);
    render();
  }

  function row(node, entry) {
    const page = store.pageOfNode(node.id);
    const isAlert = entry.kind === 'needs';
    const options = isAlert ? extractOptions(entry.raw) : [];

    const rowEl = el(
      'div',
      {
        class: `notice-agent${isAlert ? ' is-alert' : ''}`,
        role: 'button',
        tabindex: '0',
        title: `Go to ${node.callSign}`,
        onclick: () => {
          dismiss(node.id);
          ctx.canvas.focusAgent(node.id);
        },
        onkeydown: (event) => {
          if (event.key === 'Enter') {
            dismiss(node.id);
            ctx.canvas.focusAgent(node.id);
          }
        },
      },
      el('span', { class: 'notice-icon', html: icon(node.cli === 'claude' ? 'claude' : 'shell') }),
      el(
        'div',
        { class: 'notice-main' },
        el(
          'div',
          { class: 'notice-line' },
          el('span', { class: 'notice-name', text: node.callSign }),
          el('span', { class: 'notice-state', text: isAlert ? 'needs you' : 'finished' }),
          page && page.id !== store.page.id ? el('span', { class: 'notice-where', text: page.name }) : null
        ),
        el('div', { class: 'notice-text', text: entry.snippet || node.title || '' })
      ),
      el('button', {
        class: 'notice-x',
        type: 'button',
        title: 'Dismiss',
        'aria-label': `Dismiss ${node.callSign}`,
        html: icon('x'),
        onclick: (event) => {
          event.stopPropagation();
          dismiss(node.id);
        },
      })
    );

    // A question with numbered answers: answer it from here.
    if (options.length) {
      rowEl.append(
        el(
          'div',
          { class: 'notice-options' },
          ...options.map((option, index) =>
            el('button', {
              class: 'notice-option',
              type: 'button',
              title: option,
              text: option,
              onclick: (event) => {
                event.stopPropagation();
                if (writeToNode(node.id, String(index + 1))) dismiss(node.id);
              },
            })
          )
        )
      );
    }
    return rowEl;
  }

  function waiting() {
    return Array.from(attention.entries())
      .map(([id, entry]) => ({ found: store.findNode(id), entry }))
      .filter((item) => item.found)
      // Questions first, then the newest.
      .sort((a, b) => (b.entry.kind === 'needs') - (a.entry.kind === 'needs') || b.entry.at - a.entry.at);
  }

  function render() {
    for (const id of Array.from(attention.keys())) {
      if (!store.findNode(id)) attention.delete(id);
    }

    const entries = waiting();
    const shown = expanded ? entries : entries.slice(0, VISIBLE);
    listEl.replaceChildren(...shown.map(({ found, entry }) => row(found.node, entry)));

    if (entries.length > VISIBLE) {
      listEl.append(
        el(
          'div',
          { class: 'notice-foot' },
          el('button', {
            class: 'notice-more',
            type: 'button',
            text: expanded ? 'Show fewer' : `${entries.length - VISIBLE} more waiting`,
            onclick: () => {
              expanded = !expanded;
              render();
            },
          }),
          el('button', {
            class: 'notice-more',
            type: 'button',
            text: 'Clear all',
            onclick: () => {
              attention.clear();
              expanded = false;
              render();
            },
          })
        )
      );
    }

    markTabs(entries);
  }

  /** Mark pages (and the bar handle) that have someone waiting. */
  function markTabs(entries = waiting()) {
    const waitingPages = new Set(entries.map(({ found }) => store.pageOfNode(found.node.id)?.id));
    for (const tab of document.querySelectorAll('.tab[data-page-id]')) {
      tab.classList.toggle('has-attention', waitingPages.has(tab.dataset.pageId));
    }
    setBarAttention(entries.some(({ found }) => store.pageOfNode(found.node.id)?.id !== store.page.id));
  }

  /* ------------------------------ events ----------------------------- */

  // One system notification per agent and kind, even when a finish is
  // reported both by the status watcher below and by the terminal itself.
  const lastSystem = new Map();

  function systemNotify(id, kind, snippet) {
    if (!store.state.settings.agentNotifications) return;
    if (document.hasFocus()) return;
    const found = store.findNode(id);
    if (!found || !('Notification' in window)) return;
    const key = `${id}:${kind}`;
    if (Date.now() - (lastSystem.get(key) || 0) < 5000) return;
    lastSystem.set(key, Date.now());
    const title = `${found.node.callSign} ${kind === 'needs' ? 'needs you' : 'finished'}`;
    try {
      if (Notification.permission === 'granted') {
        const notification = new Notification(title, { body: snippet });
        notification.onclick = () => ctx.canvas.focusAgent(id);
      } else if (Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch {
      /* ignore */
    }
  }

  store.on('attention', ({ id, kind, snippet, raw }) => {
    attention.set(id, { kind, snippet, raw, at: Date.now() });
    render();
    systemNotify(id, kind, snippet);
  });

  // Any agent going from working to idle is "finished", whether or not it is
  // on screen. Short blips (typing echo in a terminal) and the window you are
  // typing in don't count.
  const MIN_WORK_MS = 3000;
  const workingSince = new Map();
  store.on('status', (meta) => {
    if (!meta || meta.kind !== 'terminal' || meta.cli !== 'claude') return;
    if (meta.status === 'working') {
      if (!workingSince.has(meta.id)) workingSince.set(meta.id, Date.now());
      return;
    }
    const since = workingSince.get(meta.id);
    workingSince.delete(meta.id);
    if (meta.status !== 'idle' || !since || Date.now() - since < MIN_WORK_MS) return;
    if (!store.state.settings.agentNotifications || ctx.canvas.isFocused(meta.id)) return;
    const prior = attention.get(meta.id);
    const snippet = prior?.kind === 'finished' ? prior.snippet : meta.title || '';
    attention.set(meta.id, { kind: 'finished', snippet, raw: '', at: Date.now() });
    render();
    systemNotify(meta.id, 'finished', snippet);
  });

  store.on('selection', (id) => {
    if (id && attention.has(id)) {
      attention.delete(id);
    }
    render();
  });
  store.on('status', () => render());
  store.on('nodes', () => render());
  store.on('page', () => render());
  // The page bar rebuilds its tabs; mark them again.
  store.on('tabs', () => markTabs());

  render();

  return {
    render,
    clearAttention: () => {
      attention.clear();
      render();
    },
  };
}
