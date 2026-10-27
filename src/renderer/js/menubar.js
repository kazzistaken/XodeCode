import { $, el, MOD, SHIFT } from './util.js';
import { store } from './store.js';

/**
 * Classic menu bar for the app-level commands we took out of the prompt
 * bubble: new terminals, workspace, settings, map, director log and so on.
 */
export function initMenubar(ctx) {
  const bar = $('#menubar');
  if (!bar) return { close() {} };

  let menuEl = null;
  let anchor = null;

  function close() {
    menuEl?.remove();
    menuEl = null;
    anchor = null;
    for (const button of bar.querySelectorAll('.menu-btn.is-open')) {
      button.classList.remove('is-open');
    }
  }

  function open(button, items) {
    close();
    const menu = el('div', { class: 'menu', role: 'menu' });

    for (const item of items) {
      if (item.divider) {
        menu.append(el('div', { class: 'menu-sep' }));
        continue;
      }
      const row = el(
        'button',
        {
          class: `menu-item${item.checked ? ' is-checked' : ''}`,
          type: 'button',
          role: 'menuitem',
          disabled: item.disabled || undefined,
          onclick: () => {
            close();
            item.action?.();
          },
        },
        el('span', { class: 'menu-check', text: item.checked ? '✓' : '' }),
        el('span', { class: 'menu-text', text: item.label }),
        item.hint ? el('span', { class: 'menu-hint', text: item.hint }) : null
      );
      menu.append(row);
    }

    document.body.append(menu);
    const rect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8))}px`;
    menu.style.top = `${rect.bottom + 4}px`;

    button.classList.add('is-open');
    menuEl = menu;
    anchor = button;
  }

  const MENUS = [
    {
      label: 'File',
      items: () => [
        { label: 'New Claude agent terminal', hint: `${MOD} N`, action: () => ctx.spawnClaude() },
        { label: 'New plain terminal', hint: `${MOD} ${SHIFT} N`, action: () => ctx.spawnShell() },
        { label: 'New shell', hint: `${MOD} T`, action: () => ctx.spawnShell() },
        { label: 'Place image…', hint: 'I', action: () => ctx.pickImage() },
        { label: 'New browser', action: () => ctx.openBrowser() },
        { label: 'New music player', action: () => ctx.openMusic() },
        { label: 'New task board', action: () => ctx.openBoard() },
        { divider: true },
        { label: 'Choose workspace folder…', action: () => ctx.pickWorkspace() },
        { divider: true },
        {
          label: 'New page',
          action: () => {
            const page = ctx.canvas.createPage();
            ctx.pickPageWorkspace?.(page.id);
          },
        },
        {
          label: 'Close page',
          disabled: store.pages.length <= 1,
          action: () => ctx.canvas.deletePage(store.page.id),
        },
        { divider: true },
        { label: 'Settings…', hint: `${MOD} ,`, action: () => ctx.openSettings() },
        { label: 'Reload', hint: 'F5', action: () => window.api.win.reload() },
        { label: 'Quit', action: () => window.api.win.close() },
      ],
    },
    {
      label: 'Edit',
      items: () => [
        { label: 'Focus the Director prompt', hint: `${MOD} K`, action: () => ctx.focusPrompt() },
        { label: 'Open Director log', hint: `${MOD} ${SHIFT} D`, action: () => ctx.openDirectorLog() },
        { divider: true },
        { label: 'Tidy the canvas', action: () => ctx.canvas.tidy() },
        { label: 'Clear this page', action: () => ctx.clearPage() },
      ],
    },
    {
      label: 'View',
      items: () => [
        { label: 'Map…', hint: `${MOD} ${SHIFT} O`, action: () => ctx.openMap() },
        { label: 'Hierarchy…', hint: `${MOD} ${SHIFT} H`, action: () => ctx.openHierarchy() },
        { divider: true },
        {
          label: 'Zoom in',
          hint: `${MOD} +`,
          action: () => ctx.canvas.setZoom(store.page.viewport.scale * 1.15),
        },
        {
          label: 'Zoom out',
          hint: `${MOD} -`,
          action: () => ctx.canvas.setZoom(store.page.viewport.scale / 1.15),
        },
        { label: 'Reset zoom', hint: `${MOD} 0`, action: () => ctx.canvas.resetZoom() },
        { divider: true },
        { label: 'Theme: Graphite', checked: store.state.theme === 'nightglass', action: () => store.setTheme('nightglass') },
        { label: 'Theme: Slate', checked: store.state.theme === 'cupola', action: () => store.setTheme('cupola') },
        { label: 'Theme: Ash', checked: store.state.theme === 'ember', action: () => store.setTheme('ember') },
      ],
    },
    {
      label: 'Help',
      items: () => [
        { label: 'Keyboard shortcuts', action: () => ctx.openSettings('shortcuts') },
        { label: 'Open Director log', action: () => ctx.openDirectorLog() },
        { divider: true },
        {
          label: 'About XodeCode',
          action: () => ctx.toast(`XodeCode ${ctx.sysInfo?.version || '0.1.0'}`),
        },
      ],
    },
  ];

  for (const def of MENUS) {
    const button = el('button', { class: 'menu-btn', type: 'button', text: def.label });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (anchor === button) {
        close();
        return;
      }
      open(button, def.items());
    });
    button.addEventListener('pointerenter', () => {
      if (menuEl && anchor !== button) open(button, def.items());
    });
    bar.append(button);
  }

  window.addEventListener('pointerdown', (event) => {
    if (menuEl && !menuEl.contains(event.target) && !bar.contains(event.target)) close();
  });
  window.addEventListener('blur', close);
  store.on('page', close);

  return { close };
}
