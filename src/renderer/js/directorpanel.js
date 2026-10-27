import { $, el } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { renderRich } from './richtext.js';
import { teamTree } from './hierarchy.js';

/**
 * The Director, shown as chat.
 *
 * - A compact panel in the bottom-right corner with the last few exchanges.
 * - A full transcript sheet (Ctrl+Shift+D) that looks like Claude Desktop's
 *   conversation view, with its own composer.
 *
 * Both render the same structured transcript from director.js.
 */

const STATUS_LABEL = { starting: 'starting…', working: 'working…', idle: 'ready', dead: 'offline' };

const MODEL_LABEL = {
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-fable-5-1': 'Fable 5.1',
};

function directorModelLabel() {
  const settings = store.state.settings;
  const model = MODEL_LABEL[settings.directorModel] || settings.directorModel || 'Sonnet 5.5';
  return `${model} · ${settings.directorEffort || 'low'}`;
}

/** Group consecutive tool calls so a busy turn reads as one line of chips. */
function groupEntries(entries) {
  const groups = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (entry.role === 'tool' && last && last.role === 'tools') {
      last.items.push(entry);
    } else if (entry.role === 'tool') {
      groups.push({ role: 'tools', items: [entry] });
    } else {
      groups.push(entry);
    }
  }
  return groups;
}

function toolChips(group) {
  const actions = group.items.flatMap((item) =>
    item.text === 'run' && item.detail ? item.detail.split(' · ') : [item.detail ? `${item.text} ${item.detail}` : item.text]
  );
  return el(
    'div',
    { class: 'dx-tools' },
    ...actions.map((action) => el('span', { class: 'dx-chip', text: action }))
  );
}

/** Render one transcript entry (or tool group) as a Claude-style row. */
export function renderEntry(entry) {
  if (entry.role === 'tools') return toolChips(entry);
  if (entry.role === 'user') {
    return el('div', { class: 'dx-row is-user' }, el('div', { class: 'dx-bubble', text: entry.text }));
  }
  if (entry.role === 'error') {
    return el('div', { class: 'dx-row is-error' }, el('div', { class: 'dx-error', text: entry.text }));
  }
  const body = el('div', { class: 'dx-text' });
  body.innerHTML = renderRich(entry.text);
  return el(
    'div',
    { class: `dx-row is-assistant${entry.quick ? ' is-quick' : ''}` },
    el('span', { class: 'dx-mark', html: icon('claude') }),
    body
  );
}

/** Thinking dots until the reply text arrives (the turn closes a beat later). */
function awaitingReply(entries, status) {
  if (status !== 'working') return false;
  const last = entries[entries.length - 1];
  return !last || last.role !== 'assistant';
}

function thinkingRow() {
  return el(
    'div',
    { class: 'dx-row is-assistant' },
    el('span', { class: 'dx-mark is-spinning', html: icon('claude') }),
    el('div', { class: 'dx-thinking' }, el('span'), el('span'), el('span'))
  );
}

/** Only re-render what changed; keep scroll pinned to the bottom when it was. */
function paint(container, entries, working) {
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  const rows = groupEntries(entries).map(renderEntry);
  if (working) rows.push(thinkingRow());
  container.replaceChildren(...rows);
  if (nearBottom || working) container.scrollTop = container.scrollHeight;
}

