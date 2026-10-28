import { el, timeAgo, truncate } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { buildNodeChrome } from './node-chrome.js';
import { registerNodeType } from './canvas.js';

/**
 * Shared context log node — every finished agent turn, newest first, read
 * from <workspace>/.xode/context-log.jsonl through the main process and kept
 * live by the 'context-log:updated' event. Read-only; all entry text is
 * rendered as plain text.
 */

const LIMIT = 500;

const workspaceNow = () => store.page?.workspace || store.state.workspace || '';
const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const tsOf = (entry) => Date.parse(entry.ts) || 0;
const agentOf = (entry) => entry.agentName || entry.agentId || 'agent';
const jointOf = (entry) => entry.joint?.name || '';

function entryMarkdown(entry) {
  const files = Array.isArray(entry.filesChanged) ? entry.filesChanged : [];
  return [
    `## ${agentOf(entry)} — ${new Date(entry.ts).toLocaleString()}`,
    `- model: ${entry.model || '—'}${entry.effort ? ` (${entry.effort})` : ''}`,
    `- team: ${jointOf(entry) || '—'}${entry.rank ? ` (${entry.rank})` : ''}`,
    `- status: ${entry.status || '—'}${entry.error ? ` — ${entry.error}` : ''}`,
    `- id: ${entry.id}`,
    '',
    '### Prompt',
    entry.prompt || '',
    '',
    '### Output',
    entry.output || '',
    '',
    '### Files changed',
    files.length ? files.map((f) => `- ${f}`).join('\n') : '(none)',
  ].join('\n');
}

