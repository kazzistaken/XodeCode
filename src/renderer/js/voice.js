import { $ } from './util.js';
import { store } from './store.js';

/**
 * Dictation into the prompt box you were using: an agent's chat box, the
 * Director sheet's composer, or the "Ask the Director" bar (the default).
 *
 * By default it uses Windows' own speech engine through a small helper
 * (scripts/xode-speech.cs) with no Windows UI: the words appear live in the
 * box as you speak, and the finished phrase (with punctuation) replaces them
 * when you pause. Settings can switch to Windows voice typing (Win+H), which
 * shows the Windows panel instead.
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

  // The box's text before the phrase being spoken, while one is in progress.
  let phraseBase = null;

  function joined(base, text) {
    let clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return base;
    // Start of the prompt or a new sentence: capitalise the first letter.
    if (!base || /[.!?]$/.test(base)) clean = clean[0].toUpperCase() + clean.slice(1);
    return base ? `${base} ${clean}` : clean;
  }

  /** Live words while speaking: shown in the box, replaced by the final phrase. */
  function partial(text) {
    const input = target();
    if (phraseBase === null) phraseBase = input.value.trimEnd();
    show(input, joined(phraseBase, text));
  }

  function append(text) {
    const input = target();
    const base = phraseBase !== null ? phraseBase : input.value.trimEnd();
    phraseBase = null;
    show(input, joined(base, text));
  }

  function show(input, value) {
    input.value = value;
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

  const useWindows = () => store.state.settings.dictation === 'windows';

  // Typing yourself keeps whatever is in the box; the next phrase starts after it.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.isTrusted && event.target === target()) phraseBase = null;
    },
    true
  );

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
    phraseBase = null;
    setListening(false);
  }

  // Keep the prompt focused: pressing the mic must not move focus away from it.
  button.addEventListener('pointerdown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    if (listening) stop();
    else start();
  });

  window.api.voice.onText((text) => append(text));
  window.api.voice.onPartial?.((text) => partial(text));
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
