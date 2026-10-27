import { $, el } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';

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

export function initNotifications(ctx) {
  const chip = $('#waiting-chip');
  const chipLabel = $('#waiting-label');
  const tilesEl = $('#tiles');

  /** @type {Map<string, {kind: string, snippet: string, raw: string, at: number}>} */
  const attention = new Map();
  let collapsed = false;

  /* ------------------------------ tiles ------------------------------ */

  function tile(node, entry) {
    const page = store.pageOfNode(node.id);
    const isAlert = entry.kind === 'needs';
    const options = isAlert ? extractOptions(entry.raw) : [];
    const label = node.cli === 'claude' ? 'Claude Code' : 'Terminal';

    const head = el(
      'div',
      { class: 'tile-head' },
      el('span', { class: 'tile-badge', html: icon(node.cli === 'claude' ? 'claude' : 'shell') }),
      el(
        'div',
        { class: 'tile-meta' },
        el('div', { class: 'tile-cli', text: label }),
        el('div', { class: 'tile-name', text: node.callSign })
      ),
      el('div', { class: 'tile-where', text: page ? page.name : '' }),
      el('button', {
        class: 'tile-x',
        type: 'button',
        title: 'Dismiss',
        html: icon('x'),
        onclick: (event) => {
          event.stopPropagation();
          attention.delete(node.id);
          render();
        },
      })
    );

    const tileEl = el(
      'div',
      {
        class: `tile${isAlert ? ' is-alert' : ''}`,
        onclick: () => {
          attention.delete(node.id);
          ctx.canvas.focusAgent(node.id);
          render();
        },
      },
      head,
      el('div', { class: 'tile-sep' }),
      el('div', { class: 'tile-job', text: node.title || 'Session' }),
      el(
        'div',
        { class: `tile-body${isAlert ? ' is-alert' : ''}` },
        el('span', { class: 'tile-bullet' }),
        el('span', { text: entry.snippet })
      )
    );

    if (options.length) {
      tileEl.append(
        el(
          'div',
          { class: 'tile-options' },
          ...options.map((option) => el('span', { text: option }))
        )
      );
    }
    return tileEl;
  }

  function renderTiles() {
    for (const id of Array.from(attention.keys())) {
      if (!store.findNode(id)) attention.delete(id);
    }

    tilesEl.replaceChildren();
    const entries = Array.from(attention.entries());
    tilesEl.classList.toggle('is-collapsed', collapsed);

    if (entries.length) {
      if (entries.length > 1) {
        tilesEl.append(
          el('button', {
            class: 'tiles-clear',
            type: 'button',
            text: 'Clear all',
            onclick: () => {
              attention.clear();
              render();
            },
          })
        );
      }
      for (const [id, entry] of entries) {
        const found = store.findNode(id);
        if (found) tilesEl.append(tile(found.node, entry));
      }
    }

    const alerting = entries.some(([, entry]) => entry.kind === 'needs');
    const total = entries.length;
    chip.hidden = total === 0;
    chip.classList.toggle('has-alert', alerting);
    if (total === 1) {
      const found = store.findNode(entries[0][0]);
      chipLabel.textContent = `${found ? found.node.callSign : 'An agent'} is waiting`;
    } else {
      chipLabel.textContent = `${total} agents waiting`;
    }
  }

  function render() {
    renderTiles();
  }

  /* ------------------------------ events ----------------------------- */

  store.on('attention', ({ id, kind, snippet, raw }) => {
    attention.set(id, { kind, snippet, raw, at: Date.now() });
    collapsed = false;
    render();

    if (!store.state.settings.agentNotifications) return;
    if (document.hasFocus()) return;
    const found = store.findNode(id);
    if (!found || !('Notification' in window)) return;
    const title = `${found.node.callSign} · ${kind === 'needs' ? 'needs you' : 'finished'}`;
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

  chip.addEventListener('click', () => {
    collapsed = !collapsed;
    renderTiles();
  });

  render();

  return {
    render,
    clearAttention: () => {
      attention.clear();
      render();
    },
  };
}
