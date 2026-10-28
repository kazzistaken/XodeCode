import { $ } from './util.js';
import { store } from './store.js';

/**
 * Dictation into the prompt box you were using: an agent's chat box, the
 * Director sheet's composer, or the "Ask the Director" bar (the default).
 *
 * By default the mic opens Windows voice typing (Win+H), which types straight
 * into the focused box and is far more accurate. Settings can switch to the
 * built-in engine (scripts/dictate.ps1), whose phrases are appended here.
 */

// Prompt boxes dictation may type into.
const PROMPTS = '#cb-input, .cc-input, .dx-input';

export function initVoice(ctx) {
  const button = $('#cb-mic');
  const barInput = $('#cb-input');
  if (!button || !barInput) return { toggle() {}, isListening: () => false };

  let listening = false;
  let starting = false;
  // The prompt box focused most recently (clicking the mic steals focus).
  let lastPrompt = barInput;
  let marked = null;

  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches(PROMPTS)) {
      lastPrompt = target;
      if (listening) mark(target);
    }
  });

  function target() {
    return lastPrompt && lastPrompt.isConnected ? lastPrompt : barInput;
  }

  /** Show "Listening…" in the box the words will go to. */
  function mark(input) {
    unmark();
    marked = input;
    input.dataset.placeholder = input.placeholder;
    input.placeholder = 'Listening… speak now';
    input.classList.add('is-dictating');
  }

  function unmark() {
    if (!marked) return;
    marked.placeholder = marked.dataset.placeholder ?? marked.placeholder;
    delete marked.dataset.placeholder;
    marked.classList.remove('is-dictating');
    marked = null;
  }

  function setListening(value) {
    listening = value;
    button.classList.toggle('is-listening', value);
    button.setAttribute('aria-pressed', String(value));
    button.title = value ? 'Stop dictation' : 'Dictate';
    if (value) mark(target());
    else unmark();
  }

  function append(text) {
    let clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const input = target();
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

  /** Focus the prompt box and open (or close) Windows voice typing. */
  async function voiceTyping() {
    const input = target();
    input.focus();
    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch {
      /* ignore */
    }
    button.classList.add('is-listening');
    setTimeout(() => button.classList.remove('is-listening'), 1600);
    try {
      const result = await window.api.voice.typing();
      if (!result?.ok) ctx.toast(result?.error || 'Could not open Windows voice typing.', 'warn');
    } catch (error) {
      ctx.toast(error?.message || 'Could not open Windows voice typing.', 'warn');
    }
  }

  const useWindows = () => store.state.settings.dictation !== 'builtin';

  async function start() {
    if (useWindows()) return voiceTyping();
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

  // Keep the prompt focused: pressing the mic must not move focus away from it.
  button.addEventListener('pointerdown', (event) => event.preventDefault());
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
