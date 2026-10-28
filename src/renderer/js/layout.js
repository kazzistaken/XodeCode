/**
 * Layout — a small tiling window manager for the canvas.
 *
 * Every open *app* window is tiled into the visible screen so all of them can
 * be seen at once, with no gaps and no window hidden behind the prompt bar or
 * the dock. `tileRects` answers one question: given N windows and the screen,
 * what is the tidiest set of rectangles?
 *
 * Grid: windows are split into rows of near-equal counts (7 → 4 + 3), and
 * each row fills the full width, so there are never empty cells. The row
 * count is the one whose windows come closest to a comfortable shape. If the
 * windows would get smaller than `minW`/`minH`, the grid grows past the
 * screen instead and the canvas zooms out to keep all of it in view.
 *
 * Tune it from `LAYOUT` below.
 */

/** Window kinds that participate in the tiling. Notes, shapes, text and
 *  images stay where the user put them. */
export const TILEABLE = new Set(['terminal', 'browser', 'board', 'music']);

export const LAYOUT = {
  gap: 14, // space between windows (screen px)
  minW: 400, // smallest width a tiled window may take
  minH: 240, // smallest height a tiled window may take
  maxW: 1920, // largest a window may be (world units), manual or tiled
  maxH: 1080,
  maxCols: 4, // never more windows than this side by side
  aspect: 1.6, // the w/h shape a tile would like to have
  maxAspect: 2.3, // wider than this and a lone window is narrowed, centred
  // Clear of the floating chrome: the page bar's handle on top, the prompt
  // bar at the bottom. Left and right stay equal so the tiles centre on the
  // prompt bar; canvas.js widens them while the dock holds windows.
  insets: { top: 16, right: 16, bottom: 80, left: 16 },
};

/**
 * How much a window's contents should be scaled for its size: text grows as
 * a window gets bigger and shrinks as it gets smaller. 1.0 at a typical tiled
 * size (about 640x400), driven by area so both width and height count.
 */
export const CONTENT_BASE = { w: 640, h: 400, min: 0.8, max: 1.25 };

export function contentScaleFor(node) {
  if (!node || !(TILEABLE.has(node.kind) || node.kind === 'note')) return 1;
  const k = Math.sqrt((Math.max(1, node.w) * Math.max(1, node.h)) / (CONTENT_BASE.w * CONTENT_BASE.h));
  return Math.round(Math.min(CONTENT_BASE.max, Math.max(CONTENT_BASE.min, k)) * 100) / 100;
}

/** Arrangements a page can use. */
export const LAYOUT_MODES = ['grid', 'columns', 'rows', 'focus'];

/**
 * @param {{ count: number, view: {x:number,y:number,w:number,h:number}, scale?: number, config?: object, mode?: string, mainIndex?: number }} args
 * @returns {Array<{x:number,y:number,w:number,h:number}>} May reach past
 *   `view` when there are too many windows to fit; the caller zooms out.
 */
export function tileRects(args = {}) {
  const config = { ...LAYOUT, ...(args.config || {}) };
  const n = Math.max(0, Math.floor(args.count || 0));
  if (!n || !args.view) return [];
  const area = usableArea(args.view, args.scale, config);
  const mode = args.mode || 'grid';

  let cells = null;
  if (n > 1 && mode === 'columns') {
    cells = strip(area, n, 'x');
    if (cells[0].w < area.minW * 0.75) cells = null;
  } else if (n > 1 && mode === 'rows') {
    cells = strip(area, n, 'y');
    if (cells[0].h < area.minH * 0.6) cells = null;
  } else if (n > 1 && mode === 'focus') {
    cells = focusRects(area, n, args.mainIndex || 0);
  }
  if (!cells) cells = gridRects(area, n, config);

  // A cell wider than a comfortable window (one or two windows on a wide
  // screen) holds a narrower window, centred, rather than a letterbox.
  return cells.map((r) => {
    const w = Math.min(r.w, config.maxW, Math.round(r.h * config.maxAspect));
    const h = Math.min(r.h, config.maxH);
    return {
      x: Math.round(r.x + (r.w - w) / 2),
      y: Math.round(r.y + (r.h - h) / 2),
      w: Math.round(w),
      h: Math.round(h),
    };
  });
}

/** The world-space box windows may fill, with spacing converted to world units. */
function usableArea(view, scale, config) {
  const { gap, minW, minH, insets } = config;
  const s = scale > 0 ? scale : 1;
  const top = (insets?.top || 0) / s;
  const right = (insets?.right || 0) / s;
  const bottom = (insets?.bottom || 0) / s;
  const left = (insets?.left || 0) / s;
  return {
    x: view.x + left,
    y: view.y + top,
    w: Math.max(minW, view.w - left - right),
    h: Math.max(minH, view.h - top - bottom),
    g: gap / s,
    minW,
    minH,
  };
}

