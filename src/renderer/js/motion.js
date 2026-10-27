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
 * Fly a window into a point on screen (the dock), shrinking and fading as it
 * goes, then call `done`. `scale` is the canvas zoom, so the screen-space
 * offset can be expressed in the window's own (world) units.
 */
export function animateInto(el, point, scale = 1, done = () => {}) {
  if (prefersReducedMotion() || !point) {
    done();
    return null;
  }
  cancelAll(el);
  const rect = el.getBoundingClientRect();
  const dx = (point.x - (rect.left + rect.width / 2)) / scale;
  const dy = (point.y - (rect.top + rect.height / 2)) / scale;
  const animation = track(
    el,
    'out',
    el.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.08)`, opacity: 0 },
      ],
      { duration: 340, easing: 'cubic-bezier(0.5, 0, 0.2, 1)', fill: 'forwards' }
    )
  );
  animation.onfinish = () => {
    done();
    animation.cancel();
  };
  return animation;
}

/** The reverse of `animateInto`: grow a window out of a point on screen. */
export function animateOutOf(el, point, scale = 1) {
  if (prefersReducedMotion() || !point) return animateIn(el);
  const rect = el.getBoundingClientRect();
  const dx = (point.x - (rect.left + rect.width / 2)) / scale;
  const dy = (point.y - (rect.top + rect.height / 2)) / scale;
  return track(
    el,
    'in',
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(0.08)`, opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 380, easing: EASE, fill: 'backwards' }
    )
  );
}
