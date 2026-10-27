import { $, el, truncate } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';

/**
 * The dock — closed apps, bottom-left.
 *
 * Closing a window (or clearing the canvas) sends it here instead of killing
 * it. Windows of the same kind stack into one rounded logo tile; hovering a
 * stack slides its tiles out, hovering a tile previews the window as it was
 * (a snapshot plus a ghost outline of where it sat), clicking brings it back,
 * and the × on a tile closes it for good.
 */

const GROUP_ORDER = ['agent', 'terminal', 'browser', 'music', 'board', 'note'];
const STEP = 52; // px between fanned-out tiles

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

function logoFor(node) {
  const group = groupOf(node);
  if (group === 'browser') {
    const host = hostOf(node.payload?.url);
    // The globe stays until a real site icon arrives (sites without one get a
    // tiny generic icon from the service, which we ignore).
    const holder = el('span', { class: 'dock-logo', html: icon('globe') });
    if (host) {
      const img = new Image();
      img.className = 'dock-favicon';
      img.alt = '';
      img.onload = () => {
        if (img.naturalWidth > 16) holder.replaceChildren(img);
      };
      img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
    }
    return holder;
  }
  const name = { agent: 'claude', terminal: 'shell', music: 'play', board: 'grid', note: 'note' }[group];
  return el('span', { class: 'dock-logo', html: icon(name) });
}

function labelFor(node) {
  if (node.kind === 'browser') return hostOf(node.payload?.url) || node.title || 'Browser';
  return [node.callSign, node.title].filter(Boolean).join(' — ');
}

export function initDock(ctx) {
  const dock = $('#dock');
  const preview = el('div', { class: 'dock-preview', 'aria-hidden': 'true' });
  const ghost = el('div', { class: 'dock-ghost', 'aria-hidden': 'true' });
  document.body.append(preview, ghost);
  let seen = new Set();
  let hideTimer = null;

  /* ------------------------------ preview ------------------------------ */

  function showPreview(node, tile) {
    clearTimeout(hideTimer);
    const shot = ctx.canvas.dockPreview(node.id);
    const body = shot?.src
      ? el('img', { class: 'dock-preview-shot', src: shot.src, alt: '' })
      : el('pre', {
          class: 'dock-preview-text',
          text:
            shot?.text ||
            (node.kind === 'note' ? node.payload?.text : '') ||
            node.payload?.url ||
            node.title ||
            'Nothing to show yet.',
        });
    preview.replaceChildren(
      el(
        'div',
        { class: 'dock-preview-head' },
        el('span', { class: `dock-preview-logo is-${groupOf(node)}` }, logoFor(node)),
        el('span', { class: 'dock-preview-title', text: truncate(labelFor(node), 60) })
      ),
      body,
      el('div', { class: 'dock-preview-hint', text: 'Click to open · × to close for good' })
    );

    // Sit the card beside the tile, kept on screen.
    const rect = tile.getBoundingClientRect();
    preview.classList.add('is-visible');
    const width = preview.offsetWidth;
    const height = preview.offsetHeight;
    const left = Math.min(window.innerWidth - width - 12, rect.right + 14);
    const top = Math.max(52, Math.min(window.innerHeight - height - 12, rect.top + rect.height / 2 - height / 2));
    preview.style.left = `${left}px`;
    preview.style.top = `${top}px`;

    // Ghost outline where the window sat on the canvas.
    const vp = store.page.viewport;
    const x = node.x * vp.scale + vp.x;
    const y = node.y * vp.scale + vp.y;
    const w = node.w * vp.scale;
    const h = node.h * vp.scale;
    const onScreen = x < window.innerWidth && y < window.innerHeight && x + w > 0 && y + h > 0;
    ghost.classList.toggle('is-visible', onScreen);
    if (onScreen) {
      ghost.style.left = `${x}px`;
      ghost.style.top = `${y}px`;
      ghost.style.width = `${w}px`;
      ghost.style.height = `${h}px`;
      ghost.style.backgroundImage = shot?.src ? `url("${shot.src}")` : 'none';
    }
  }

  function hidePreview() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      preview.classList.remove('is-visible');
      ghost.classList.remove('is-visible');
    }, 60);
  }

  /* ------------------------------- tiles ------------------------------- */

  function tile(node, index, count) {
    const close = el('button', {
      class: 'dock-x',
      type: 'button',
      title: 'Close for good',
      'aria-label': `Close ${labelFor(node)} for good`,
      html: icon('x'),
      onclick: (event) => {
        event.stopPropagation();
        hidePreview();
        ctx.canvas.removeNode(node.id);
      },
    });
    const button = el(
      'button',
      {
        class: `dock-tile is-${groupOf(node)}${seen.has(node.id) ? '' : ' is-new'}`,
        type: 'button',
        'aria-label': `Open ${labelFor(node)}`,
        style: { '--i': String(count - 1 - index) },
        onclick: () => {
          hidePreview();
          const rect = button.getBoundingClientRect();
          button.classList.add('is-opening');
          ctx.canvas.restoreNode(node.id, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        },
        onpointerenter: () => showPreview(node, button),
        onpointerleave: hidePreview,
      },
      logoFor(node),
      close
    );
    if (node.status === 'working') button.append(el('span', { class: 'dock-busy' }));
    else if (node.status === 'needs') button.append(el('span', { class: 'dock-busy is-needs' }));
    return button;
  }

  function render() {
    const parked = store.page.nodes.filter((node) => node.parked);
    const groups = new Map();
    for (const node of parked) {
      const key = groupOf(node);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(node);
    }
    const stacks = GROUP_ORDER.filter((key) => groups.has(key)).map((key) => {
      const nodes = groups.get(key);
      // Newest on top of the stack.
      const tiles = nodes.map((node, index) => tile(node, index, nodes.length));
      const stack = el(
        'div',
        {
          class: `dock-stack${nodes.length > 1 ? ' is-stacked' : ''}`,
          style: { '--count': String(nodes.length), '--step': `${STEP}px` },
        },
        ...tiles
      );
      if (nodes.length > 1) stack.append(el('span', { class: 'dock-count', text: String(nodes.length) }));
      return stack;
    });
    dock.replaceChildren(...stacks);
    dock.classList.toggle('is-empty', !parked.length);
    if (!parked.length) hidePreview();
    seen = new Set(parked.map((node) => node.id));
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
