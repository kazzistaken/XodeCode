import { store } from './store.js';

/**
 * Follow mode (Settings > Agents > Follow mode): when an agent window starts
 * working, needs you or finishes, the camera glides over to it, lingers, then
 * glides back to where you were. Bursts from several agents are debounced into
 * one move, and any pan, zoom or click of your own pauses following for a bit.
 */

const SETTLE_MS = 450; // wait for a burst of events to settle before moving
const DWELL_MS = 2200; // how long to linger on an agent before heading back
const USER_PAUSE_MS = 5000; // hands off after you move the camera yourself

function isAgent(node) {
  return node?.kind === 'terminal' && node.cli === 'claude';
}

export function initFollow(ctx) {
  const { canvas } = ctx;
  const viewportEl = document.getElementById('viewport');

  let home = null; // camera to return to, saved when we first leave it
  let targetId = null; // the agent we are looking at (or about to)
  let pendingId = null;
  let settleTimer = null;
  let backTimer = null;
  let pausedUntil = 0;

  const enabled = () => Boolean(store.state.settings.followMode);

  function reset() {
    clearTimeout(settleTimer);
    clearTimeout(backTimer);
    settleTimer = null;
    backTimer = null;
    pendingId = null;
    targetId = null;
    home = null;
  }

  function goBack() {
    backTimer = null;
    targetId = null;
    if (!home || !enabled()) {
      home = null;
      return;
    }
    const to = home;
    home = null;
    canvas.animateViewport(to, { duration: 520 });
  }

  function visit() {
    settleTimer = null;
    const id = pendingId;
    pendingId = null;
    if (!id || !enabled() || Date.now() < pausedUntil) return;
    const found = store.findNode(id);
    if (!found || found.page.id !== store.page.id || found.node.parked) return;
    if (!home) {
      const vp = store.page.viewport;
      home = { x: vp.x, y: vp.y, scale: vp.scale };
    }
    targetId = id;
    canvas.fitNode(id);
    clearTimeout(backTimer);
    backTimer = setTimeout(goBack, DWELL_MS);
  }

  store.on('status', (meta) => {
    if (!enabled() || !isAgent(meta)) return;
    if (!['working', 'needs', 'idle'].includes(meta.status)) return;
    if (Date.now() < pausedUntil) return;
    // The window you are working in is already in front of you.
    if (canvas.isFocused(meta.id)) return;
    if (meta.id === targetId) {
      // More from the agent we are already showing: just linger longer.
      clearTimeout(backTimer);
      backTimer = setTimeout(goBack, DWELL_MS);
      return;
    }
    pendingId = meta.id;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(visit, SETTLE_MS);
  });

  // Your own camera input wins: stop, stay where you put it, and pause.
  const userMoved = () => {
    if (!enabled()) return;
    pausedUntil = Date.now() + USER_PAUSE_MS;
    if (settleTimer || backTimer || home) {
      canvas.stopViewportAnimation();
      reset();
    }
  };
  viewportEl?.addEventListener('wheel', userMoved, { passive: true, capture: true });
  viewportEl?.addEventListener('pointerdown', userMoved, { capture: true });

  store.on('page', () => reset());
  store.on('settings', () => {
    if (!enabled()) reset();
  });

  return { reset };
}
