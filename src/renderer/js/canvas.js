import { el, clamp, uid } from './util.js';
import { store } from './store.js';
import { findPlacement } from './placement.js';
import { TILEABLE, LAYOUT, LAYOUT_MODES, tileRects, contentScaleFor } from './layout.js';
import { dockArriving, dockLanded, dockTargetFor } from './dock.js';
import {
  animateIn,
  animateOut,
  slideTo,
  animateSize,
  animateInto,
  animateOutOf,
  prefersReducedMotion,
} from './motion.js';

export const GRID = 28;
// Side-by-side layout: the space between neighbouring windows.
const FLOW_GAP = 24;
const FLOW_ROW_SCREENS = 1.6;
export const MIN_W = 300;
export const MIN_H = 170;
export const MIN_ZOOM = 1 / 3; // zoomed out to 3x the normal view at most
export const MAX_ZOOM = 2.4;
const SHAPE_MIN = 16;

const SHAPE_TOOLS = new Set(['rect', 'ellipse', 'diamond', 'arrow', 'line', 'pen']);
// The palette's hues (styles.css): clay, blue, green, amber, violet.
const SHAPE_COLORS = ['#d97757', '#7aa6e8', '#5fb57a', '#e0a64a', '#a88be8'];

const factories = new Map();

/** Node factories are registered by the modules that own each node kind. */
export function registerNodeType(kind, factory) {
  factories.set(kind, factory);
}

function snapshotOf(pageId, node) {
  return { pageId, data: JSON.parse(JSON.stringify(node)) };
}

export class Canvas {
  constructor({ viewport, world }) {
    this.viewportEl = viewport;
    this.worldEl = world;
    this.views = new Map();
    this.pageEls = new Map();
    this.heroEls = new Map();
    this.zTop = 20;
    this.tool = 'select';
    this.selectedId = null;
    this.selection = new Set();
    this.appliedScale = null;
    this.shapeColor = 0;
    this.drawState = null;
    this.history = [];
    this.historyIndex = -1;
    this._historyLock = false;
    this.marquee = null;
    this._spawnBurst = { at: 0, count: 0 };
    // The background picture sits behind the canvas and always fills the
    // screen, whatever the zoom.
    this.bgEl = el('div', { class: 'world-bg', 'aria-hidden': 'true' });
    this.viewportEl.insertBefore(this.bgEl, this.worldEl);
    // The dot grid, on its own layer so panning never restyles the app.
    this.gridEl = el('div', { class: 'grid-layer', 'aria-hidden': 'true' });
    this.viewportEl.insertBefore(this.gridEl, this.bgEl);
    this._gridSize = 0;
    // The screen size, cached: reading it every camera frame would force a
    // style flush on each one.
    this._screen = { w: this.viewportEl.clientWidth, h: this.viewportEl.clientHeight };
    new ResizeObserver(() => {
      this._screen = { w: this.viewportEl.clientWidth, h: this.viewportEl.clientHeight };
      this._gridSize = 0;
      this._placeGrid(true);
      this._cull();
    }).observe(this.viewportEl);
    this._bind();
    this._buildPages();
    this.syncActivePage();
  }

  /* ----------------------------- wiring ----------------------------- */

