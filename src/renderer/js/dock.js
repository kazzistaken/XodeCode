import { $, el, truncate } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';

/**
 * The dock — closed apps, bottom-left, level with the prompt bar.
 *
 * Closing a window (or clearing the canvas) sends it here instead of killing
 * it: it shrinks and flies into its kind's icon (see Canvas.parkNodes). One
 * icon per kind of app, with a count when several are waiting. Hovering an
 * icon opens a list of its windows; hovering a row shows the window as it
 * was, right on the canvas where it sat, clicking brings it back, and the ×
 * on a row closes it for good. Clicking the icon itself restores the newest.
 */

const GROUP_ORDER = ['agent', 'terminal', 'browser', 'music', 'board', 'note'];
const GROUP_LABEL = {
  agent: 'Claude agents',
  terminal: 'Terminals',
  browser: 'Browsers',
  music: 'Music',
  board: 'Task boards',
  note: 'Notes',
};
// The same icons the windows show in their title bars.
const GROUP_ICON = { agent: 'claude', terminal: 'shell', browser: 'globe', music: 'sound', board: 'summarizer', note: 'note' };

/** Windows still flying into the dock: their icon waits until they land. */
const arriving = new Set();

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function groupOf(node) {
  if (node.kind === 'terminal') return node.cli === 'claude' ? 'agent' : 'terminal';
  return GROUP_ORDER.includes(node.kind) ? node.kind : 'note';
}

/** A window's logo: its kind's icon, or a browser's site icon once it loads. */
function logoFor(node) {
  const group = groupOf(node);
  const holder = el('span', { class: `dock-logo is-${group}`, html: icon(GROUP_ICON[group]) });
  const host = group === 'browser' ? hostOf(node.payload?.url) : '';
  if (host) {
    const img = new Image();
    img.className = 'dock-favicon';
    img.alt = '';
    img.onload = () => {
      // Sites without an icon get a tiny generic one from the service; skip it.
      if (img.naturalWidth <= 16) return;
      holder.classList.add('is-site');
      holder.replaceChildren(img);
    };
    img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  }
  return holder;
}

function nameFor(node) {
  if (node.kind === 'browser') return hostOf(node.payload?.url) || 'Browser';
  return node.callSign || GROUP_LABEL[groupOf(node)];
}

function detailFor(node) {
  if (node.kind === 'browser') return node.title || node.payload?.url || '';
  if (node.kind === 'note') return (node.payload?.text || '').split('\n')[0];
  return node.title || '';
}

function statusOf(node) {
  return node.status === 'working' || node.status === 'needs' ? node.status : '';
}

/** Mark windows that are about to fly in, so their icon waits for them. */
export function dockArriving(ids) {
  for (const id of ids) arriving.add(id);
}

/** A window finished flying in: show its icon, with a small bump. */
export function dockLanded(id) {
  arriving.delete(id);
  const tile = document.querySelector(`#dock .dock-tile[data-ids~="${id}"]`);
  if (!tile) return;
  const ids = tile.dataset.ids.split(' ');
  if (ids.some((other) => arriving.has(other))) return;
  tile.classList.remove('is-waiting', 'is-bump');
  void tile.offsetWidth;
  tile.classList.add('is-bump');
}

/** Where a window should fly to: the centre and size of its kind's icon. */
export function dockTargetFor(node) {
  const tile = document.querySelector(`#dock .dock-stack[data-group="${groupOf(node)}"] .dock-tile`);
  const rect = (tile || $('#dock'))?.getBoundingClientRect();
  if (!rect || !rect.width) return { x: 40, y: window.innerHeight - 40, size: 36 };
  // A waiting icon is drawn scaled down; aim for its full size.
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, size: tile?.offsetWidth || 36 };
}