/** n equal windows in one row (axis "x") or one column (axis "y"). */
function strip(area, n, axis) {
  const rects = [];
  if (axis === 'x') {
    const w = (area.w - (n - 1) * area.g) / n;
    for (let i = 0; i < n; i += 1) {
      rects.push({ x: area.x + i * (w + area.g), y: area.y, w, h: area.h });
    }
  } else {
    const h = (area.h - (n - 1) * area.g) / n;
    for (let i = 0; i < n; i += 1) {
      rects.push({ x: area.x, y: area.y + i * (h + area.g), w: area.w, h });
    }
  }
  return rects;
}

/** One large main window on the left, the rest stacked in a column (or two) on the right. */
function focusRects(area, n, mainIndex) {
  const main = Math.min(Math.max(0, mainIndex | 0), n - 1);
  const others = n - 1;
  const mainW = Math.round((area.w - area.g) * (others > 3 ? 0.58 : 0.64));
  const sideX = area.x + mainW + area.g;
  const sideW = area.w - mainW - area.g;
  const sideCols = others > 4 && sideW / 2 >= area.minW * 0.7 ? 2 : 1;
  const sideRows = Math.ceil(others / sideCols);
  const cellW = (sideW - (sideCols - 1) * area.g) / sideCols;
  const cellH = (area.h - (sideRows - 1) * area.g) / sideRows;

  const rects = [];
  let slot = 0;
  for (let i = 0; i < n; i += 1) {
    if (i === main) {
      rects.push({ x: area.x, y: area.y, w: mainW, h: area.h });
      continue;
    }
    const col = slot % sideCols;
    const row = Math.floor(slot / sideCols);
    slot += 1;
    rects.push({ x: sideX + col * (cellW + area.g), y: area.y + row * (cellH + area.g), w: cellW, h: cellH });
  }
  return rects;
}

/** How many windows go in each row: as even as possible, fuller rows first. */
function rowCounts(n, rows) {
  const base = Math.floor(n / rows);
  const extra = n % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Cell sizes when a W×H box is split into lines of windows: rows stacked
 * top to bottom ("rows"), or columns side by side ("cols").
 */
function measure(counts, W, H, g, axis) {
  const across = axis === 'rows' ? H : W; // the direction lines stack in
  const along = axis === 'rows' ? W : H; // the direction a line runs
  const line = (across - (counts.length - 1) * g) / counts.length;
  return counts.map((k) => {
    const each = (along - (k - 1) * g) / k;
    return axis === 'rows' ? { k, cw: each, ch: line } : { k, cw: line, ch: each };
  });
}

function gridRects(area, n, config) {
  const { g, minW, minH } = area;
  const { aspect, maxCols } = config;

  // Score every split into rows (and into columns, which suits odd counts:
  // three windows read best as one tall beside two stacked). The best is the
  // one whose least comfortable window is closest to the target shape.
  let best = null;
  for (const axis of ['rows', 'cols']) {
    for (let lines = 1; lines <= n; lines += 1) {
      const counts = rowCounts(n, lines);
      const across = axis === 'rows' ? counts[0] : lines;
      if (across > maxCols) continue;
      const cells = measure(counts, area.w, area.h, g, axis);
      const shape = Math.max(...cells.map((c) => Math.abs(Math.log(c.cw / c.ch / aspect))));
      const fits = cells.every((c) => c.cw >= minW - 1 && c.ch >= minH - 1);
      const score =
        shape +
        (counts[0] !== counts[counts.length - 1] ? 0.06 : 0) +
        (axis === 'cols' && lines > 1 ? 0.04 : 0) + // rows read more naturally
        (fits ? 0 : 10);
      if (!best || score < best.score) best = { axis, counts, score, fits };
    }
  }

  // Too many windows for the screen: grow the grid (around its centre) until
  // every window reaches the minimum size. The canvas zooms out to show it.
  let { x, y, w: W, h: H } = area;
  if (!best.fits) {
    const cells = measure(best.counts, W, H, g, best.axis);
    const grow = Math.max(...cells.map((c) => Math.max(minW / c.cw, minH / c.ch)));
    // Cells scale by `grow`; the gaps between them stay the same.
    const most = (Math.max(...best.counts) - 1) * g;
    const lines = (best.counts.length - 1) * g;
    const gapsW = best.axis === 'rows' ? most : lines;
    const gapsH = best.axis === 'rows' ? lines : most;
    const W2 = (W - gapsW) * grow + gapsW;
    const H2 = (H - gapsH) * grow + gapsH;
    x -= (W2 - W) / 2;
    y -= (H2 - H) / 2;
    W = W2;
    H = H2;
  }

  const rects = [];
  let offset = 0;
  for (const { k, cw, ch } of measure(best.counts, W, H, g, best.axis)) {
    for (let i = 0; i < k; i += 1) {
      rects.push(
        best.axis === 'rows'
          ? { x: x + i * (cw + g), y: y + offset, w: cw, h: ch }
          : { x: x + offset, y: y + i * (ch + g), w: cw, h: ch }
      );
    }
    offset += (best.axis === 'rows' ? ch : cw) + g;
  }
  return rects;
}
