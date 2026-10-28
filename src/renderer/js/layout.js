/**
 * Layout — a small tiling window manager for the canvas.
 *
 * The canvas is an infinite space, but for multi-tasking we want every open
 * *app* window to sit side by side, filling the screen with sensible sizes.
 * `tileRects` answers one question: given N windows and the visible area, what
 * is the tidiest set of rectangles?
 *
 * It picks the column count whose cells come closest to a comfortable window
 * aspect (neither letterbox-slivers nor tall pipes), prefers grids that leave
 * no empty cells, and never shrinks a window below `minW`/`minH` while a
 * roomier arrangement exists. The last, short row is centred so the layout
 * reads as intentional rather than left-aligned.
 *
 * Tune it from `LAYOUT` below.
 */

/** Window kinds that participate in the tiling. Notes, shapes, text and
 *  images stay where the user put them. */
export const TILEABLE = new Set(['terminal', 'browser', 'board', 'music']);

export const LAYOUT = {
  gap: 20, // space between windows (screen px)
  margin: 34, // space between the windows and the usable area (screen px)
  minW: 360, // smallest width a tiled window may take
  minH: 260, // smallest height a tiled window may take
  maxW: 1920, // largest a window may be (world units), manual or tiled
  maxH: 1080,
  idealW: 1200, // size tiles keep until the canvas has no room left
  idealH: 720,
  maxCols: 4, // never go wider than this many columns
  aspect: 1.55, // the w/h ratio a tile would like to have
  // Floating chrome plus a generous border all round, so the windows sit
  // framed on the canvas instead of running edge to edge. The left side also
  // clears the dock.
  insets: { top: 20, right: 44, bottom: 96, left: 44 },
};

/**
 * How much a window's contents should be scaled for its size: text grows as
 * a window gets bigger and shrinks as it gets smaller. 1.0 at a typical tiled
 * size (about 640x400), driven by area so both width and height count.
 */
export const CONTENT_BASE = { w: 640, h: 400, min: 0.75, max: 1.5 };

export function contentScaleFor(node) {
  if (!node || !(TILEABLE.has(node.kind) || node.kind === 'note')) return 1;
  const k = Math.sqrt((Math.max(1, node.w) * Math.max(1, node.h)) / (CONTENT_BASE.w * CONTENT_BASE.h));
  return Math.round(Math.min(CONTENT_BASE.max, Math.max(CONTENT_BASE.min, k)) * 100) / 100;
}

/** Arrangements a page can use. */
export const LAYOUT_MODES = ['grid', 'columns', 'rows', 'focus'];

/**
 * @param {{ count: number, view: {x:number,y:number,w:number,h:number}, scale?: number, config?: object, mode?: string, mainIndex?: number }} args
 * @returns {Array<{x:number,y:number,w:number,h:number}>}
 */
export function tileRects(args = {}) {
  const { config = LAYOUT } = args;
  const { maxW, maxH } = { ...LAYOUT, ...config };
  // Cells keep dividing the whole canvas; a cell bigger than the cap (few
  // windows) just holds a capped window centred inside it.
  return tileCells(args).map((r) => {
    const w = Math.min(r.w, maxW);
    const h = Math.min(r.h, maxH);
    return { x: Math.round(r.x + (r.w - w) / 2), y: Math.round(r.y + (r.h - h) / 2), w, h };
  });
}

function tileCells({ count, view, scale = 1, config = LAYOUT, mode = 'grid', mainIndex = 0 } = {}) {
  const n = Math.max(0, Math.floor(count || 0));
  if (!n || !view) return [];
  // Whatever the arrangement, windows keep their comfortable size while they
  // all fit; columns/rows/focus only divide the canvas once it is full.
  const roomy = gridRects({ n, view, scale, config, onlyIdeal: true });
  if (roomy) return roomy;
  const area = usableArea(view, scale, config);
  if (n > 1 && mode === 'columns') {
    const rects = strip(area, n, 'x');
    if (rects[0].w >= area.minW * 0.75) return rects;
  }
  if (n > 1 && mode === 'rows') {
    const rects = strip(area, n, 'y');
    if (rects[0].h >= area.minH * 0.6) return rects;
  }
  if (n > 1 && mode === 'focus') return focusRects(area, n, mainIndex);
  return gridRects({ n, view, scale, config });
}