  _bind() {
    this.viewportEl.addEventListener('pointerdown', (event) => this._onViewportPointerDown(event));
    this.viewportEl.addEventListener('wheel', (event) => this._onWheel(event), { passive: false });
    this.viewportEl.addEventListener('contextmenu', (event) => event.preventDefault());

    // Hero call-to-action (choose a workspace for this tab).
    this.worldEl.addEventListener('click', (event) => {
      if (event.target.closest?.('.hero-btn')) this.onHeroAction?.();
    });

    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
    this.viewportEl.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      this.viewportEl.classList.add('is-drop-target');
    });
    this.viewportEl.addEventListener('dragleave', (event) => {
      if (event.relatedTarget && this.viewportEl.contains(event.relatedTarget)) return;
      this.viewportEl.classList.remove('is-drop-target');
    });
    this.viewportEl.addEventListener('drop', (event) => this._onDrop(event));

    store.on('page', () => this.syncActivePage());

    // Pinning the page bar changes the room the tiles have.
    let pinned = !!store.state.settings.pinTopbar;
    store.on('settings', (settings) => {
      if (!!settings.pinTopbar === pinned) return;
      pinned = !!settings.pinTopbar;
      this.relayout({ animate: true });
    });

    // Re-tile when the window changes size so the layout keeps filling the
    // screen. Debounced so a drag-resize does not thrash the terminals.
    window.addEventListener('resize', () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this.relayout({ animate: true }), 140);
    });
  }

  /* ------------------------------ pages ----------------------------- */

  _buildPages() {
    this.worldEl.replaceChildren();
    this.pageEls.clear();
    this.heroEls.clear();

    for (const page of store.pages) this._mountPage(page);
  }

  _mountPage(page) {
    if (this.pageEls.has(page.id)) return;
    const pageEl = el('div', { class: 'page' });
    this.worldEl.append(pageEl);
    this.pageEls.set(page.id, pageEl);
  }

  createPage() {
    const page = store.addPage();
    this._mountPage(page);
    this.syncActivePage();
    this.updateHero();
    return page;
  }

  deletePage(id) {
    if (store.pages.length <= 1) return false;
    const page = store.pages.find((p) => p.id === id);
    if (!page) return false;
    for (const node of [...page.nodes]) this.unmountNode(node.id);
    this.pageEls.get(id)?.remove();
    this.pageEls.delete(id);
    this.heroEls.delete(id);
    return store.removePage(id);
  }

  syncActivePage() {
    const activeId = store.page.id;
    for (const [id, pageEl] of this.pageEls) {
      pageEl.classList.toggle('is-active', id === activeId);
    }
    this.applyViewport();
    this.updateHero();
    this.drawJointLines();
    for (const [id, view] of this.views) {
      const found = store.findNode(id);
      if (found && found.page.id === activeId) view.redraw?.();
    }
    // Keep the active tab's windows tiled for the current screen size.
    this.relayout({ animate: this.views.size > 0 });
  }

  mountAll() {
    for (const page of store.pages) {
      const pageEl = this.pageEls.get(page.id);
      for (const node of page.nodes) this.mountNode(node, pageEl);
    }
    this.updateHero();
    this.drawJointLines();
  }

  /** Empty pages show nothing but the canvas. */
  updateHero() {}

  /* --------------------------- node views --------------------------- */

  mountNode(meta, pageEl, options = {}) {
    if (this.views.has(meta.id)) return this.views.get(meta.id);
    const factory = factories.get(meta.kind);
    if (!factory) {
      console.warn(`[canvas] no factory registered for kind "${meta.kind}"`);
      return null;
    }
    const target = pageEl || this.pageEls.get(store.page.id);
    const view = factory(meta, this);
    if (!view) return null;

    view.el.dataset.id = meta.id;
    if (meta.parked) view.el.classList.add('is-parked');
    this.views.set(meta.id, view);
    target.append(view.el);
    this._wireNode(meta, view);
    this.applyGeometry(meta);
    if (options.animate) animateIn(view.el, { delay: this._nextStagger() });
    return view;
  }

  /** Stagger windows that arrive together so a burst fans in. */
  _nextStagger() {
    const now = performance.now();
    const burst = this._spawnBurst;
    if (now - burst.at < 400) burst.count += 1;
    else burst.count = 0;
    burst.at = now;
    return Math.min(6, burst.count) * 45;
  }

  unmountNode(id, options = {}) {
    const view = this.views.get(id);
    if (!view) return;
    try {
      view.destroy?.();
    } catch (error) {
      console.warn('[canvas] view destroy failed', error);
    }
    this.views.delete(id);
    if (options.animate) animateOut(view.el);
    else view.el.remove();
  }

  _wireNode(meta, view) {
    const head = view.el.querySelector('.node-head');
    const dragHandle = head || (meta.kind === 'shape' ? view.el : null);
    if (dragHandle) {
      dragHandle.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.node-act')) return;
        this._startNodeDrag(event, meta, view);
      });
    }
    const grip = view.el.querySelector('.node-resize');
    if (grip) {
      grip.addEventListener('pointerdown', (event) => this._startNodeResize(event, meta, view));
    }
    view.el.addEventListener('pointerdown', (event) => {
      if (this.selection.has(meta.id)) {
        if (event.shiftKey) this.focusNode(meta.id, true);
      } else {
        this.focusNode(meta.id, event.shiftKey);
      }
    });
    view.el.addEventListener('dblclick', () => {
      if (meta.kind === 'terminal') this.fitNode(meta.id);
    });
  }

  applyGeometry(meta, options = {}) {
    const view = this.views.get(meta.id);
    if (!view) return;
    const el = view.el;
    const prevLeft = parseFloat(el.style.left);
    const prevTop = parseFloat(el.style.top);
    const hadPosition = Number.isFinite(prevLeft) && Number.isFinite(prevTop);
    // Read the *live* (possibly mid-animation) size before we change it, so an
    // interrupted re-tile continues from where it is instead of snapping back.
    const computed = getComputedStyle(el);
    const liveW = parseFloat(computed.width);
    const liveH = parseFloat(computed.height);

    el.style.left = `${meta.x}px`;
    el.style.top = `${meta.y}px`;
    el.style.width = `${meta.w}px`;
    el.style.height = `${meta.h}px`;
    el.style.zIndex = String(meta.z || 1);

    this._syncTeamChrome(meta, el);

    // Glide from the old spot to the new one, and ease the box to its new size,
    // so a re-tile reads as motion rather than a jump.
    if (options.animate && hadPosition) {
      const duration = options.duration;
      if (prevLeft !== meta.x || prevTop !== meta.y) {
        slideTo(el, prevLeft - meta.x, prevTop - meta.y, { duration });
      }
      if (Number.isFinite(liveW) && Number.isFinite(liveH)) {
        animateSize(el, { w: liveW, h: liveH }, { w: meta.w, h: meta.h }, { duration });
      }
    }

    // Text follows the window: bigger window, bigger text. Tiled windows share
    // one size per page (set in relayout), so neighbours read alike.
    const tiled = this._tileText?.get(meta.id);
    const contentScale = tiled && this.autoLayoutOn() ? tiled : contentScaleFor(meta);
    if (view.setContentScale) view.setContentScale(contentScale);
    else el.style.setProperty('--content-scale', String(contentScale));

    view.resize?.(meta.w, meta.h);
    view.redraw?.();
    this.drawJointLines();
    this._scheduleCull();
  }

  /** Marks team windows and puts the agent's name on the border. */
  _syncTeamChrome(meta, el) {
    const joint = meta.joint ? store.joints[meta.joint] : null;
    let tag = el.querySelector(':scope > .node-tag');
    if (!joint) {
      el.classList.remove('is-joint', 'is-lead');
      el.style.removeProperty('--joint-color');
      tag?.remove();
      return;
    }
    el.classList.add('is-joint');
    el.classList.toggle('is-lead', meta.rank === 'lead');
    // The window border carries the agent's name and nothing else.
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'node-tag';
      el.append(tag);
    }
    tag.textContent = meta.callSign || '';
  }

  /** Re-apply rank chrome and lines after the hierarchy changes. */
  refreshTeams() {
    for (const node of store.allNodes()) {
      const view = this.views.get(node.id);
      if (view) this._syncTeamChrome(node, view.el);
    }
    this.drawJointLines();
  }

  /** Redraw the team lines on the next frame (many callers, one redraw). */
  drawJointLines() {
    if (this._linesFrame) return;
    this._linesFrame = requestAnimationFrame(() => {
      this._linesFrame = 0;
      this._drawJointLinesNow();
    });
  }

  /** Draw a curved line from each team's lead to every one of its workers. */
  _drawJointLinesNow() {
    for (const page of store.pages) {
      const pageEl = this.pageEls.get(page.id);
      if (!pageEl) continue;

      let svg = pageEl.querySelector(':scope > svg.joint-lines');
      if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'joint-lines');
        pageEl.prepend(svg);
      }
      svg.replaceChildren();

      const visible = page.nodes.filter((node) => node.joint && !node.parked);
      const ns = 'http://www.w3.org/2000/svg';
      for (const lead of visible.filter((node) => node.rank === 'lead')) {
        // Lines are white, like the jointed window outlines; the team colour
        // lives on the title-bar chip.
        const color = '#ffffff';
        const from = [lead.x + lead.w / 2, lead.y + lead.h / 2];
        const workers = visible.filter((node) => node.parentId === lead.id);
        for (const worker of workers) {
          const to = [worker.x + worker.w / 2, worker.y + worker.h / 2];
          // A soft S-curve along the longer axis reads as "reports to".
          const horizontal = Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1]);
          const mx = (from[0] + to[0]) / 2;
          const my = (from[1] + to[1]) / 2;
          const c1 = horizontal ? [mx, from[1]] : [from[0], my];
          const c2 = horizontal ? [mx, to[1]] : [to[0], my];
          const path = document.createElementNS(ns, 'path');
          path.setAttribute('d', `M ${from[0]} ${from[1]} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${to[0]} ${to[1]}`);
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', color);
          path.setAttribute('stroke-width', '2');
          path.setAttribute('stroke-dasharray', '7 7');
          path.setAttribute('opacity', '0.6');
          svg.append(path);

          const dot = document.createElementNS(ns, 'circle');
          dot.setAttribute('cx', to[0]);
          dot.setAttribute('cy', to[1]);
          dot.setAttribute('r', '3.5');
          dot.setAttribute('fill', color);
          dot.setAttribute('opacity', '0.85');
          svg.append(dot);
        }
        const hub = document.createElementNS(ns, 'circle');
        hub.setAttribute('cx', from[0]);
        hub.setAttribute('cy', from[1]);
        hub.setAttribute('r', '6');
        hub.setAttribute('fill', color);
        svg.append(hub);
      }
    }
  }

  /* ------------------------- create / remove ------------------------ */

  /** Auto-tiling is on unless the user turned it off. */
  autoLayoutOn() {
    return store.state.settings.autoLayout !== false;
  }

  /** The app windows on a page, in creation order — the tiling order. */
  tileableNodes(page = store.page) {
    return page.nodes.filter((node) => TILEABLE.has(node.kind) && !node.parked);
  }

  /* ------------------------------ dock ------------------------------ */

  /** Windows that can be parked in the dock (apps and notes). */
  isDockable(node) {
    return TILEABLE.has(node.kind) || node.kind === 'note';
  }

  /**
   * Clear the page into the dock: app windows and notes fly to the bottom-left
   * and wait there, still running; shapes, text and images are removed.
   */
  parkPage(page = store.page) {
    const removed = [];
    const dockable = [];
    this.batch(() => {
      for (const node of [...page.nodes]) {
        if (node.parked) continue;
        if (this.isDockable(node)) {
          dockable.push(node);
        } else {
          this.removeNode(node.id);
          removed.push(node.id);
        }
      }
    });
    this.parkNodes(dockable, page);
    return { parked: dockable.length, removed: removed.length };
  }

  /**
   * "Close" for anything that can live in the dock: the window flies to the
   * bottom-left and keeps running. Shapes, text and images are removed.
   */
  closeNode(id) {
    const found = store.findNode(id);
    if (!found) return false;
    if (found.node.parked || !this.isDockable(found.node)) {
      this.removeNode(id);
      return true;
    }
    this.parkNodes([found.node], found.page);
    return true;
  }

  /** What a parked window looked like when it left (for the dock preview). */
  dockPreview(id) {
    return this.thumbs?.get(id) || null;
  }

  /**
   * Park windows in the dock. They are marked parked at once (so counts and
   * the Director's snapshot are right immediately); a snapshot of each window
   * is taken while it is still on screen, then they fly to the dock together
   * and the remaining windows glide into the freed space.
   */
  parkNodes(nodes, page = store.page) {
    const list = nodes.filter((node) => node && !node.parked);
    if (!list.length) return;
    if (!this.thumbs) this.thumbs = new Map();
    for (const node of list) {
      node.parked = true;
      this.selection.delete(node.id);
      if (this.selectedId === node.id) this.selectedId = null;
      // Text fallback for the preview, captured before the window hides.
      const view = this.views.get(node.id);
      const text = view?.previewText?.() || '';
      this.thumbs.set(node.id, { ...(this.thumbs.get(node.id) || {}), text, at: Date.now() });
    }
    store.save();
    this.drawJointLines();
    // Their dock icons wait, hidden, until each window has flown in.
    dockArriving(list.map((node) => node.id));
    store.emit('dock');
    store.emit('selection', this.selectedId);

    const scale = page.viewport.scale || 1;
    // Sharp previews: a browser's page is captured at full resolution straight
    // from its webview; other windows from the screen at up to 1600px wide.
    const capture = async (node) => {
      const view = this.views.get(node.id);
      if (!view || page.id !== store.page.id || !window.api.win.capture) return null;
      const id = node.kind === 'browser' ? view.webContentsId?.() : null;
      if (id && window.api.win.captureWeb) {
        const shot = await window.api.win.captureWeb({ id, maxWidth: 1600 }).catch(() => null);
        if (shot && shot.data) return `data:${shot.mime};base64,${shot.data}`;
      }
      const rect = view.el.getBoundingClientRect();
      return window.api.win
        .capture({ x: rect.left, y: rect.top, width: rect.width, height: rect.height, maxWidth: 1600 })
        .catch(() => null);
    };
    // Never let a slow capture hold the animation up for long.
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 450));

    Promise.all(list.map((node) => Promise.race([capture(node), timeout]))).then((shots) => {
      list.forEach((node, index) => {
        if (shots[index]) this.thumbs.set(node.id, { ...this.thumbs.get(node.id), src: shots[index] });
        const view = this.views.get(node.id);
        if (!view || !node.parked) {
          dockLanded(node.id);
          return;
        }
        view.el.classList.add('is-leaving');
        // Each shrinks, then flies into its kind's icon; a batch goes one
        // after another.
        const delay = Math.min(index, 8) * 45;
        animateInto(
          view.el,
          dockTargetFor(node),
          scale,
          () => {
            view.el.classList.remove('is-leaving');
            if (node.parked) view.el.classList.add('is-parked');
            dockLanded(node.id);
          },
          { delay }
        );
      });
      this.relayout({ animate: true, page });
      store.emit('dock');
    });
  }

  /** Bring a parked window back out of the dock and into the layout. */
  restoreNode(id, from) {
    const found = store.findNode(id);
    if (!found || !found.node.parked) return false;
    const { node, page } = found;
    if (page.id !== store.page.id) store.setActivePage(store.pages.indexOf(page));
    node.parked = false;
    this.thumbs?.delete(id);
    node.z = ++this.zTop;
    const view = this.views.get(id);
    // Settle the layout first so the window grows straight into its slot.
    this.relayout({ animate: true, page, fresh: new Set([id]) });
    this.drawJointLines();
    if (this.layoutMode(page) === 'flow') this.ensureVisible(id);
    if (view) {
      view.el.classList.remove('is-parked');
      view.el.style.zIndex = String(node.z);
      animateOutOf(view.el, from, page.viewport.scale || 1);
      view.resize?.(node.w, node.h);
    }
    store.save();
    store.emit('dock');
    this.updateHero();
    this.focusNode(id);
    view?.focus?.();
    return true;
  }

  /** The arrangement in use: "grid" means side by side while that setting is on. */
  layoutMode(page = store.page) {
    const mode = page.layout || 'grid';
    return mode === 'grid' && store.state.settings.flowLayout === true ? 'flow' : mode;
  }

  /**
   * Screen space the tiles keep clear of, in px: the prompt bar and the dock
   * below (they share one band), and the page bar above while it is pinned.
   */
  layoutInsets() {
    const insets = { ...LAYOUT.insets };
    if (store.state.settings.pinTopbar) insets.top = 64;
    return insets;
  }

  /**
   * Keep every tiled window in view: glide the camera so the arrangement fills
   * the screen, zooming out only when there are more windows than fit at a
   * readable size.
   */
  frameTiles(rects, page = store.page) {
    if (!rects.length || page.id !== store.page.id) return;
    const insets = this.layoutInsets(page);
    const cw = this.viewportEl.clientWidth;
    const ch = this.viewportEl.clientHeight;
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    const availW = cw - insets.left - insets.right;
    const availH = ch - insets.top - insets.bottom;
    const scale = clamp(Math.min(1, availW / (maxX - minX), availH / (maxY - minY)), MIN_ZOOM, 1);
    const target = {
      scale,
      x: Math.round(insets.left + availW / 2 - ((minX + maxX) / 2) * scale),
      y: Math.round(insets.top + availH / 2 - ((minY + maxY) / 2) * scale),
    };
    const vp = this._vpTarget || page.viewport;
    if (Math.abs(vp.x - target.x) < 1 && Math.abs(vp.y - target.y) < 1 && Math.abs(vp.scale - target.scale) < 0.001) {
      return;
    }
    this.animateViewport(target);
  }

  /**
   * Plan a page. Side-by-side mode: every window keeps its own size and is
   * placed right after the previous one, in the order they were opened; when a
   * row reaches about 1.6 screens wide the next window starts a new row below.
   * Other modes tile everything to fill one screen.
   */
  _plan(page, nodes) {
    const mode = this.layoutMode(page);
    if (mode !== 'flow') {
      const rects = tileRects({
        count: nodes.length,
        view: this.layoutFrame(),
        scale: 1,
        config: { ...LAYOUT, insets: this.layoutInsets(page) },
        mode,
        mainIndex: Math.max(0, nodes.findIndex((node) => node.id === page.mainId)),
      });
      return nodes.map((node, index) => ({ node, rect: rects[index] })).filter((item) => item.rect);
    }
    // Rows run a little wider than the screen, so two or three windows sit
    // side by side and the whole arrangement stays landscape when zoomed out.
    const frame = this.layoutFrame();
    const rowLimit = frame.w * FLOW_ROW_SCREENS;
    const rows = [];
    let row = null;
    for (const node of nodes) {
      const w = Math.round(Math.min(LAYOUT.maxW, Math.max(MIN_W, node.w || 560)));
      const h = Math.round(Math.min(LAYOUT.maxH, Math.max(MIN_H, node.h || 360)));
      if (!row || (row.items.length && row.w + FLOW_GAP + w > rowLimit)) {
        row = { items: [], w: 0, h: 0 };
        rows.push(row);
      }
      row.w += (row.items.length ? FLOW_GAP : 0) + w;
      row.h = Math.max(row.h, h);
      row.items.push({ node, w, h });
    }
    // The whole arrangement sits in the middle of the canvas, each row centred.
    const { top, bottom } = LAYOUT.insets;
    const midX = frame.x + frame.w / 2;
    const midY = frame.y + top + (frame.h - top - bottom) / 2;
    const totalH = rows.reduce((sum, r) => sum + r.h, 0) + FLOW_GAP * Math.max(0, rows.length - 1);
    const plan = [];
    let y = Math.round(midY - totalH / 2);
    for (const r of rows) {
      let x = Math.round(midX - r.w / 2);
      for (const item of r.items) {
        plan.push({ node: item.node, rect: { x, y, w: item.w, h: item.h } });
        x += item.w + FLOW_GAP;
      }
      y += r.h + FLOW_GAP;
    }
    return plan;
  }

  planLayout(page = store.page) {
    return this._plan(page, this.tileableNodes(page));
  }

  /**
   * Re-tile every app window on a page so they sit side by side, filling the
   * screen. Runs on spawn, close, window resize and page switch. Positions and
   * sizes glide into place; notes, shapes and text are left alone.
   */
  relayout(options = {}) {
    if (this._suspendRelayout) return [];
    if (options.force !== true && !this.autoLayoutOn()) return [];
    const page = options.page || store.page;
    const plan = this.planLayout(page);
    if (!plan.length) {
      return [];
    }
    const fresh = options.fresh || null;
    // Tiles share the text size of the smallest one; free-sized windows
    // (side-by-side rows) keep their own.
    if (!this._tileText) this._tileText = new Map();
    const shared =
      this.layoutMode(page) === 'flow'
        ? null
        : Math.min(...plan.map(({ node, rect }) => contentScaleFor({ kind: node.kind, w: rect.w, h: rect.h })));
    for (const { node } of plan) {
      if (shared) this._tileText.set(node.id, shared);
      else this._tileText.delete(node.id);
    }
    for (const { node, rect } of plan) {
      // A window being dragged keeps following the pointer; it drops into
      // its slot when released.
      if (node.id === options.skip) continue;
      node.x = rect.x;
      node.y = rect.y;
      node.w = rect.w;
      node.h = rect.h;
      if (this.views.has(node.id)) {
        // Windows created in this batch are still fading in: place them
        // straight into their final slot rather than sliding.
        const animate = options.animate !== false && !(fresh && fresh.has(node.id));
        this.applyGeometry(node, { animate, duration: options.duration });
      }
    }
    store.save();
    const rects = plan.map((item) => item.rect);
    if (this.layoutMode(page) !== 'flow') this.frameTiles(rects, page);
    return rects;
  }

  /** Switch the page's arrangement ("grid", "columns", "rows" or "focus"). */
  setLayout(mode, mainId, page = store.page) {
    if (LAYOUT_MODES.includes(mode)) page.layout = mode;
    if (mainId !== undefined) page.mainId = mainId || null;
    store.save();
    return this.relayout({ force: true, animate: true, page });
  }

  /** Move a tiled window to a new place in the tile order. */
  _reorderTile(page, id, targetIndex) {
    const node = page.nodes.find((n) => n.id === id);
    if (!node) return false;
    const rest = page.nodes.filter((n) => n.id !== id);
    const tiles = rest.filter((n) => TILEABLE.has(n.kind));
    const before = tiles[Math.max(0, targetIndex)];
    const at = before ? rest.indexOf(before) : rest.length;
    rest.splice(at, 0, node);
    page.nodes.splice(0, page.nodes.length, ...rest);
    return true;
  }

  /** Swap two tiled windows' places. */
  swapNodes(aId, bId, page = store.page) {
    const tiles = this.tileableNodes(page);
    const a = tiles.findIndex((n) => n.id === aId);
    const b = tiles.findIndex((n) => n.id === bId);
    if (a < 0 || b < 0 || a === b) return false;
    const ia = page.nodes.indexOf(tiles[a]);
    const ib = page.nodes.indexOf(tiles[b]);
    [page.nodes[ia], page.nodes[ib]] = [page.nodes[ib], page.nodes[ia]];
    this.relayout({ force: true, animate: true, page });
    return true;
  }

  /** Put the listed windows first in the tile order, in that order. */
  orderNodes(ids, page = store.page) {
    ids.forEach((id, index) => this._reorderTile(page, id, index));
    this.relayout({ force: true, animate: true, page });
  }

  /**
   * Group several canvas mutations into a single re-tile, so closing a batch of
   * windows reflows once instead of once per window.
   */
  batch(fn) {
    this._suspendRelayout = (this._suspendRelayout || 0) + 1;
    if (!this._batchFresh) this._batchFresh = new Set();
    try {
      fn();
    } finally {
      this._suspendRelayout -= 1;
    }
    if (!this._suspendRelayout) this._settleBatch();
  }

  /**
   * Async version of `batch` for actions that await (the Director's `run`
   * executes several at once). Everything lands in one smooth re-tile.
   */
  async batchAsync(fn) {
    this._suspendRelayout = (this._suspendRelayout || 0) + 1;
    if (!this._batchFresh) this._batchFresh = new Set();
    try {
      return await fn();
    } finally {
      this._suspendRelayout -= 1;
      if (!this._suspendRelayout) this._settleBatch();
    }
  }

  _settleBatch() {
    const fresh = this._batchFresh;
    this._batchFresh = null;
    this.relayout({ animate: true, fresh });
  }

  /** The world-space rectangle currently visible in the viewport. */
  visibleWorldRect() {
    // Mid-glide, plan against where the camera is going, not where it is.
    const vp = this._vpTarget || store.page.viewport;
    const scale = vp.scale || 1;
    return {
      x: -vp.x / scale,
      y: -vp.y / scale,
      w: this.viewportEl.clientWidth / scale,
      h: this.viewportEl.clientHeight / scale,
    };
  }

  /**
   * The frame windows tile into: one screen's worth of canvas *at 100% zoom*,
   * in the middle of the canvas (the starting view). Zoom level never changes
   * how big windows are in the world — zoomed out they simply look smaller —
   * so nothing is created oversized and then resolution-stretched to fit.
   */
  layoutFrame() {
    return { x: 0, y: 0, w: this.viewportEl.clientWidth, h: this.viewportEl.clientHeight };
  }


  createNode(partial, options = {}) {
    const { focus = true, silent = false, autoPosition = true } = options;
    const page = store.page;
    const w = partial.w ?? 560;
    const h = partial.h ?? 360;
    const node = {
      id: partial.id || uid('nd'),
      kind: partial.kind || 'terminal',
      cli: partial.cli || 'claude',
      x: partial.x ?? 0,
      y: partial.y ?? 0,
      w,
      h,
      z: ++this.zTop,
      callSign: partial.callSign || 'Node',
      title: partial.title || '',
      subtitle: partial.subtitle || '',
      cwd: partial.cwd ?? store.state.workspace ?? '',
      prompt: partial.prompt || '',
      model: partial.model ?? null,
      effort: partial.effort ?? null,
      joint: partial.joint || null,
      jointName: partial.jointName || '',
      jointContextPath: partial.jointContextPath || '',
      rank: partial.joint ? partial.rank || null : null,
      parentId: partial.joint ? partial.parentId || null : null,
      status: 'idle',
      unread: false,
      payload: partial.payload ?? null,
    };
    const tileable = TILEABLE.has(node.kind) && this.autoLayoutOn();
    let placedInView = true;
    if (tileable) {
      // Reserve the tiled slot before mounting, so the window fades in where
      // it belongs instead of jumping there afterwards.
      const slot = this._nextTileFor(page, node);
      if (slot) {
        node.x = slot.x;
        node.y = slot.y;
        node.w = slot.w;
        node.h = slot.h;
      }
    } else if (autoPosition && partial.x === undefined) {
      const spot = findPlacement({
        nodes: page.nodes,
        w,
        h,
        view: this.visibleWorldRect(),
      });
      node.x = spot.x;
      node.y = spot.y;
      placedInView = spot.inView;
    }
    page.nodes.push(node);
    if (this._suspendRelayout && this._batchFresh) this._batchFresh.add(node.id);
    this.mountNode(node, this.pageEls.get(page.id), { animate: !silent });
    if (!silent) {
      store.save();
      store.emit('nodes');
      this._pushHistory({
        label: 'Add window',
        undo: () => this.removeNode(node.id),
        redo: () => this._recreate(snapshotOf(page.id, node)),
      });
    }
    // Re-tile the whole page so the new window and its neighbours settle into
    // a clean, evenly sized grid.
    if (tileable && !silent) this.relayout({ animate: true });
    // Full-size windows land beside the others: glide over to the new one.
    if (tileable && !silent && focus && this.layoutMode(page) === 'flow') this.ensureVisible(node.id);
    this.updateHero();
    if (focus) {
      this.focusNode(node.id);
      this.views.get(node.id)?.focus?.();
      // The tiled layout always fits the screen; only pan for free placement.
      if (!tileable && !placedInView) this.ensureVisible(node.id);
    }
    return node;
  }

  /** Where a not-yet-added window would land in the current tiling. */
  _nextTileFor(page, candidate) {
    const plan = this._plan(page, [...this.tileableNodes(page), candidate]);
    return plan.find((item) => item.node === candidate)?.rect || null;
  }

  /** Re-create a removed node from a snapshot (used by undo/redo). */
  _recreate(snapshot) {
    const page = store.pages.find((p) => p.id === snapshot.pageId) || store.page;
    const data = { ...snapshot.data, prompt: '', z: ++this.zTop };
    if (page.nodes.some((n) => n.id === data.id)) return null;
    page.nodes.push(data);
    this.mountNode(data, this.pageEls.get(page.id), { animate: true });
    if (page.id === store.page.id) this.updateHero();
    store.save();
    store.emit('nodes');
    // Put it back into the tiled layout rather than its old (now stale) spot.
    if (TILEABLE.has(data.kind)) this.relayout({ animate: true, page });
    this.drawJointLines();
    return data;
  }

  removeNode(id, options = {}) {
    const found = store.findNode(id);
    if (!found) return;
    const snapshot = snapshotOf(found.page.id, found.node);
    this.unmountNode(id, { animate: options.animate !== false });
    store.removeNode(id);
    if (found.page.mainId === id) found.page.mainId = null;
    this.thumbs?.delete(id);
    if (found.node.parked) store.emit('dock');
    this.selection.delete(id);
    if (this.selectedId === id) this.selectedId = null;
    this.updateHero();
    this.drawJointLines();
    store.emit('selection', this.selectedId);
    // Closing a window lets its neighbours grow into the freed space.
    if (TILEABLE.has(found.node.kind)) this.relayout({ animate: true, page: found.page });
    this._pushHistory({
      label: 'Close window',
      undo: () => this._recreate(snapshot),
      redo: () => this.removeNode(id),
    });
  }

  removeSelection() {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.batch(() => {
      for (const id of ids) this.removeNode(id);
    });
    this.setSelection([], null);
  }

  duplicateSelection() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    const created = [];
    for (const node of nodes) {
      const copy = JSON.parse(JSON.stringify(node));
      delete copy.id;
      delete copy.joint;
      delete copy.jointName;
      delete copy.jointContextPath;
      delete copy.rank;
      delete copy.parentId;
      copy.x = node.x + 28;
      copy.y = node.y + 28;
      copy.prompt = '';
      created.push(
        this.createNode(copy, { focus: false, autoPosition: false })
      );
    }
    if (created.length) this.setSelection(created.map((n) => n.id), created[created.length - 1].id);
    return created;
  }

  selectedNodes() {
    return [...this.selection]
      .map((id) => store.findNode(id)?.node)
      .filter(Boolean);
  }

  selectAll() {
    const ids = store.page.nodes.filter((node) => !node.parked).map((node) => node.id);
    this.setSelection(ids, ids[ids.length - 1] || null);
  }

  setSelection(ids, primary = null) {
    this.selection = new Set(ids);
    this.selectedId = primary ?? (ids.length ? ids[ids.length - 1] : null);
    for (const [vid, view] of this.views) {
      view.el.classList.toggle('is-focused', this.selection.has(vid));
    }
    store.emit('selection', this.selectedId);
  }

  /* ---------------------------- history ----------------------------- */

  historyState() {
    return {
      canUndo: this.historyIndex >= 0,
      canRedo: this.historyIndex < this.history.length - 1,
    };
  }

  _pushHistory(entry) {
    if (this._historyLock || !entry) return;
    this.history.splice(this.historyIndex + 1);
    this.history.push(entry);
    if (this.history.length > 80) this.history.shift();
    this.historyIndex = this.history.length - 1;
    store.emit('history', this.historyState());
  }

  undo() {
    if (this.historyIndex < 0) return false;
    const entry = this.history[this.historyIndex];
    this._historyLock = true;
    try {
      entry.undo();
    } catch (error) {
      console.warn('[canvas] undo failed', error);
    } finally {
      this._historyLock = false;
    }
    this.historyIndex -= 1;
    store.emit('history', this.historyState());
    return true;
  }

  redo() {
    if (this.historyIndex >= this.history.length - 1) return false;
    const entry = this.history[this.historyIndex + 1];
    this._historyLock = true;
    try {
      entry.redo();
    } catch (error) {
      console.warn('[canvas] redo failed', error);
    } finally {
      this._historyLock = false;
    }
    this.historyIndex += 1;
    store.emit('history', this.historyState());
    return true;
  }

  /* ------------------------------ focus ----------------------------- */

  focusNode(id, additive = false) {
    const found = store.findNode(id);
    if (!found) return;
    const meta = found.node;
    meta.z = ++this.zTop;

    const view = this.views.get(id);
    if (view) view.el.style.zIndex = String(meta.z);

    if (additive) {
      if (this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
      this.setSelection([...this.selection], id);
    } else {
      this.setSelection([id], id);
    }

    if (meta.unread) {
      meta.unread = false;
      store.emit('status', meta);
    }
    store.save();
  }

  select(id) {
    if (id === null) {
      this.setSelection([], null);
      return;
    }
    this.focusNode(id);
  }

  /* ---------------------------- transform --------------------------- */

  /**
   * The canvas is as big as the view at full zoom-out (MIN_ZOOM), centred on
   * the starting view. It grows to take in any window that sits outside it,
   * so nothing is ever out of reach.
   */
  canvasBounds() {
    const cw = this.viewportEl.clientWidth;
    const ch = this.viewportEl.clientHeight;
    const w = cw / MIN_ZOOM;
    const h = ch / MIN_ZOOM;
    let x0 = cw / 2 - w / 2;
    let y0 = ch / 2 - h / 2;
    let x1 = x0 + w;
    let y1 = y0 + h;
    for (const n of store.page.nodes) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + n.w);
      y1 = Math.max(y1, n.y + n.h);
    }
    return { x0, y0, x1, y1 };
  }

  /** Keep the view inside the canvas; at full zoom-out it can't pan at all. */
  _clampViewport(vp) {
    const cw = this.viewportEl.clientWidth;
    const ch = this.viewportEl.clientHeight;
    if (!cw || !ch) return;
    const b = this.canvasBounds();
    const s = vp.scale;
    const fit = (pos, size, lo, hi) =>
      size / s >= hi - lo ? size / 2 - ((lo + hi) / 2) * s : clamp(pos, size - hi * s, -lo * s);
    vp.x = fit(vp.x, cw, b.x0, b.x1);
    vp.y = fit(vp.y, ch, b.y0, b.y1);
  }

  applyViewport() {
    const vp = store.page.viewport;
    this._clampViewport(vp);
    this.worldEl.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})`;
    // Cheap bitmap scaling while moving; a sharp repaint once it settles.
    this.viewportEl.classList.add('is-moving');
    this._moving = true;
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      this._moving = false;
      this.viewportEl.classList.remove('is-moving');
      this._placeGrid(true);
    }, 180);
    this._placeGrid(false);
    this._cull();

    // Bitmap-backed views (terminals) re-render at the new scale so their
    // glyphs stay sharp instead of being stretched.
    // Off-screen ones wait until they come back into view.
    if (this.appliedScale !== vp.scale) {
      this.appliedScale = vp.scale;
      for (const view of this.views.values()) {
        if (view._culled) view._pendingZoom = vp.scale;
        else view.setZoom?.(vp.scale);
      }
    }
  }

  /**
   * Slide the dot grid by less than one cell (a compositor-only transform).
   * While zooming it is scaled instead of redrawn, and only repaints every
   * 25% of zoom change; once the camera settles (`exact`) it repaints sharp.
   */
  _placeGrid(exact) {
    const vp = store.page.viewport;
    const size = GRID * vp.scale;
    const grid = this.gridEl.style;
    const painted = this._gridSize;
    const ratio = painted ? size / painted : 0;
    if (!painted || exact || ratio < 0.8 || ratio > 1.25) {
      if (size !== painted) {
        this._gridSize = size;
        grid.backgroundSize = `${size}px ${size}px`;
        // Big enough to cover the screen at any in-between scale.
        grid.width = `${this._screen.w * 1.3 + size * 2}px`;
        grid.height = `${this._screen.h * 1.3 + size * 2}px`;
      }
    }
    const k = size / this._gridSize;
    const ox = (((vp.x % size) + size) % size) - size;
    const oy = (((vp.y % size) + size) % size) - size;
    grid.transform = k === 1 ? `translate3d(${ox}px, ${oy}px, 0)` : `translate3d(${ox}px, ${oy}px, 0) scale(${k})`;
  }

  /**
   * Windows well outside the screen are not drawn at all (visibility hidden):
   * their terminals and pages stop painting and the compositor has less to
   * move. A margin of half a screen keeps them drawn just before they scroll
   * in. Music players are never culled, so playback is never interrupted.
   */
  _cull() {
    const page = store.page;
    const vp = page.viewport;
    const { w, h } = this._screen;
    const mx = w * 0.5;
    const my = h * 0.5;
    for (const node of page.nodes) {
      const view = this.views.get(node.id);
      if (!view || node.kind === 'music') continue;
      const left = node.x * vp.scale + vp.x;
      const top = node.y * vp.scale + vp.y;
      const off =
        left > w + mx || top > h + my || left + node.w * vp.scale < -mx || top + node.h * vp.scale < -my;
      if (off !== Boolean(view._culled)) {
        view._culled = off;
        view.el.classList.toggle('is-culled', off);
        if (!off && view._pendingZoom !== undefined) {
          view.setZoom?.(view._pendingZoom);
          view._pendingZoom = undefined;
        }
      }
    }
  }

  /** Re-check culling once windows have moved (coalesced to one per frame). */
  _scheduleCull() {
    if (this._cullFrame) return;
    this._cullFrame = requestAnimationFrame(() => {
      this._cullFrame = 0;
      this._cull();
    });
  }

  screenToWorld(clientX, clientY) {
    const vp = store.page.viewport;
    return { x: (clientX - vp.x) / vp.scale, y: (clientY - vp.y) / vp.scale };
  }

  /**
   * Glide the camera to a new position/zoom. Used for every programmatic
   * camera move (focus, fit, zoom commands) so the view never jumps.
   */
  animateViewport(target, { duration = 380 } = {}) {
    const vp = store.page.viewport;
    this.stopViewportAnimation();
    const to = {
      x: Number.isFinite(target.x) ? target.x : vp.x,
      y: Number.isFinite(target.y) ? target.y : vp.y,
      scale: Number.isFinite(target.scale) ? clamp(target.scale, MIN_ZOOM, MAX_ZOOM) : vp.scale,
    };
    this._clampViewport(to);
    if (prefersReducedMotion() || duration <= 0) {
      Object.assign(vp, to);
      this.applyViewport();
      store.save();
      return;
    }
    const from = { x: vp.x, y: vp.y, scale: vp.scale };
    const pageId = store.page.id;
    this._vpTarget = to;
    const start = performance.now();
    const step = (now) => {
      if (store.page.id !== pageId) {
        this._vpRaf = 0;
        this._vpTarget = null;
        return;
      }
      const t = Math.min(1, (now - start) / duration);
      const k = 1 - Math.pow(1 - t, 3);
      vp.scale = from.scale * Math.pow(to.scale / from.scale, k);
      vp.x = from.x + (to.x - from.x) * k;
      vp.y = from.y + (to.y - from.y) * k;
      this.applyViewport();
      if (t < 1) {
        this._vpRaf = requestAnimationFrame(step);
      } else {
        this._vpRaf = 0;
        this._vpTarget = null;
        store.save();
      }
    };
    this._vpRaf = requestAnimationFrame(step);
  }

  stopViewportAnimation() {
    if (this._vpRaf) cancelAnimationFrame(this._vpRaf);
    this._vpRaf = 0;
    this._vpTarget = null;
  }

  /** Frame every window on the page. */
  fitAll() {
    const nodes = store.page.nodes;
    if (!nodes.length) return;
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + n.w));
    const maxY = Math.max(...nodes.map((n) => n.y + n.h));
    const cw = this.viewportEl.clientWidth;
    const ch = this.viewportEl.clientHeight;
    const scale = clamp(Math.min((cw - 120) / (maxX - minX), (ch - 200) / (maxY - minY)), MIN_ZOOM, 1.4);
    this.animateViewport({
      scale,
      x: cw / 2 - ((minX + maxX) / 2) * scale,
      y: ch / 2 - ((minY + maxY) / 2) * scale + 10,
    });
  }

  panBy(dx, dy) {
    this.stopViewportAnimation();
    const vp = store.page.viewport;
    vp.x += dx;
    vp.y += dy;
    this.applyViewport();
    store.save();
  }

  zoomAt(clientX, clientY, factor) {
    this.stopViewportAnimation();
    const vp = store.page.viewport;
    const next = clamp(vp.scale * factor, MIN_ZOOM, MAX_ZOOM);
    const k = next / vp.scale;
    vp.x = clientX - (clientX - vp.x) * k;
    vp.y = clientY - (clientY - vp.y) * k;
    vp.scale = next;
    this.applyViewport();
    store.save();
  }

  setZoom(scale, anchor) {
    const vp = store.page.viewport;
    const cx = anchor?.x ?? this.viewportEl.clientWidth / 2;
    const cy = anchor?.y ?? this.viewportEl.clientHeight / 2;
    const next = clamp(scale, MIN_ZOOM, MAX_ZOOM);
    const k = next / vp.scale;
    this.animateViewport(
      { scale: next, x: cx - (cx - vp.x) * k, y: cy - (cy - vp.y) * k },
      { duration: 240 }
    );
  }

  resetZoom() {
    this.setZoom(1);
  }

  centerNode(id) {
    const found = store.findNode(id);
    if (!found) return;
    const meta = found.node;
    const vp = store.page.viewport;
    this.animateViewport({
      x: this.viewportEl.clientWidth / 2 - (meta.x + meta.w / 2) * vp.scale,
      y: this.viewportEl.clientHeight / 2 - (meta.y + meta.h / 2) * vp.scale,
    });
  }

  fitNode(id) {
    const found = store.findNode(id);
    if (!found) return;
    const meta = found.node;
    const vp = store.page.viewport;
    const pad = 110;
    const scale = clamp(
      Math.min(
        (this.viewportEl.clientWidth - pad) / meta.w,
        (this.viewportEl.clientHeight - pad * 1.6) / meta.h
      ),
      MIN_ZOOM,
      1.6
    );
    this.animateViewport({
      scale,
      x: this.viewportEl.clientWidth / 2 - (meta.x + meta.w / 2) * scale,
      y: this.viewportEl.clientHeight / 2 - (meta.y + meta.h / 2) * scale + 20,
    });
  }

  ensureVisible(id) {
    const found = store.findNode(id);
    if (!found) return;
    const meta = found.node;
    const vp = store.page.viewport;
    const left = meta.x * vp.scale + vp.x;
    const top = meta.y * vp.scale + vp.y;
    const right = left + meta.w * vp.scale;
    const bottom = top + meta.h * vp.scale;
    const margin = 80;
    let dx = 0;
    let dy = 0;
    if (left < margin) dx = margin - left;
    else if (right > this.viewportEl.clientWidth - margin) {
      dx = Math.min(left - margin, this.viewportEl.clientWidth - margin - right);
    }
    if (top < margin + 40) dy = margin + 40 - top;
    else if (bottom > this.viewportEl.clientHeight - margin) {
      dy = Math.min(top - margin - 40, this.viewportEl.clientHeight - margin - bottom);
    }
    if (dx || dy) this.animateViewport({ x: vp.x + dx, y: vp.y + dy });
  }

  focusAgent(id) {
    const found = store.findNode(id);
    if (!found) return;
    if (found.node.parked) {
      this.restoreNode(id);
      return;
    }
    const pageIndex = store.pages.indexOf(found.page);
    if (pageIndex !== store.activeIndex) store.setActivePage(pageIndex);
    // Tiled windows already sit on screen; only pan for ones that do not.
    if (!this.isOnScreen(id) || !(TILEABLE.has(found.node.kind) && this.autoLayoutOn())) {
      this.centerNode(id);
    }
    this.focusNode(id);
    const view = this.views.get(id);
    view?.focus?.();
  }

  /* ------------------------- interactions --------------------------- */

  _onViewportPointerDown(event) {
    const target = event.target;

    // Windows and their contents own their input. Dragging inside a terminal,
    // note or shape must never pan the canvas underneath it.
    if (target.closest?.('.node')) return;

    const onEmpty =
      target === this.viewportEl ||
      target === this.worldEl ||
      target.classList?.contains('page') ||
      target.classList?.contains('hero');
    if (!onEmpty) return;

    if (event.button === 1) {
      this._startPan(event);
      return;
    }
    if (event.button !== 0) return;

    // Shift + drag on empty canvas draws a selection marquee.
    if (event.shiftKey && (this.tool === 'select' || this.tool === 'hand')) {
      this._startMarquee(event);
      return;
    }

    if (this.tool === 'text') {
      this._createTextAt(event);
      return;
    }
    if (this.tool === 'note') {
      this._createNoteAt(event);
      return;
    }
    if (SHAPE_TOOLS.has(this.tool)) {
      this._startDraw(event);
      return;
    }

    // Select and hand both grab the empty canvas by default.
    this.select(null);
    this._startPan(event);
  }

  _startMarquee(event) {
    const start = this.screenToWorld(event.clientX, event.clientY);
    const rect = el('div', { class: 'marquee' });
    this.worldEl.append(rect);
    try {
      this.viewportEl.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    const move = (ev) => {
      const point = this.screenToWorld(ev.clientX, ev.clientY);
      const left = Math.min(start.x, point.x);
      const top = Math.min(start.y, point.y);
      const width = Math.abs(point.x - start.x);
      const height = Math.abs(point.y - start.y);
      rect.style.left = `${left}px`;
      rect.style.top = `${top}px`;
      rect.style.width = `${width}px`;
      rect.style.height = `${height}px`;
      const box = { left, top, right: left + width, bottom: top + height };
      const ids = store.page.nodes
        .filter(
          (node) =>
            node.x < box.right &&
            node.x + node.w > box.left &&
            node.y < box.bottom &&
            node.y + node.h > box.top
        )
        .map((node) => node.id);
      this.setSelection(ids, ids[ids.length - 1] || null);
    };
    const up = () => {
      rect.remove();
      try {
        this.viewportEl.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      this.viewportEl.removeEventListener('pointermove', move);
      this.viewportEl.removeEventListener('pointerup', up);
      this.viewportEl.removeEventListener('pointercancel', up);
    };
    this.viewportEl.addEventListener('pointermove', move);
    this.viewportEl.addEventListener('pointerup', up);
    this.viewportEl.addEventListener('pointercancel', up);
    event.preventDefault();
  }

  _startPan(event) {
    const vp = store.page.viewport;
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = vp.x;
    const originY = vp.y;
    this.viewportEl.classList.add('is-panning');
    try {
      this.viewportEl.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic pointers have no capture target */
    }

    const move = (ev) => {
      vp.x = originX + (ev.clientX - startX);
      vp.y = originY + (ev.clientY - startY);
      this.applyViewport();
    };
    const up = () => {
      this.viewportEl.classList.remove('is-panning');
      try {
        this.viewportEl.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      this.viewportEl.removeEventListener('pointermove', move);
      this.viewportEl.removeEventListener('pointerup', up);
      this.viewportEl.removeEventListener('pointercancel', up);
      store.save();
    };
    this.viewportEl.addEventListener('pointermove', move);
    this.viewportEl.addEventListener('pointerup', up);
    this.viewportEl.addEventListener('pointercancel', up);
    event.preventDefault();
  }

  _onWheel(event) {
    // The wheel zooms the canvas by default (no modifier needed). Content that
    // scrolls — terminals, notes, the chat log, radio results, the browser —
    // keeps the wheel so it can be scrolled.
    const scrollable = event.target.closest?.(
      '.node--terminal, .node--note, .node--text, .node--browser, .chat-log, .music-results'
    );
    if (scrollable && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0022));
  }

  _startNodeDrag(event, meta, view) {
    if (event.button !== 0) return;
    if (!this.selection.has(meta.id)) this.focusNode(meta.id, event.shiftKey);
    else if (event.shiftKey) this.focusNode(meta.id, true);

    const scale = store.page.viewport.scale;
    const startX = event.clientX;
    const startY = event.clientY;
    const nodes = this.selectedNodes();
    const starts = nodes.map((node) => ({ node, x: node.x, y: node.y }));
    const page = store.page;
    // In the tiled layout a dragged window does not float free: its
    // neighbours make room as it passes over their slots, and it drops into
    // the slot under it.
    const reorder =
      this.autoLayoutOn() && TILEABLE.has(meta.kind) && starts.length === 1 && starts[0].node === meta;
    let lastReorder = 0;
    let frame = 0;
    let pointer = null;
    view.el.classList.add('is-dragging');
    try {
      view.el.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    const paint = () => {
      frame = 0;
      if (!pointer) return;
      const dx = (pointer.x - startX) / scale;
      const dy = (pointer.y - startY) / scale;
      for (const start of starts) {
        start.node.x = start.x + dx;
        start.node.y = start.y + dy;
        const nodeView = this.views.get(start.node.id);
        if (nodeView) {
          nodeView.el.style.left = `${start.node.x}px`;
          nodeView.el.style.top = `${start.node.y}px`;
        }
      }
      if (reorder) this._dragReorder(page, meta, pointer, () => {
        const now = performance.now();
        if (now - lastReorder < 140) return false;
        lastReorder = now;
        return true;
      });
      this.drawJointLines();
    };
    // Coalesce pointer events into one paint per frame.
    const move = (ev) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const up = () => {
      view.el.classList.remove('is-dragging');
      try {
        view.el.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      view.el.removeEventListener('pointermove', move);
      view.el.removeEventListener('pointerup', up);
      view.el.removeEventListener('pointercancel', up);
      if (frame) {
        cancelAnimationFrame(frame);
        paint();
      }
      if (reorder) {
        // Settle into the slot it was dropped on.
        this.relayout({ animate: true, page });
        return;
      }
      if (store.state.settings.snapToGrid) {
        for (const start of starts) {
          start.node.x = Math.round(start.node.x / GRID) * GRID;
          start.node.y = Math.round(start.node.y / GRID) * GRID;
          this.applyGeometry(start.node);
        }
      }
      store.save();
      const ends = starts.map((start) => ({ node: start.node, x: start.node.x, y: start.node.y }));
      if (ends.some((end, index) => end.x !== starts[index].x || end.y !== starts[index].y)) {
        this._pushHistory({
          label: 'Move',
          undo: () => {
            for (const start of starts) this._setNodePos(start.node, start.x, start.y);
          },
          redo: () => {
            for (const end of ends) this._setNodePos(end.node, end.x, end.y);
          },
        });
      }
    };
    view.el.addEventListener('pointermove', move);
    view.el.addEventListener('pointerup', up);
    view.el.addEventListener('pointercancel', up);
    event.preventDefault();
  }

  /** While dragging a tiled window, move it to the slot under the pointer. */
  _dragReorder(page, meta, pointer, allow) {
    const world = this.screenToWorld(pointer.x, pointer.y);
    const plan = this.planLayout(page);
    const current = plan.findIndex((item) => item.node.id === meta.id);
    const target = plan.findIndex(
      ({ rect }) =>
        world.x >= rect.x && world.x <= rect.x + rect.w && world.y >= rect.y && world.y <= rect.y + rect.h
    );
    if (target < 0 || target === current || !allow()) return;
    this._reorderTile(page, meta.id, target);
    this.relayout({ animate: true, page, skip: meta.id });
  }

  _setNodePos(node, x, y) {
    node.x = x;
    node.y = y;
    this.applyGeometry(node, { animate: true });
    store.save();
  }

  _setNodeSize(node, w, h) {
    node.w = w;
    node.h = h;
    this.applyGeometry(node);
    store.save();
  }

  _startNodeResize(event, meta, view) {
    if (event.button !== 0) return;
    event.stopPropagation();
    this.focusNode(meta.id);
    const scale = store.page.viewport.scale;
    const startX = event.clientX;
    const startY = event.clientY;
    const originW = meta.w;
    const originH = meta.h;
    const minW = meta.kind === 'shape' ? SHAPE_MIN : MIN_W;
    const minH = meta.kind === 'shape' ? SHAPE_MIN : MIN_H;
    const maxW = meta.kind === 'shape' ? Infinity : LAYOUT.maxW;
    const maxH = meta.kind === 'shape' ? Infinity : LAYOUT.maxH;
    view.el.classList.add('is-resizing');
    try {
      view.el.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    const move = (ev) => {
      meta.w = Math.min(maxW, Math.max(minW, originW + (ev.clientX - startX) / scale));
      meta.h = Math.min(maxH, Math.max(minH, originH + (ev.clientY - startY) / scale));
      this.applyGeometry(meta);
    };
    const up = () => {
      view.el.classList.remove('is-resizing');
      try {
        view.el.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      view.el.removeEventListener('pointermove', move);
      view.el.removeEventListener('pointerup', up);
      view.el.removeEventListener('pointercancel', up);
      if (store.state.settings.snapToGrid) {
        meta.w = Math.round(meta.w / GRID) * GRID;
        meta.h = Math.round(meta.h / GRID) * GRID;
        this.applyGeometry(meta);
      }
      store.save();
      if (meta.w !== originW || meta.h !== originH) {
        const w = meta.w;
        const h = meta.h;
        this._pushHistory({
          label: 'Resize',
          undo: () => this._setNodeSize(meta, originW, originH),
          redo: () => this._setNodeSize(meta, w, h),
        });
      }
    };
    view.el.addEventListener('pointermove', move);
    view.el.addEventListener('pointerup', up);
    view.el.addEventListener('pointercancel', up);
  }

  /* ----------------------------- drawing ---------------------------- */

  setTool(tool) {
    this.tool = tool;
    this.viewportEl.classList.toggle('tool-draw', SHAPE_TOOLS.has(tool));
    store.emit('tool', tool);
  }

  _startDraw(event) {
    const start = this.screenToWorld(event.clientX, event.clientY);
    const tool = this.tool;
    const shape = tool === 'pen' ? 'draw' : tool;
    const color = SHAPE_COLORS[this.shapeColor++ % SHAPE_COLORS.length];

    const node = this.createNode(
      {
        kind: 'shape',
        x: start.x,
        y: start.y,
        w: 1,
        h: 1,
        callSign: shape,
        payload: { shape, color, points: shape === 'draw' ? [[0, 0]] : null, a: [0, 0] },
      },
      { focus: false, silent: true, autoPosition: false }
    );

    this.drawState = { node, start, shape, points: [[start.x, start.y]], pointerId: event.pointerId };
    this.viewportEl.classList.add('is-drawing');
    try {
      this.viewportEl.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic pointers have no capture target */
    }

    const move = (ev) => this._updateDraw(ev);
    const up = () => this._endDraw();
    this.viewportEl.addEventListener('pointermove', move);
    this.viewportEl.addEventListener('pointerup', up);
    this.viewportEl.addEventListener('pointercancel', up);
    this.drawState.cleanup = () => {
      this.viewportEl.removeEventListener('pointermove', move);
      this.viewportEl.removeEventListener('pointerup', up);
      this.viewportEl.removeEventListener('pointercancel', up);
    };
    event.preventDefault();
  }

  _updateDraw(event) {
    const state = this.drawState;
    if (!state) return;
    const point = this.screenToWorld(event.clientX, event.clientY);
    const meta = state.node;

    if (state.shape === 'draw') {
      const last = state.points[state.points.length - 1];
      if (Math.hypot(point.x - last[0], point.y - last[1]) > 3) state.points.push([point.x, point.y]);
      const xs = state.points.map((p) => p[0]);
      const ys = state.points.map((p) => p[1]);
      const pad = 6;
      const minX = Math.min(...xs) - pad;
      const minY = Math.min(...ys) - pad;
      meta.x = minX;
      meta.y = minY;
      meta.w = Math.max(1, Math.max(...xs) + pad - minX);
      meta.h = Math.max(1, Math.max(...ys) + pad - minY);
      meta.payload.points = state.points.map(([x, y]) => [
        (x - meta.x) / meta.w,
        (y - meta.y) / meta.h,
      ]);
    } else {
      meta.x = Math.min(state.start.x, point.x);
      meta.y = Math.min(state.start.y, point.y);
      meta.w = Math.max(1, Math.abs(point.x - state.start.x));
      meta.h = Math.max(1, Math.abs(point.y - state.start.y));
      meta.payload.a = [(state.start.x - meta.x) / meta.w, (state.start.y - meta.y) / meta.h];
    }
    this.applyGeometry(meta);
  }

  _endDraw() {
    const state = this.drawState;
    if (!state) return;
    this.drawState = null;
    state.cleanup?.();
    this.viewportEl.classList.remove('is-drawing');
    try {
      this.viewportEl.releasePointerCapture(state.pointerId);
    } catch {
      /* ignore */
    }

    const meta = state.node;
    const tooSmall = state.shape === 'draw' ? state.points.length < 2 : meta.w < 8 && meta.h < 8;
    if (tooSmall) {
      this.removeNode(meta.id);
    } else {
      if (store.state.settings.snapToGrid) {
        meta.x = Math.round(meta.x / GRID) * GRID;
        meta.y = Math.round(meta.y / GRID) * GRID;
        this.applyGeometry(meta);
      }
      store.save();
      store.emit('nodes');
      this.focusNode(meta.id);
    }
    if (state.shape !== 'draw') this.setTool('select');
  }

  _createTextAt(event) {
    const point = this.screenToWorld(event.clientX, event.clientY);
    const node = this.createNode({
      kind: 'text',
      x: point.x - 140,
      y: point.y - 20,
      w: 320,
      h: 96,
      callSign: 'Text',
      payload: { text: '' },
    });
    this.setTool('select');
    const view = this.views.get(node.id);
    view?.focus?.();
  }

  _createNoteAt(event) {
    const point = this.screenToWorld(event.clientX, event.clientY);
    const node = this.createNode({
      kind: 'note',
      x: point.x - 130,
      y: point.y - 90,
      w: 280,
      h: 200,
      callSign: 'Note',
      payload: { text: '' },
    });
    this.setTool('select');
    const view = this.views.get(node.id);
    view?.focus?.();
  }

  _onDrop(event) {
    event.preventDefault();
    this.viewportEl.classList.remove('is-drop-target');
    const files = Array.from(event.dataTransfer?.files || []).filter((f) =>
      f.type.startsWith('image/')
    );
    if (!files.length) return;
    const origin = this.screenToWorld(event.clientX, event.clientY);
    let offset = 0;
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        this.createNode({
          kind: 'image',
          x: origin.x + offset - 210,
          y: origin.y + offset - 150,
          w: 420,
          h: 300,
          callSign: file.name,
          payload: { src: reader.result },
        });
      };
      reader.readAsDataURL(file);
      offset += 28;
    }
  }

  /* --------------------------- visibility --------------------------- */

  isFocused(id) {
    return this.selectedId === id;
  }

  refreshTitles(id) {
    this.views.get(id)?.syncTitles?.();
  }

  isOnScreen(id) {
    const found = store.findNode(id);
    if (!found || found.page.id !== store.page.id || found.node.parked) return false;
    const meta = found.node;
    const vp = store.page.viewport;
    const left = meta.x * vp.scale + vp.x;
    const top = meta.y * vp.scale + vp.y;
    const right = left + meta.w * vp.scale;
    const bottom = top + meta.h * vp.scale;
    return (
      left < this.viewportEl.clientWidth &&
      top < this.viewportEl.clientHeight &&
      right > 0 &&
      bottom > 0
    );
  }

  /* ------------------------------ misc ------------------------------ */

  tidy() {
    if (this.autoLayoutOn()) {
      this.setLayout('grid');
      return;
    }
    const vp = store.page.viewport;
    const cw = this.viewportEl.clientWidth;
    const ch = this.viewportEl.clientHeight;
    const gap = 30;
    const columns = Math.max(1, Math.ceil(Math.sqrt(store.page.nodes.length)));
    let column = 0;
    let row = 0;
    let rowHeight = 0;
    let cursorX = 90;
    let cursorY = 90;
    const scale = vp.scale;

    for (const node of store.page.nodes) {
      if (node.w * scale > (cw - 180) / 2) {
        if (column !== 0) {
          column = 0;
          row += 1;
          cursorX = 90;
          cursorY += rowHeight + gap;
          rowHeight = 0;
        }
      }
      node.x = cursorX;
      node.y = cursorY;
      cursorX += node.w + gap;
      rowHeight = Math.max(rowHeight, node.h);
      column += 1;
      if (column >= columns) {
        column = 0;
        row += 1;
        cursorX = 90;
        cursorY += rowHeight + gap;
        rowHeight = 0;
      }
      this.applyGeometry(node, { animate: true });
    }
    this.applyViewport();
    store.save();
  }
}
