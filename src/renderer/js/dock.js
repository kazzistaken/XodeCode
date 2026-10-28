import { $, el, truncate } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';

/**
 * The dock — closed apps, bottom-left.
 *
 * Closing a window (or clearing the canvas) sends it here instead of killing
 * it. Windows of the same kind stack into one rounded logo tile; hovering a
 * stack fans its tiles upward, hovering a tile shows the window as it was,
 * right on the canvas where it sat (or centred, if that spot is off screen),
 * clicking brings it back, and the × on a tile closes it for good.
 */

const GROUP_ORDER = ['agent', 'terminal', 'browser', 'music', 'board', 'note'];
const STEP = 48; // px between fanned-out tiles

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

/* App-icon artwork: a gradient squircle with a crisp glyph, one per kind. */
const ART = {
  // Claude agents: just the orange asterisk, no plate.
  agent: {
    plain: true,
    glyph:
      '<image href="../../assets/claude.png" x="7" y="7" width="30" height="30" />',
  },
  terminal: {
    from: '#3a3f4a',
    to: '#14161b',
    glyph:
      '<g fill="none" stroke="#7ee0a1" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 16.5 19.5 22l-7 5.5"/><path d="M23.5 29h8.5" stroke="#e8eaee"/></g>',
  },
  browser: {
    from: '#4aa3ff',
    to: '#2250d8',
    glyph:
      '<g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="22" cy="22" r="10.5"/><path d="M11.5 22h21M22 11.5c3.4 3.2 5 6.7 5 10.5s-1.6 7.3-5 10.5c-3.4-3.2-5-6.7-5-10.5s1.6-7.3 5-10.5z"/></g>',
  },
  music: {
    from: '#ff6b9a',
    to: '#c71f5f',
    glyph:
      '<g fill="#fff"><path d="M18 12.5 31 10v14.2a4 4 0 1 1-2.6-3.7V14.6l-8 1.5v11.6a4 4 0 1 1-2.6-3.7z"/></g>',
  },
  board: {
    from: '#8b7bff',
    to: '#4a37d6',
    glyph:
      '<g fill="#fff"><rect x="11.5" y="11.5" width="9.2" height="9.2" rx="2.4"/><rect x="23.3" y="11.5" width="9.2" height="9.2" rx="2.4" opacity=".7"/><rect x="11.5" y="23.3" width="9.2" height="9.2" rx="2.4" opacity=".7"/><rect x="23.3" y="23.3" width="9.2" height="9.2" rx="2.4"/></g>',
  },
  note: {
    from: '#ffd45e',
    to: '#e69a14',
    glyph:
      '<g stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none"><path d="M13 15.5h18M13 22h18M13 28.5h11"/></g>',
  },
};

let artId = 0;
function artSvg(group) {
  const art = ART[group] || ART.note;
  if (art.plain) return `<svg viewBox="0 0 44 44" aria-hidden="true">${art.glyph}</svg>`;
  const id = `dk${artId++}`;
  return (
    `<svg viewBox="0 0 44 44" aria-hidden="true"><defs>` +
    `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${art.from}"/><stop offset="1" stop-color="${art.to}"/></linearGradient>` +
    `<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` +
    `<rect width="44" height="44" rx="11" fill="url(#${id})" fill-opacity=".55"/>` +
    `<rect width="44" height="44" rx="11" fill="url(#${id}s)"/>` +
    `<rect x=".5" y=".5" width="43" height="43" rx="10.5" fill="none" stroke="#fff" stroke-opacity=".16"/>` +
    art.glyph +
    `</svg>`
  );
}

function logoFor(node) {
  const group = groupOf(node);
  const holder = el('span', {
    class: `dock-logo ${ART[group]?.plain ? 'is-plain' : 'is-art'}`,
    html: artSvg(group),
  });
  if (group === 'browser') {
    const host = hostOf(node.payload?.url);
    // The compass stays until a real site icon arrives (sites without one get a
    // tiny generic icon from the service, which we ignore).
    if (host) {
      const img = new Image();
      img.className = 'dock-favicon';
      img.alt = '';
      img.onload = () => {
        if (img.naturalWidth <= 16) return;
        holder.classList.remove('is-art');
        holder.classList.add('is-site');
        holder.replaceChildren(img);
      };
      img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
    }
  }
  return holder;
}

function labelFor(node) {
  if (node.kind === 'browser') return hostOf(node.payload?.url) || node.title || 'Browser';
  return [node.callSign, node.title].filter(Boolean).join(' — ');
}

export function initDock(ctx) {
  const dock = $('#dock');
  const ghost = el('div', { class: 'dock-ghost', 'aria-hidden': 'true' });
  document.body.append(ghost);
  let seen = new Set();
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
    const parts = [
      shot?.src
        ? null
        : el('pre', {
            class: 'dock-ghost-text',
            text:
              shot?.text ||
              (node.kind === 'note' ? node.payload?.text : '') ||
              node.payload?.url ||
              node.title ||
              'Nothing to show yet.',
          }),
      el(
        'div',
        { class: 'dock-ghost-label' },
        el('span', { class: `dock-preview-logo is-${groupOf(node)}` }, logoFor(node)),
        el('span', { text: truncate(labelFor(node), 60) }),
        el('i', { text: 'click to open · × closes for good' })
      ),
    ];
    ghost.replaceChildren(...parts.filter(Boolean));
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

  /** Wait for the fan-out to settle so only the tile under the pointer previews. */
  function queuePreview(node, button) {
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      if (button.matches(':hover') && shownId !== node.id) showPreview(node);
    }, 110);
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
        onpointerenter: () => queuePreview(node, button),
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
