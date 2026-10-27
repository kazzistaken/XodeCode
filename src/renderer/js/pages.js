import { $, el } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { openOverlay, closeOverlay } from './overlay.js';

function miniPreview(page) {
  const mini = el('div', { class: 'map-mini' });
  if (!page.nodes.length) return mini;

  const minX = Math.min(...page.nodes.map((node) => node.x));
  const minY = Math.min(...page.nodes.map((node) => node.y));
  const maxX = Math.max(...page.nodes.map((node) => node.x + node.w));
  const maxY = Math.max(...page.nodes.map((node) => node.y + node.h));
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const pad = 6;

  for (const node of page.nodes) {
    const left = pad + ((node.x - minX) / spanX) * (100 - pad * 2);
    const top = pad + ((node.y - minY) / spanY) * (100 - pad * 2);
    const width = Math.max(6, (node.w / spanX) * (100 - pad * 2));
    const height = Math.max(6, (node.h / spanY) * (100 - pad * 2));
    mini.append(
      el('div', {
        class: `map-mini-dot${node.kind === 'terminal' ? ' is-terminal' : ''}`,
        style: {
          left: `${left}%`,
          top: `${top}%`,
          width: `${width}%`,
          height: `${height}%`,
        },
      })
    );
  }
  return mini;
}

export function initPages(ctx) {
  const tabs = $('#page-tabs');

  function beginRename(page, nameEl) {
    if (nameEl.querySelector('input')) return;
    const input = el('input', {
      class: 'tab-rename',
      value: page.name,
      spellcheck: 'false',
      'aria-label': 'Page name',
    });
    nameEl.replaceChildren(input);
    input.focus();
    input.select();

    const commit = () => {
      const value = input.value.trim();
      if (value && value !== page.name) store.renamePage(page.id, value);
      else renderTabs();
    };

    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        input.value = page.name;
        input.blur();
      }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    input.addEventListener('dblclick', (event) => event.stopPropagation());
  }

  function closePage(page) {
    if (store.pages.length <= 1) {
      ctx.toast('Keep at least one page.');
      return;
    }
    ctx.canvas.deletePage(page.id);
  }

  function renderTabs() {
    tabs.replaceChildren();
    store.pages.forEach((page, index) => {
      const active = index === store.activeIndex;
      const agents = page.nodes.filter((node) => node.kind === 'terminal').length;
      const nameEl = el('span', { class: 'tab-name', text: page.name });

      tabs.append(
        el(
          'div',
          {
            class: `tab${active ? ' is-active' : ''}`,
            role: 'tab',
            tabindex: '0',
            'aria-selected': String(active),
            title: `${page.name} — double-click to rename`,
            onclick: () => store.setActivePage(index),
            ondblclick: (event) => {
              event.preventDefault();
              beginRename(page, nameEl);
            },
            onkeydown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                store.setActivePage(index);
              }
            },
          },
          el('span', { class: 'tab-num', text: String(index + 1).padStart(2, '0') }),
          nameEl,
          agents
            ? el('span', {
                class: 'tab-badge',
                text: String(agents),
                title: `${agents} agent${agents === 1 ? '' : 's'} on this page`,
              })
            : null,
          el('button', {
            class: 'tab-close',
            type: 'button',
            title: 'Close page',
            'aria-label': `Close ${page.name}`,
            html: icon('x'),
            onclick: (event) => {
              event.stopPropagation();
              closePage(page);
            },
          })
        )
      );
    });

    tabs.append(
      el('button', {
        class: 'tab-add',
        type: 'button',
        title: 'New page',
        'aria-label': 'New page',
        html: icon('plus'),
        onclick: () => {
          const page = ctx.canvas.createPage();
          ctx.pickPageWorkspace?.(page.id);
        },
      })
    );
  }

  function openMap() {
    const grid = el('div', { class: 'map-grid' });

    for (const [index, page] of store.pages.entries()) {
      const agents = page.nodes.filter((node) => node.kind === 'terminal').length;
      const nameInput = el('input', {
        class: 'map-name',
        value: page.name,
        spellcheck: 'false',
        'aria-label': 'Page name',
        onchange: () => store.renamePage(page.id, nameInput.value),
        onclick: (event) => event.stopPropagation(),
      });

      grid.append(
        el(
          'button',
          {
            class: `map-card${index === store.activeIndex ? ' is-active' : ''}`,
            type: 'button',
            onclick: () => {
              store.setActivePage(index);
              closeOverlay();
            },
          },
          el(
            'div',
            { class: 'map-card-top' },
            el('span', { class: 'map-num', text: String(index + 1).padStart(2, '0') }),
            nameInput
          ),
          miniPreview(page),
          el('div', {
            class: 'map-foot',
            text: `${page.nodes.length} window${page.nodes.length === 1 ? '' : 's'} · ${agents} agent${
              agents === 1 ? '' : 's'
            }`,
          })
        )
      );
    }

    const sheet = el(
      'div',
      { class: 'map-sheet' },
      el(
        'div',
        { class: 'map-head' },
        el('h3', { text: 'Map' }),
        el('span', { text: 'Click a page to travel there' }),
        el('button', {
          class: 'sheet-close',
          type: 'button',
          title: 'Close',
          html: icon('x'),
          style: { marginLeft: 'auto' },
          onclick: () => closeOverlay(),
        })
      ),
      grid
    );

    openOverlay(sheet);
  }

  store.on('page', () => renderTabs());
  store.on('nodes', () => renderTabs());

  renderTabs();

  return { openMap, renderTabs };
}
