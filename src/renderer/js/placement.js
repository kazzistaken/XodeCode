/**
 * Placement — where a new window should go.
 *
 * `findPlacement` returns the top-left world position for a window of size
 * w×h that
 *   1. stays inside the visible area (plus the margin),
 *   2. keeps an even gap from every other window,
 *   3. fills the empty regions row by row before stacking below the fold.
 *
 * Tune it from `PLACEMENT` below — `margin` is the distance from the edge of
 * the visible area, `gap` is the space between windows.
 */

export const PLACEMENT = {
  margin: 40,
  gap: 28,
  maxRowsBeyondView: 200,
};

export function findPlacement({ nodes, w, h, view, config = PLACEMENT } = {}) {
  const { margin, gap, maxRowsBeyondView } = { ...PLACEMENT, ...config };
  const others = (nodes || []).filter((node) => node.kind !== 'shape');

  const stepX = w + gap;
  const stepY = h + gap;
  const originX = view.x + margin;
  const originY = view.y + margin;
  const cols = Math.max(1, Math.floor((view.w - margin * 2 + gap) / stepX));
  const rows = Math.max(1, Math.floor((view.h - margin * 2 + gap) / stepY));

  const collides = (x, y) =>
    others.some(
      (node) =>
        x < node.x + node.w + gap &&
        x + w + gap > node.x &&
        y < node.y + node.h + gap &&
        y + h + gap > node.y
    );

  // 1. Fill the visible grid, row by row — empty regions first.
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = originX + col * stepX;
      const y = originY + row * stepY;
      if (!collides(x, y)) return { x, y, inView: true };
    }
  }

  // 2. No room in view — keep the same columns and continue below the fold.
  for (let row = rows; row < rows + maxRowsBeyondView; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = originX + col * stepX;
      const y = originY + row * stepY;
      if (!collides(x, y)) return { x, y, inView: false };
    }
  }

  // 3. Everything is packed — drop it just below the lowest window.
  const bottom = others.reduce((max, node) => Math.max(max, node.y + node.h), originY);
  return { x: originX, y: bottom + gap, inView: false };
}
