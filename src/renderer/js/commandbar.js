import { $ } from './util.js';

/**
 * The Director prompt. Just a text box: type or dictate, press Enter, and the
 * Director decides what to do. There is no command palette — spawning agents
 * and organizing the canvas are things you ask for in words.
 */
export function initCommandBar(ctx) {
  const input = $('#cb-input');

  function doIt(text) {
    if (!text) return;
    // Simple app commands run instantly; everything else goes to the Director.
    let quick = null;
    try {
      quick = ctx.tryQuick?.(text);
    } catch (error) {
      console.warn('[quick] failed', error);
    }
    if (quick) {
      ctx.director.noteQuick(text, quick);
      reset();
      return;
    }
    if (!ctx.director.send(text)) {
      ctx.toast('The Director could not take that — try again in a moment.', 'warn');
      return;
    }
    reset();
  }

  function reset() {
    input.value = '';
    autosize();
    // Keep focus so the next request can be typed straight away.
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, Math.max(22, input.scrollHeight))}px`;
  }

  input.addEventListener('input', autosize);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      doIt(input.value.trim());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      input.blur();
    }
  });

  return {
    focus: () => {
      input.focus();
      input.select();
    },
    doIt,
    reset,
  };
}
