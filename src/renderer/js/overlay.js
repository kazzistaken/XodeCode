import { $ } from './util.js';

let current = null;

export function openOverlay(content, onClose) {
  const root = $('#overlay');
  closeOverlay();
  root.replaceChildren(content);
  root.hidden = false;

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeOverlay();
    }
  };
  const onBackdrop = (event) => {
    if (event.target === root) closeOverlay();
  };

  root.addEventListener('pointerdown', onBackdrop);
  window.addEventListener('keydown', onKey, true);
  current = { onClose, onKey, onBackdrop };
}

export function closeOverlay() {
  const root = $('#overlay');
  if (!current) {
    root.hidden = true;
    root.replaceChildren();
    return;
  }
  const { onClose, onKey, onBackdrop } = current;
  current = null;
  root.removeEventListener('pointerdown', onBackdrop);
  window.removeEventListener('keydown', onKey, true);
  root.hidden = true;
  root.replaceChildren();
  onClose?.();
}

export function isOverlayOpen() {
  return Boolean(current);
}