export function initDirectorPanel(ctx) {
  const panel = $('#director-panel');
  const dot = $('#director-panel-dot');
  const statusEl = $('#director-panel-status');
  const body = $('#director-panel-body');
  const logBtn = $('#director-panel-log');

  let lastCount = -1;
  let lastStatus = '';
  let collapseTimer = null;

  // Fold down to just the header a few seconds after the Director goes quiet,
  // so the panel never sits on top of tiled windows. Hover opens it again.
  function scheduleCollapse(status) {
    clearTimeout(collapseTimer);
    if (status === 'working' || status === 'starting') {
      panel.classList.remove('is-collapsed');
      return;
    }
    collapseTimer = setTimeout(() => {
      if (!panel.matches(':hover')) panel.classList.add('is-collapsed');
    }, 7000);
  }
  panel.addEventListener('pointerenter', () => {
    clearTimeout(collapseTimer);
    panel.classList.remove('is-collapsed');
  });
  panel.addEventListener('pointerleave', () => scheduleCollapse(ctx.director.status().status));

  function setStatus(status) {
    const next = status || 'idle';
    dot.dataset.status = next;
    statusEl.textContent = next === 'idle' ? directorModelLabel() : STATUS_LABEL[next] || next;
    panel.dataset.status = next;
  }

  ctx.director.subscribe((state) => {
    setStatus(state.status);
    const recent = state.transcript.slice(-8);
    const working = awaitingReply(state.transcript, state.status);
    if (state.transcript.length === lastCount && state.status === lastStatus) return;
    lastCount = state.transcript.length;
    lastStatus = state.status;
    panel.classList.remove('is-collapsed');
    scheduleCollapse(state.status);
    panel.classList.toggle('is-empty', !recent.length && !working);
    if (!recent.length && !working) {
      body.replaceChildren(
        el('div', { class: 'dx-empty', text: 'Ask the Director to open, close or arrange apps, or to start Claude sessions.' })
      );
      return;
    }
    paint(body, recent, working);
    // A fresh reply nudges the panel so it is noticed without being loud.
    if (!working && recent[recent.length - 1]?.role === 'assistant') {
      panel.classList.remove('is-pulse');
      void panel.offsetWidth;
      panel.classList.add('is-pulse');
    }
  });

  store.on('settings', () => setStatus(ctx.director.status().status));
  logBtn?.addEventListener('click', () => panel.dispatchEvent(new CustomEvent('open-log')));

  return { setStatus, el: panel };
}

/**
 * Collapsible org tree: Director > each team's lead > its workers. Only
 * jointed teams appear; standalone sessions are outside the hierarchy.
 */
function buildTeamTree(ctx, close) {
  const list = el('div', { class: 'dx-tree-list' });
  const count = el('span', { class: 'dx-tree-count' });
  const toggle = el(
    'button',
    { class: 'dx-tree-toggle', type: 'button', 'aria-expanded': 'true' },
    el('span', { class: 'dx-tree-chev', html: icon('chevronDown') }),
    el('span', { text: 'Teams' }),
    count
  );
  const root = el('div', { class: 'dx-tree' }, toggle, list);
  toggle.addEventListener('click', () => {
    const open = root.classList.toggle('is-collapsed') === false;
    toggle.setAttribute('aria-expanded', String(open));
  });

  const row = (node, rank, color) => {
    const report = node.lastReport;
    const button = el(
      'button',
      {
        class: `dx-tree-row is-${rank}`,
        type: 'button',
        style: { '--joint-color': color },
        title: `Go to ${node.callSign}`,
        onclick: () => {
          ctx.canvas.focusAgent(node.id);
          close();
        },
      },
      el('span', { class: `dx-tree-dot is-${node.status || 'idle'}` }),
      el('b', { text: node.callSign }),
      el('span', { class: 'dx-tree-title', text: node.title || '' }),
      el('span', { class: 'dx-tree-rank', text: rank === 'lead' ? 'Lead' : 'Worker' })
    );
    if (!report) return button;
    return el(
      'div',
      { class: 'dx-tree-item' },
      button,
      el(
        'div',
        { class: `dx-tree-report is-${report.status}`, title: report.text },
        el('b', { text: report.status }),
        el('span', { text: report.text })
      )
    );
  };

  function paint() {
    const teams = teamTree();
    root.hidden = !teams.length;
    count.textContent = String(teams.length);
    list.replaceChildren(
      ...teams.map(({ joint, lead, workers }) => {
        const color = joint.color || '#cfcfcf';
        return el(
          'div',
          { class: 'dx-team', style: { '--joint-color': color } },
          el('div', { class: 'dx-team-name', text: joint.name }),
          row(lead, 'lead', color),
          el('div', { class: 'dx-team-workers' }, ...workers.map((node) => row(node, 'worker', color)))
        );
      })
    );
  }

  paint();
  const offTeams = store.on('teams', paint);
  const offNodes = store.on('nodes', paint);
  return { el: root, destroy: () => (offTeams(), offNodes()) };
}

