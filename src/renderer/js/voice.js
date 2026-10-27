import { $ } from './util.js';

/**
 * Dictation for the Director prompt. The heavy lifting lives in the main
 * process (Windows offline speech); this just drives the mic button and
 * appends recognised phrases to the prompt.
 */
export function initVoice(ctx) {
  const button = $('#cb-mic');
  const input = $('#cb-input');
  if (!button || !input) return { toggle() {}, isListening: () => false };

  let listening = false;
  let starting = false;

  function setListening(value) {
    listening = value;
    button.classList.toggle('is-listening', value);
    button.setAttribute('aria-pressed', String(value));
    button.title = value ? 'Stop dictation' : 'Dictate';
  }

  function append(text) {
    let clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const current = input.value.trimEnd();
    // Start of the prompt or a new sentence: capitalise the first letter.
    if (!current || /[.!?]$/.test(current)) clean = clean[0].toUpperCase() + clean.slice(1);
    input.value = current ? `${current} ${clean}` : clean;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch {
      /* ignore */
    }
  }

  async function start() {
    if (starting || listening) return;
    starting = true;
    button.classList.add('is-busy');
    try {
      const result = await window.api.voice.start();
      if (result?.ok) setListening(true);
      else ctx.toast(result?.error || 'Voice input is unavailable.', 'warn');
    } catch (error) {
      ctx.toast(error?.message || 'Could not start voice input.', 'warn');
    } finally {
      starting = false;
      button.classList.remove('is-busy');
    }
  }

  async function stop() {
    try {
      await window.api.voice.stop();
    } catch {
      /* ignore */
    }
    setListening(false);
  }

  button.addEventListener('click', () => {
    if (listening) stop();
    else start();
  });

  window.api.voice.onText((text) => append(text));
  window.api.voice.onState((state) => {
    if (state === 'stopped') {
      setListening(false);
    } else if (state === 'error') {
      setListening(false);
      ctx.toast('Voice input stopped — check your microphone and Windows speech settings.', 'warn');
    }
  });

  return {
    toggle: () => (listening ? stop() : start()),
    isListening: () => listening,
  };
}