/** The world-space box windows may fill, with spacing converted to world units. */
function usableArea(view, scale, config) {
  const { gap, margin, minW, minH, insets } = { ...LAYOUT, ...config };
  const s = scale > 0 ? scale : 1;
  const m = margin / s;
  const top = (insets?.top || 0) / s;
  const right = (insets?.right || 0) / s;
  const bottom = (insets?.bottom || 0) / s;
  const left = (insets?.left || 0) / s;
  return {
    x: view.x + left + m,
    y: view.y + top + m,
    w: Math.max(minW, view.w - left - right - m * 2),
    h: Math.max(minH, view.h - top - bottom - m * 2),
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
      rects.push({ x: area.x + i * (w + area.g), y: area.y, w: Math.round(w), h: Math.round(area.h) });
    }
  } else {
    const h = (area.h - (n - 1) * area.g) / n;
    for (let i = 0; i < n; i += 1) {
      rects.push({ x: area.x, y: area.y + i * (h + area.g), w: Math.round(area.w), h: Math.round(h) });
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
      rects.push({ x: area.x, y: area.y, w: mainW, h: Math.round(area.h) });
      continue;
    }
    const col = slot % sideCols;
    const row = Math.floor(slot / sideCols);
    slot += 1;
    rects.push({
      x: sideX + col * (cellW + area.g),
      y: area.y + row * (cellH + area.g),
      w: Math.round(cellW),
      h: Math.round(cellH),
    });
  }
  return rects;
}

function gridRects({ n, view, scale, config, onlyIdeal = false }) {

  const { gap, margin, minW, minH, maxCols, aspect, insets, idealW, idealH } = { ...LAYOUT, ...config };
  const s = scale > 0 ? scale : 1;
  // Screen-space spacing becomes world-space spacing at the current zoom.
  const g = gap / s;
  const m = margin / s;
  const top = (insets?.top || 0) / s;
  const right = (insets?.right || 0) / s;
  const bottom = (insets?.bottom || 0) / s;
  const left = (insets?.left || 0) / s;

  const W = Math.max(minW, view.w - left - right - m * 2);
  const H = Math.max(minH, view.h - top - bottom - m * 2);
  const originX = view.x + left + m;
  const originY = view.y + top + m;

  // Score every viable column count and keep the best-looking one.
  const fitting = [];
  const all = [];
  const maxCandidate = Math.max(1, Math.min(n, maxCols));
  for (let cols = 1; cols <= maxCandidate; cols += 1) {
    const rows = Math.ceil(n / cols);
    const cw = (W - (cols - 1) * g) / cols;
    const ch = (H - (rows - 1) * g) / rows;
    const empty = cols * rows - n;
    const candidate = {
      cols,
      rows,
      cw,
      ch,
      tooSmall: cw < minW - 1 || ch < minH - 1,
      // Closeness to the target aspect, with a nudge against empty cells and a
      // hair of preference for more columns (a "side by side" feel).
      score: Math.abs(cw / ch - aspect) + empty * 0.18 + cols * 0.01,
    };
    all.push(candidate);
    if (!candidate.tooSmall) fitting.push(candidate);
  }

  // Windows keep their comfortable size while they all fit; they only start
  // shrinking (dividing the canvas) once there is no room left.
  const roomy = all.filter((c) => c.cols * idealW + (c.cols - 1) * g <= W + 1 && c.rows * idealH + (c.rows - 1) * g <= H + 1);
  if (roomy.length) {
    const pick = roomy.reduce((a, b) => (b.score < a.score ? b : a));
    const rows = pick.rows;
    const blockH = rows * idealH + (rows - 1) * g;
    const rects = [];
    for (let i = 0; i < n; i += 1) {
      const row = Math.floor(i / pick.cols);
      const col = i % pick.cols;
      const inRow = Math.min(pick.cols, n - row * pick.cols);
      const rowWidth = inRow * idealW + (inRow - 1) * g;
      rects.push({
        x: originX + (W - rowWidth) / 2 + col * (idealW + g),
        y: originY + (H - blockH) / 2 + row * (idealH + g),
        w: idealW,
        h: idealH,
      });
    }
    return rects;
  }
  if (onlyIdeal) return null;

  let pool = fitting;
  if (!pool.length) {
    // Everything is cramped: take the roomiest cells we can (fewest columns).
    pool = [...all].sort((a, b) => a.cols - b.cols || a.rows - b.rows);
  }
  const best = pool.reduce((pick, candidate) =>
    candidate.score < pick.score ? candidate : pick
  );
  const { cols, cw, ch } = best;

  const rects = [];
  for (let i = 0; i < n; i += 1) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    // Centre the final row when it does not fill every column.
    const inRow = Math.min(cols, n - row * cols);
    const rowWidth = inRow * cw + (inRow - 1) * g;
    const offset = (W - rowWidth) / 2;
    rects.push({
      x: originX + offset + col * (cw + g),
      y: originY + row * (ch + g),
      w: Math.round(cw),
      h: Math.round(ch),
    });
  }
  return rects;
}
