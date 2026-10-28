import { $ } from './util.js';
import { store } from './store.js';

const HIDE_DELAY = 1500;
const FLASH_MS = 1200;

/**
 * The page bar stays out of sight until you reach for it: hover the handle
 * or the top edge, press Alt, or switch pages. It goes back up a moment after
 * you move away, but never while a menu is open or a page is being renamed.
 * "Always show the page bar" (View menu) pins it down.
 */
export function initTopbar() {
  const bar = $('#topbar');
  const handle = $('#bar-handle');
  const hotzone = $('#bar-hotzone');
  if (!bar || !handle) return { show() {}, flash() {} };

  let hideTimer = 0;
  let hovering = false;

  const busy = () =>
    !!document.querySelector('.menu') || !!bar.querySelector('.tab-rename') || bar.contains(document.activeElement);

  function show() {
    clearTimeout(hideTimer);
    document.body.classList.add('bar-shown');
  }

  function scheduleHide(delay = HIDE_DELAY) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function tryHide() {
      if (hovering) return;
      // A menu or a rename keeps it down; check again shortly.
      if (busy()) {
        hideTimer = setTimeout(tryHide, HIDE_DELAY);
        return;
      }
      document.body.classList.remove('bar-shown');
    }, delay);
  }

  /** Show the bar briefly (after switching pages, so you can see where you are). */
  function flash() {
    if (hovering) return;
    show();
    scheduleHide(FLASH_MS);
  }

  for (const target of [handle, hotzone]) {
    target.addEventListener('pointerenter', show);
    target.addEventListener('pointerleave', () => scheduleHide());
  }
  handle.addEventListener('click', () => {
    show();
    bar.querySelector('.tab.is-active')?.focus({ preventScroll: true });
  });
  bar.addEventListener('pointerenter', () => {
    hovering = true;
    show();
  });
  bar.addEventListener('pointerleave', () => {
    hovering = false;
    scheduleHide();
  });
  bar.addEventListener('focusout', () => {
    if (!hovering) scheduleHide();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!bar.contains(event.target) && !event.target.closest?.('.menu') && event.target !== handle) {
      hovering = false;
      scheduleHide();
    }
  });

  // Alt on its own (pressed and released with nothing else) toggles the bar.
  let altAlone = false;
  window.addEventListener('keydown', (event) => {
    altAlone = event.key === 'Alt' && !event.ctrlKey && !event.shiftKey && !event.metaKey;
  });
  window.addEventListener('keyup', (event) => {
    if (event.key !== 'Alt' || !altAlone) return;
    altAlone = false;
    event.preventDefault();
    if (document.body.classList.contains('bar-shown')) {
      document.body.classList.remove('bar-shown');
    } else {
      show();
      scheduleHide(2400);
    }
  });

  const applyPin = () => document.body.classList.toggle('bar-pinned', !!store.state.settings.pinTopbar);
  applyPin();
  store.on('settings', applyPin);

  let lastPage = store.state.activePage;
  store.on('page', (page) => {
    if (page === lastPage) return;
    lastPage = page;
    flash();
  });

  return { show, flash };
}

/** Mark the handle when an agent somewhere needs you. */
export function setBarAttention(on) {
  $('#bar-handle')?.classList.toggle('has-attention', !!on);
}
