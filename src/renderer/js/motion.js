/**
 * Motion — small helpers for window entrances, exits and slides.
 *
 * Everything runs on the Web Animations API and only touches `transform` and
 * `opacity`, so it stays on the GPU. Starting a new animation on an element
 * cancels the previous one and continues from the current computed transform,
 * which makes rapid AI moves interrupt cleanly.
 */

export const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const DURATION = { in: 260, out: 170, move: 300 };

const running = new WeakMap();

export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Register an animation against an element under a `kind` ("in", "out",
 * "move", "size"). Only the previous animation of the *same* kind is
 * cancelled, so a slide and a resize can run together while a fresh slide
 * cleanly replaces the one it interrupted.
 */
function track(el, kind, animation) {
  let map = running.get(el);
  if (!map) {
    map = new Map();
    running.set(el, map);
  }
  const previous = map.get(kind);
  if (previous) {
    try {
      previous.cancel();
    } catch {
      /* ignore */
    }
  }
  map.set(kind, animation);
  const clear = () => {
    if (map.get(kind) === animation) map.delete(kind);
  };
  animation.onfinish = clear;
  animation.oncancel = clear;
  return animation;
}

/** Stop every animation we are running on an element. */
function cancelAll(el) {
  const map = running.get(el);
  if (!map) return;
  for (const animation of map.values()) {
    try {
      animation.cancel();
    } catch {
      /* ignore */
    }
  }
  map.clear();
}

/** Fade + slight rise/scale as a window appears. */
export function animateIn(el, { delay = 0 } = {}) {
  if (prefersReducedMotion()) return null;
  const animation = track(
    el,
    'in',
    el.animate(
      [
        { transform: 'translateY(12px) scale(0.96)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: DURATION.in, delay, easing: EASE, fill: 'backwards' }
    )
  );
  return animation;
}

/** Fade + slight scale down, then remove the element. */
export function animateOut(el, { duration = DURATION.out } = {}) {
  cancelAll(el);
  if (prefersReducedMotion()) {
    el.remove();
    return null;
  }
  const animation = track(
    el,
    'out',
    el.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: 'scale(0.97) translateY(6px)', opacity: 0 },
      ],
      { duration, easing: EASE, fill: 'forwards' }
    )
  );
  animation.onfinish = () => el.remove();
  return animation;
}

/**
 * Slide an element from its previous position to the one it was just laid out
 * at. `dx`/`dy` are `old - new`, so the element starts visually where it was
 * and glides to `transform: none`.
 */
export function slideTo(el, dx, dy, { duration = DURATION.move } = {}) {
  if (prefersReducedMotion() || (!dx && !dy)) return null;
  // If a slide is still running, the element is visually offset from its
  // *previous* target. Add that offset so the new slide starts exactly where
  // the window is on screen instead of snapping.
  let ox = 0;
  let oy = 0;
  const current = getComputedStyle(el).transform;
  if (current && current !== 'none') {
    try {
      const matrix = new DOMMatrixReadOnly(current);
      ox = matrix.m41;
      oy = matrix.m42;
    } catch {
      /* ignore */
    }
  }
  const from = `translate(${dx + ox}px, ${dy + oy}px)`;
  return track(
    el,
    'move',
    el.animate([{ transform: from }, { transform: 'none' }], {
      duration,
      easing: EASE,
      fill: 'none',
    })
  );
}

/**
 * Grow/shrink a window from its previous box to its new one. Width and height
 * are not GPU properties, but a tiling rearrange needs them, and animating
 * only the outer box keeps the content crisp (no scaled text).
 */
export function animateSize(el, from, to, { duration = DURATION.move } = {}) {
  if (prefersReducedMotion()) return null;
  if (
    Math.abs(from.w - to.w) < 0.5 &&
    Math.abs(from.h - to.h) < 0.5
  ) {
    return null;
  }
  return track(
    el,
    'size',
    el.animate(
      [
        { width: `${from.w}px`, height: `${from.h}px` },
        { width: `${to.w}px`, height: `${to.h}px` },
      ],
      { duration, easing: EASE, fill: 'none' }
    )
  );
}

/**
 * Keyframes for a window travelling between itself and a dock icon: it first
 * shrinks where it is to a small card, then arcs down into the icon (sideways
 * first, then dropping), ending the icon's size. Offsets are in the window's
 * own (world) units; `scale` is the canvas zoom.
 */
function dockFlight(el, point, scale) {
  const rect = el.getBoundingClientRect();
  const dx = (point.x - (rect.left + rect.width / 2)) / scale;
  const dy = (point.y - (rect.top + rect.height / 2)) / scale;
  const size = Math.max(rect.width, rect.height, 1);
  const end = Math.max(0.02, (point.size || 36) / size);
  const card = Math.min(0.42, Math.max(end * 2.5, 200 / size));
  const mid = (card + end) / 2;
  return [
    { offset: 0, transform: 'none', opacity: 1, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' },
    { offset: 0.34, transform: `translate(${dx * 0.04}px, ${dy * 0.02 - 10 / scale}px) scale(${card})`, opacity: 1, easing: 'cubic-bezier(0.45, 0, 0.55, 1)' },
    { offset: 0.68, transform: `translate(${dx * 0.62}px, ${dy * 0.38}px) scale(${mid})`, opacity: 1, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' },
    { offset: 0.9, transform: `translate(${dx * 0.97}px, ${dy * 0.94}px) scale(${end * 1.08})`, opacity: 0.9 },
    { offset: 1, transform: `translate(${dx}px, ${dy}px) scale(${end})`, opacity: 0 },
  ];
}

/**
 * Close a window into the dock: it shrinks small, then flies into its icon at
 * `point` ({x, y, size} on screen) and calls `done` as it lands. `scale` is
 * the canvas zoom; `delay` staggers several windows closing at once.
 */
export function animateInto(el, point, scale = 1, done = () => {}, { delay = 0 } = {}) {
  if (prefersReducedMotion() || !point) {
    done();
    return null;
  }
  cancelAll(el);
  const animation = track(
    el,
    'out',
    el.animate(dockFlight(el, point, scale), { duration: 640, delay, easing: 'linear', fill: 'both' })
  );
  animation.onfinish = () => {
    done();
    animation.cancel();
  };
  return animation;
}

/** The reverse of `animateInto`: grow a window out of its dock icon. */
export function animateOutOf(el, point, scale = 1) {
  if (prefersReducedMotion() || !point) return animateIn(el);
  const frames = dockFlight(el, point, scale)
    .reverse()
    .map((frame) => ({ ...frame, offset: 1 - frame.offset, easing: 'cubic-bezier(0.25, 0, 0.2, 1)' }));
  // Growing out reads better a touch quicker, and visible from the start.
  frames[0].opacity = 0.4;
  return track(el, 'in', el.animate(frames, { duration: 520, easing: 'linear', fill: 'backwards' }));
}