export function initDock(ctx) {
  const dock = $('#dock');
  const ghost = el('div', { class: 'dock-ghost', 'aria-hidden': 'true' });
  document.body.append(ghost);
  let hideTimer = null;
  let showTimer = null;
  let shownId = null;

  /* ------------------------------ preview ------------------------------ */

  /** The window as it was, drawn on the canvas where it sat. */
  function showPreview(node) {
    clearTimeout(hideTimer);
    shownId = node.id;
    const shot = ctx.canvas.dockPreview(node.id);
    const vp = store.page.viewport;
    let x = node.x * vp.scale + vp.x;
    let y = node.y * vp.scale + vp.y;
    let w = node.w * vp.scale;
    let h = node.h * vp.scale;
    const fullyOnScreen = x >= 0 && y >= 0 && x + w <= window.innerWidth && y + h <= window.innerHeight;
    if (!fullyOnScreen || w < 160) {
      // Off screen (or tiny when zoomed out): show it centred instead.
      const fit = Math.min((window.innerWidth * 0.7) / node.w, (window.innerHeight * 0.7) / node.h, 1);
      w = node.w * fit;
      h = node.h * fit;
      x = (window.innerWidth - w) / 2;
      y = (window.innerHeight - h) / 2;
    }
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
    ghost.style.width = `${w}px`;
    ghost.style.height = `${h}px`;
    ghost.style.backgroundImage = shot?.src ? `url("${shot.src}")` : 'none';
    ghost.replaceChildren(
      ...[
        shot?.src
          ? null
          : el('pre', {
              class: 'dock-ghost-text',
              text: shot?.text || detailFor(node) || node.payload?.url || 'Nothing to show yet.',
            }),
      ].filter(Boolean)
    );
    ghost.classList.add('is-visible');
  }

  function hidePreview() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      shownId = null;
      ghost.classList.remove('is-visible');
    }, 60);
  }

  function queuePreview(node, row) {
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      if (row.matches(':hover') && shownId !== node.id) showPreview(node);
    }, 120);
  }

  /* ------------------------------ restore ------------------------------ */

  function restore(node, from) {
    hidePreview();
    const rect = from.getBoundingClientRect();
    ctx.canvas.restoreNode(node.id, {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      size: Math.min(rect.width, rect.height),
    });
  }

  /* ------------------------------- rows -------------------------------- */

  function row(node, tileEl) {
    const status = statusOf(node);
    const detail = detailFor(node);
    const rowEl = el(
      'div',
      {
        class: 'dock-row',
        role: 'button',
        tabindex: '0',
        title: `Open ${nameFor(node)}`,
        onclick: () => restore(node, tileEl),
        onkeydown: (event) => {
          if (event.key === 'Enter') restore(node, tileEl);
        },
        onpointerenter: () => queuePreview(node, rowEl),
        onpointerleave: hidePreview,
      },
      logoFor(node),
      el(
        'span',
        { class: 'dock-row-text' },
        el('span', { class: 'dock-row-name', text: nameFor(node) }),
        detail ? el('span', { class: 'dock-row-detail', text: truncate(detail, 80) }) : null
      ),
      status ? el('span', { class: `dock-row-status is-${status}`, title: status === 'needs' ? 'Needs you' : 'Working' }) : null,
      el('button', {
        class: 'dock-row-x',
        type: 'button',
        title: 'Close for good',
        'aria-label': `Close ${nameFor(node)} for good`,
        html: icon('x'),
        onclick: (event) => {
          event.stopPropagation();
          hidePreview();
          ctx.canvas.removeNode(node.id);
        },
      })
    );
    return rowEl;
  }

  /* ------------------------------ stacks ------------------------------- */

  function stack(group, nodes) {
    const newest = nodes[nodes.length - 1];
    const waiting = nodes.every((node) => arriving.has(node.id));
    const needs = nodes.some((node) => node.status === 'needs');
    const working = nodes.some((node) => node.status === 'working');

    const tileEl = el(
      'button',
      {
        class: `dock-tile${waiting ? ' is-waiting' : ''}`,
        type: 'button',
        'data-ids': nodes.map((node) => node.id).join(' '),
        'aria-label': `Open ${nameFor(newest)}`,
      },
      logoFor(newest),
      nodes.length > 1 ? el('span', { class: 'dock-count', text: String(nodes.length) }) : null,
      needs || working ? el('span', { class: `dock-busy${needs ? ' is-needs' : ''}` }) : null
    );
    tileEl.addEventListener('click', () => restore(newest, tileEl));

    // Newest first in the list, like the order they were closed in reverse.
    const tray = el(
      'div',
      { class: 'dock-tray', role: 'menu' },
      el(
        'div',
        { class: 'dock-tray-head' },
        el('span', { text: GROUP_LABEL[group] }),
        el('span', { class: 'dock-tray-count', text: String(nodes.length) })
      ),
      el('div', { class: 'dock-tray-list' }, ...[...nodes].reverse().map((node) => row(node, tileEl)))
    );

    return el('div', { class: 'dock-stack', 'data-group': group }, tileEl, tray);
  }

  function render() {
    const parked = store.page.nodes.filter((node) => node.parked);
    const groups = new Map();
    for (const node of parked) {
      const key = groupOf(node);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(node);
    }
    const stacks = GROUP_ORDER.filter((key) => groups.has(key)).map((key) => stack(key, groups.get(key)));
    dock.replaceChildren(...stacks);
    dock.classList.toggle('is-empty', !parked.length);
    if (!parked.length) hidePreview();
  }

  store.on('dock', render);
  store.on('page', render);
  store.on('nodes', render);
  store.on('status', (node) => {
    if (node?.parked) render();
  });
  render();
  return { render, el: dock };
}
