import { store } from './store.js';

/**
 * The Director is a persistent headless Claude Code session (see main.js).
 * The prompt bubble talks to it; it drives the app through two native tools,
 * `canvas` and `run`, served by bin/xode-mcp.js.
 *
 * Every prompt is sent with a compact snapshot of the canvas in front of it,
 * so the Director already knows what is open and can act in a single turn.
 * Its transcript is kept as structured entries and saved to disk.
 */

const TRANSCRIPT_ID = 'director';
const MAX_ENTRIES = 240;

let started = false;
let status = 'starting';
let pending = 0;
let lastLine = '';
let deaths = 0;
let saveTimer = null;
let contextProvider = null;
let freshContext = true;
let sendChain = Promise.resolve();
/** @type {Array<{role: string, text: string, detail?: string, at: number}>} */
let transcript = [];
const listeners = new Set();

function snapshot() {
  return { status, lastLine, pending, transcript };
}

function emit() {
  const state = snapshot();
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      console.error('[director] listener failed', error);
    }
  }
}

function setStatus(next) {
  if (status === next) return;
  status = next;
  emit();
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.api.chats
      .save({ id: TRANSCRIPT_ID, title: 'Director', messages: transcript.slice(-MAX_ENTRIES) })
      .catch(() => {});
  }, 400);
}

function push(entry) {
  transcript.push({ ...entry, at: Date.now() });
  if (transcript.length > MAX_ENTRIES) transcript = transcript.slice(-MAX_ENTRIES);
  persist();
  emit();
}

function handleEvent(event) {
  switch (event.type) {
    case 'ready':
      if (!pending) setStatus('idle');
      return;
    case 'init':
      deaths = 0;
      return;
    case 'assistant': {
      const text = String(event.text || '').trim();
      if (!text) return;
      lastLine = text;
      push({ role: 'assistant', text });
      return;
    }
    case 'tool':
      push({ role: 'tool', text: event.name, detail: event.detail || '' });
      return;
    case 'tool-error':
      push({ role: 'error', text: event.text || 'An action failed.' });
      return;
    case 'result':
      pending = Math.max(0, pending - 1);
      if (event.costUsd) store.addSpend?.(event.costUsd, 'director');
      if (!event.ok && event.result) push({ role: 'error', text: String(event.result) });
      setStatus(pending ? 'working' : 'idle');
      emit();
      return;
    case 'error':
      push({ role: 'error', text: event.message || 'Director error' });
      return;
    case 'dead': {
      pending = 0;
      setStatus('dead');
      if (event.message) push({ role: 'error', text: `Director stopped: ${event.message}` });
      // Come back on our own once or twice; after that wait for the user.
      deaths += 1;
      if (deaths <= 2) setTimeout(() => startDirector(true), 1200 * deaths);
      return;
    }
    default:
  }
}

function options() {
  const settings = store.state.settings || {};
  return { model: settings.directorModel || undefined, effort: settings.directorEffort || undefined };
}

export function startDirector(force = false) {
  if (started && !force) return;
  if (!started) {
    window.api.director.onEvent(handleEvent);
    window.api.chats
      .load(TRANSCRIPT_ID)
      .then((saved) => {
        if (saved && Array.isArray(saved.messages) && !transcript.length) {
          transcript = saved.messages;
          emit();
        }
      })
      .catch(() => {});
  }
  started = true;
  // A new process has seen none of the shared briefs yet.
  freshContext = true;
  setStatus('starting');
  window.api.director.start(options()).catch((error) => {
    push({ role: 'error', text: `Director failed to start: ${error.message}` });
    setStatus('dead');
  });
}

export function restartDirector() {
  deaths = 0;
  pending = 0;
  startDirector(true);
}

/**
 * A function returning (or resolving to) the context sent with each prompt:
 * the canvas snapshot plus shared briefs. It is told when the Director process
 * is new, so it can resend everything the new process has not seen.
 */
export function setContextProvider(fn) {
  contextProvider = fn;
}

/** `from: "team"` marks a report from a team lead rather than the user. */
export function sendToDirector(text, { from } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  if (status === 'dead') restartDirector();

  pending += 1;
  push(from ? { role: 'user', text: clean, from } : { role: 'user', text: clean });
  setStatus('working');
  // Chained, so messages reach the Director in order even though building the
  // context reads files.
  sendChain = sendChain
    .then(async () => {
      let context = '';
      try {
        const fresh = freshContext;
        freshContext = false;
        context = contextProvider ? await contextProvider({ fresh }) : '';
      } catch (error) {
        console.warn('[director] context failed', error);
      }
      // The workspace tells the shared-context log where this turn belongs.
      return window.api.director.send(context ? `${context}\n\n${clean}` : clean, {
        workspace: store.page?.workspace || store.state.workspace || '',
      });
    })
    .then((result) => {
      if (result?.error) {
        pending = Math.max(0, pending - 1);
        push({ role: 'error', text: result.error });
        setStatus(pending ? 'working' : 'idle');
      }
    })
    .catch((error) => {
      pending = Math.max(0, pending - 1);
      push({ role: 'error', text: error.message });
      setStatus(pending ? 'working' : 'idle');
    });
  return true;
}

/** Record something the app did instantly on the Director's behalf. */
export function noteQuick(request, reply) {
  push({ role: 'user', text: request });
  push({ role: 'assistant', text: reply, quick: true });
  lastLine = reply;
  emit();
}

export function clearTranscript() {
  transcript = [];
  persist();
  emit();
}

export function directorLog() {
  return transcript
    .map((entry) => {
      if (entry.role === 'user') return `> ${entry.text}`;
      if (entry.role === 'tool') return `  [${entry.text}] ${entry.detail || ''}`;
      if (entry.role === 'error') return `  ! ${entry.text}`;
      return entry.text;
    })
    .join('\n');
}

export function onDirectorChange(callback) {
  listeners.add(callback);
  callback(snapshot());
  return () => listeners.delete(callback);
}

export function directorStatus() {
  return { status, lastLine, pending };
}

export const director = {
  start: startDirector,
  restart: restartDirector,
  send: sendToDirector,
  noteQuick,
  clear: clearTranscript,
  setContextProvider,
  log: directorLog,
  transcript: () => transcript,
  subscribe: onDirectorChange,
  status: directorStatus,
};