function createContextLogView(meta, canvas) {
  const api = window.api?.contextLog;
  let entries = [];
  let workspace = '';
  let agentFilter = '';
  let jointFilter = '';
  let query = '';
  const open = new Set();

  const chrome = buildNodeChrome(meta, {
    brand: 'note',
    iconName: 'history',
    actions: [{ icon: 'x', title: 'Close log', danger: true, onClick: () => canvas.closeNode(meta.id) }],
  });
  chrome.titleEl.textContent = meta.callSign;
  chrome.body.classList.add('clog-body');

  const stop = (event) => event.stopPropagation();
  const agentSel = el('select', { class: 'clog-select', title: 'Filter by agent', onpointerdown: stop });
  const jointSel = el('select', { class: 'clog-select', title: 'Filter by team', onpointerdown: stop });
  const search = el('input', {
    class: 'clog-search',
    type: 'text',
    placeholder: 'Search…',
    spellcheck: 'false',
    onpointerdown: stop,
    onkeydown: stop,
  });
  const list = el('div', { class: 'clog-list' });
  chrome.body.append(el('div', { class: 'clog-bar' }, agentSel, jointSel, search), list);

  function fillSelect(select, label, values, current) {
    select.replaceChildren(
      el('option', { value: '', text: label }),
      ...values.map((v) => el('option', { value: v, text: v }))
    );
    select.value = current;
  }

  function copy(entry, button) {
    const text = entryMarkdown(entry);
    try {
      window.api.clipboard.writeText(text);
    } catch {
      navigator.clipboard?.writeText(text);
    }
    button.classList.add('is-done');
    setTimeout(() => button.classList.remove('is-done'), 900);
  }

  function section(label, text) {
    return [el('div', { class: 'clog-label', text: label }), el('div', { class: 'clog-text', text: text || '' })];
  }

  function card(entry) {
    const isOpen = open.has(entry.id);
    const files = Array.isArray(entry.filesChanged) ? entry.filesChanged : [];
    const copyBtn = el('button', {
      class: 'clog-btn',
      type: 'button',
      title: 'Copy entry as markdown',
      html: icon('compose'),
      onclick: (event) => {
        event.stopPropagation();
        copy(entry, copyBtn);
      },
    });
    const head = el(
      'div',
      {
        class: 'clog-head',
        onclick: () => {
          if (open.has(entry.id)) open.delete(entry.id);
          else open.add(entry.id);
          render();
        },
      },
      el('span', { class: 'clog-chev', html: icon(isOpen ? 'chevronDown' : 'chevronRight') }),
      el('span', { class: `clog-dot is-${entry.status || 'ok'}`, title: entry.status || '' }),
      el('span', { class: 'clog-agent', text: agentOf(entry) }),
      jointOf(entry) ? el('span', { class: 'clog-tag', text: jointOf(entry) }) : null,
      files.length ? el('span', { class: 'clog-tag', text: `${files.length} file${files.length === 1 ? '' : 's'}` }) : null,
      el('span', { class: 'clog-time', title: new Date(entry.ts).toLocaleString(), text: timeAgo(tsOf(entry)) }),
      copyBtn
    );
    const preview = isOpen ? null : el('div', { class: 'clog-preview', text: truncate(String(entry.output || entry.prompt || '').replace(/\s+/g, ' '), 140) });
    return el(
      'div',
      { class: `clog-card is-${entry.status || 'ok'}`, dataset: { id: entry.id } },
      head,
      preview,
      isOpen
        ? el(
            'div',
            { class: 'clog-detail' },
            el('div', {
              class: 'clog-model',
              text: [entry.model, entry.effort, entry.status, entry.error, entry.truncated ? 'truncated' : '']
                .filter(Boolean)
                .join(' · '),
            }),
            ...section('Prompt', entry.prompt),
            ...section('Output', entry.output),
            ...section('Files changed', files.length ? files.join('\n') : '(none)')
          )
        : null
    );
  }

  function matches(entry) {
    if (agentFilter && agentOf(entry) !== agentFilter) return false;
    if (jointFilter && jointOf(entry) !== jointFilter) return false;
    if (query) {
      const hay = `${agentOf(entry)} ${jointOf(entry)} ${entry.prompt || ''} ${entry.output || ''} ${(entry.filesChanged || []).join(' ')}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  }

  function render() {
    const agents = [...new Set(entries.map(agentOf))].sort();
    const joints = [...new Set(entries.map(jointOf).filter(Boolean))].sort();
    if (agentFilter && !agents.includes(agentFilter)) agentFilter = '';
    if (jointFilter && !joints.includes(jointFilter)) jointFilter = '';
    fillSelect(agentSel, 'All agents', agents, agentFilter);
    fillSelect(jointSel, 'All teams', joints, jointFilter);

    const shown = entries.filter(matches);
    chrome.subEl.textContent = api
      ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · live`
      : 'unavailable';
    list.replaceChildren(
      ...(shown.length
        ? shown.map(card)
        : [
            el('div', {
              class: 'clog-empty',
              text: !api ? 'Log unavailable.' : entries.length ? 'No entries match.' : 'No finished agent turns yet.',
            }),
          ])
    );
  }

  agentSel.addEventListener('change', () => {
    agentFilter = agentSel.value;
    render();
  });
  jointSel.addEventListener('change', () => {
    jointFilter = jointSel.value;
    render();
  });
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    render();
  });

  // `wanted` is the page's workspace ('' = main's default); `workspace` is
  // the folder main actually read, which live entries are matched against.
  let wanted = workspaceNow();
  async function load() {
    wanted = workspaceNow();
    if (api?.list) {
      try {
        // No page workspace: main falls back to the same default agents run in.
        const [rows, files] = await Promise.all([
          api.list({ workspace: wanted || undefined, limit: LIMIT }),
          wanted ? null : api.paths?.({}),
        ]);
        if (wanted !== workspaceNow()) return; // the page changed meanwhile
        workspace = wanted || String(files?.jsonl || '').replace(/[\\/]\.xode[\\/][^\\/]+$/, '');
        // Keep live entries that landed while the file was being read.
        const ids = new Set((rows || []).map((e) => e.id));
        const live = entries.filter((e) => !ids.has(e.id) && normPath(e.workspace) === normPath(workspace));
        entries = [...(rows || []), ...live].sort((a, b) => tsOf(b) - tsOf(a));
      } catch (error) {
        console.warn('[contextlog] list failed', error);
      }
    }
    render();
  }

  // Live: prepend entries for this workspace, deduped by id.
  const off = api?.onUpdated?.((entry) => {
    if (!entry?.id || normPath(entry.workspace) !== normPath(workspace)) return;
    if (entries.some((e) => e.id === entry.id)) return;
    entries.unshift(entry);
    render();
  });
  const offPage = store.on?.('page', () => {
    if (workspaceNow() !== wanted) load();
  });
  const tick = setInterval(() => {
    for (const node of list.querySelectorAll('.clog-time')) {
      const entry = entries.find((e) => e.id === node.closest('.clog-card')?.dataset.id);
      if (entry) node.textContent = timeAgo(tsOf(entry));
    }
  }, 30000);

  load();

  return {
    el: chrome.root,
    focus: () => {},
    syncTitles: () => {
      chrome.titleEl.textContent = meta.callSign;
    },
    refresh: load,
    resize: () => {},
    destroy: () => {
      off?.();
      offPage?.();
      clearInterval(tick);
    },
  };
}

registerNodeType('contextlog', createContextLogView);

/** One log window at a time: focus it if it's already open. */
export function openContextLog(canvas) {
  const existing = store.allNodes().find((node) => node.kind === 'contextlog');
  if (existing) {
    canvas.focusAgent?.(existing.id);
    return existing;
  }
  return canvas.createNode({
    kind: 'contextlog',
    w: 560,
    h: 520,
    callSign: 'Context log',
    title: 'Context log',
    payload: {},
  });
}