/** The full Director conversation, styled like Claude Desktop's chat. */
export function buildDirectorSheet(ctx, close) {
  const log = el('div', { class: 'dx-log' });
  const column = el('div', { class: 'dx-column' }, log);
  const scroller = el('div', { class: 'dx-scroll' }, column);

  const input = el('textarea', {
    class: 'dx-input',
    rows: '1',
    placeholder: 'Reply to the Director…',
    spellcheck: 'false',
  });
  const sendBtn = el('button', {
    class: 'dx-send',
    type: 'button',
    title: 'Send',
    'aria-label': 'Send',
    html: icon('arrowUp'),
  });
  const modelTag = el('span', { class: 'dx-model', text: directorModelLabel() });
  const composer = el(
    'div',
    { class: 'dx-composer' },
    input,
    el('div', { class: 'dx-composer-bar' }, modelTag, sendBtn)
  );

  const tree = buildTeamTree(ctx, () => close());
  const statusDot = el('span', { class: 'director-panel-dot' });
  const statusText = el('span', { class: 'dx-status' });

  const sheet = el(
    'div',
    { class: 'log-sheet dx-sheet' },
    el(
      'div',
      { class: 'dx-head' },
      el('span', { class: 'dx-head-mark', html: icon('claude') }),
      el('div', { class: 'dx-head-titles' }, el('h3', { text: 'Director' }), statusText),
      statusDot,
      el('button', {
        class: 'dx-head-btn',
        type: 'button',
        title: 'Clear conversation',
        'aria-label': 'Clear conversation',
        html: icon('trash'),
        onclick: () => ctx.director.clear(),
      }),
      el('button', {
        class: 'dx-head-btn',
        type: 'button',
        title: 'Restart the Director',
        'aria-label': 'Restart the Director',
        html: icon('refresh'),
        onclick: () => ctx.director.restart(),
      }),
      el('button', {
        class: 'sheet-close',
        type: 'button',
        title: 'Close',
        html: icon('x'),
        onclick: () => close(),
      })
    ),
    tree.el,
    el('div', { class: 'dx-stage' }, scroller, el('div', { class: 'dx-column' }, composer))
  );

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(180, Math.max(24, input.scrollHeight))}px`;
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize();
    const quick = ctx.tryQuick?.(text);
    if (quick) ctx.director.noteQuick(text, quick);
    else ctx.director.send(text);
  }

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      close();
    }
  });
  sendBtn.addEventListener('click', submit);

  const unsubscribe = ctx.director.subscribe((state) => {
    statusDot.dataset.status = state.status;
    statusText.textContent =
      state.status === 'idle' ? `${directorModelLabel()} · ready` : STATUS_LABEL[state.status] || state.status;
    modelTag.textContent = directorModelLabel();
    if (!state.transcript.length && state.status !== 'working') {
      log.replaceChildren(
        el(
          'div',
          { class: 'dx-hello' },
          el('span', { class: 'dx-hello-mark', html: icon('claude') }),
          el('h2', { text: 'What should we set up?' }),
          el('p', {
            text: 'Open, close and arrange apps, or start Claude sessions — one at a time or as a jointed team.',
          })
        )
      );
      return;
    }
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    const rows = groupEntries(state.transcript).map(renderEntry);
    const waiting = awaitingReply(state.transcript, state.status);
    if (waiting) rows.push(thinkingRow());
    log.replaceChildren(...rows);
    if (nearBottom || waiting) scroller.scrollTop = scroller.scrollHeight;
  });

  return {
    el: sheet,
    focus: () => {
      scroller.scrollTop = scroller.scrollHeight;
      input.focus();
    },
    destroy: () => {
      unsubscribe();
      tree.destroy();
    },
  };
}
