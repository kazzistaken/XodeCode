import { $, el } from './util.js';
import { store } from './store.js';
import { Canvas } from './canvas.js';
import { spawnClaude, spawnShell, writeToNode } from './terminal.js';
import { openBrowser } from './browser.js';
import { openMusic } from './music.js';
import { openBoard } from './board.js';
import './shapes.js';
import { initCommandBar } from './commandbar.js';
import { initDirectorPanel, buildDirectorSheet } from './directorpanel.js';
import { initMenubar } from './menubar.js';
import { initTopbar } from './topbar.js';
import { migrateBackground } from './backgrounds.js';
import { createSceneView } from './scenes/view.js';
import { initQuick } from './quick.js';
import { initVoice } from './voice.js';
import { initNotifications } from './notifications.js';
import { initDock } from './dock.js';
import { initOnboarding } from './onboarding.js';
import { initHierarchy } from './hierarchy.js';
import { buildHierarchySheet } from './hierarchyview.js';
import { initSettings } from './settings.js';
import { initPages } from './pages.js';
import { initControl, normalizeModel, normalizeEffort, canvasSummary, directorContext } from './control.js';
import { director } from './director.js';
import { openOverlay, closeOverlay, isOverlayOpen } from './overlay.js';

// Collected so the smoke test can report anything that blew up during boot.
window.__errors = [];
window.addEventListener('error', (event) => window.__errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) =>
  window.__errors.push(`unhandled: ${String(event.reason)}`)
);

const TOOL_KEYS = {
  v: 'select',
  r: 'rect',
  d: 'diamond',
  o: 'ellipse',
  a: 'arrow',
  l: 'line',
  p: 'pen',
  t: 'text',
  n: 'note',
};

/* ------------------------------ toasts ------------------------------ */

const TOAST_LIMIT = 3;

/** A one-line note in the top-right stack. Hovering keeps it open. */
function toast(message, kind = '') {
  const list = $('#toasts');
  const node = el(
    'div',
    { class: `toast${kind ? ` is-${kind}` : ''}`, role: 'status', title: message },
    el('span', { class: 'toast-mark', 'aria-hidden': 'true' }),
    el('span', { class: 'toast-text', text: message })
  );
  list.prepend(node);
  while (list.children.length > TOAST_LIMIT) list.lastElementChild.remove();

  let timer = 0;
  const leave = () => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 160);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(leave, kind === 'warn' ? 5000 : 3000);
  };
  node.addEventListener('pointerenter', () => clearTimeout(timer));
  node.addEventListener('pointerleave', arm);
  node.addEventListener('click', leave);
  arm();
}

/* ------------------------------- boot ------------------------------- */

store.load();
document.documentElement.dataset.theme = store.state.theme;

let sceneView = null;

function applyBackground() {
  const background = store.state.settings.background;
  const fit = store.state.settings.backgroundFit || 'contain';
  const viewport = $('#viewport');
  const scene = String(background || '').startsWith('scene:') ? background.slice(6) : '';
  // Animated scenes draw into their own canvas behind the windows.
  const host = viewport.querySelector('.world-bg');
  if (scene && host) {
    sceneView ||= createSceneView(host);
    sceneView.show(scene);
    sceneView.setPlaying(store.state.settings.animateScene !== false);
  } else {
    sceneView?.hide();
  }
  viewport.classList.toggle('has-scene', Boolean(scene));
  if (scene) {
    viewport.style.removeProperty('--canvas-image');
    viewport.style.setProperty('--bg-base', store.state.settings.backgroundBase || '#0c0d0f');
    viewport.classList.add('has-background');
    delete viewport.dataset.bgFit;
    delete viewport.dataset.bgPixel;
  } else if (background) {
    viewport.style.setProperty('--canvas-image', `url("${background}")`);
    viewport.dataset.bgFit = fit;
    viewport.dataset.bgPixel = String(Boolean(store.state.settings.backgroundPixel));
    if (store.state.settings.backgroundBase) {
      viewport.style.setProperty('--bg-base', store.state.settings.backgroundBase);
    } else {
      viewport.style.removeProperty('--bg-base');
    }
    viewport.classList.add('has-background');
  } else {
    viewport.classList.remove('has-background');
    delete viewport.dataset.bgFit;
    delete viewport.dataset.bgPixel;
    viewport.style.removeProperty('--canvas-image');
  }
}

migrateBackground();
store.on('settings', applyBackground);

// Glass is the default look; "Flat colors" swaps it for solid surfaces.
function applyLook() {
  document.documentElement.classList.toggle('ui-flat', Boolean(store.state.settings.flatUi));
}

applyLook();
store.on('settings', applyLook);

const canvas = new Canvas({ viewport: $('#viewport'), world: $('#world') });
// The background needs the canvas's background layer.
applyBackground();
canvas.onHeroAction = () => pickPageWorkspace();

let notifications;
let settings;
let pages;
let commandBar;
let voice;
let quick;
let directorPanel;

function syncContext() {
  window.api.context.sync(store.state.sharedContext || '');
}

async function pickWorkspace() {
  const dir = await window.api.sys.pickFolder(store.state.workspace || undefined);
  if (!dir) return;
  store.setWorkspace(dir);
  toast(`Workspace set to ${dir}`);
}

async function pickPageWorkspace(pageId) {
  const id = pageId || store.page.id;
  const page = store.pages.find((p) => p.id === id) || store.page;
  const dir = await window.api.sys.pickFolder(page.workspace || store.state.workspace || undefined);
  if (!dir) return;
  store.setPageWorkspace(id, dir);
  toast(`This tab now works in ${dir}`);
}

async function pickImage() {
  try {
    const picked = await window.api.sys.pickImage();
    if (!picked) return;
    const vp = store.page.viewport;
    const x = (canvas.viewportEl.clientWidth / 2 - vp.x) / vp.scale - 210;
    const y = (canvas.viewportEl.clientHeight / 2 - vp.y) / vp.scale - 150;
    canvas.createNode({
      kind: 'image',
      x,
      y,
      w: 420,
      h: 300,
      callSign: picked.name,
      payload: { src: picked.dataUrl },
    });
  } catch (error) {
    toast(error?.message || 'Could not place that image.', 'warn');
  }
}

/** Clear the canvas: windows park in the dock (bottom-left) instead of closing. */
function clearPage() {
  if (!store.page.nodes.some((node) => !node.parked)) return { parked: 0, removed: 0 };
  const result = canvas.parkPage();
  notifications.clearAttention();
  return result;
}

function openDirectorLog() {
  const sheet = buildDirectorSheet(ctx, () => closeOverlay());
  openOverlay(sheet.el, () => sheet.destroy());
  setTimeout(() => sheet.focus(), 0);
}

function openHierarchy() {
  const sheet = buildHierarchySheet(ctx, () => closeOverlay());
  openOverlay(sheet.el, () => sheet.destroy());
}

const ctx = {
  canvas,
  store,
  toast,
  sysInfo: { claude: false, shell: '', platform: '', version: '0.1.0', paths: {}, models: {} },
  openSettings: (tab) => settings.open(tab),
  openMap: () => pages.openMap(),
  openDirectorLog,
  openHierarchy,
  spawnClaude: () => spawnClaude(canvas),
  spawnShell: () => spawnShell(canvas),
  openBrowser: (url) => openBrowser(canvas, url),
  openMusic: (options) => openMusic(canvas, options),
  openBoard: (options) => openBoard(canvas, options),
  focusPrompt: () => commandBar.focus(),
  pickWorkspace,
  pickPageWorkspace,
  pickImage,
  clearPage,
  syncContext,
  director,
};

commandBar = initCommandBar(ctx);
voice = initVoice(ctx);
notifications = initNotifications(ctx);
directorPanel = initDirectorPanel(ctx);
initDock(ctx);
directorPanel.el.addEventListener('open-log', () => openDirectorLog());
settings = initSettings(ctx);
pages = initPages(ctx);
quick = initQuick(ctx);
ctx.tryQuick = quick.tryHandle;
initMenubar(ctx);
initTopbar();

canvas.mountAll();
initControl(ctx);
initHierarchy(canvas);
// First-run setup and the guided tour (both replayable from Help).
const onboarding = initOnboarding(ctx);
ctx.startSetup = () => onboarding.start();
ctx.startTour = () => onboarding.tour();

/* ----------------------------- director ----------------------------- */

// Every prompt carries a snapshot of the canvas, so the Director can act in
// one turn without first asking what is open.
director.setContextProvider((options) => directorContext(ctx, options));

window.api.context
  .read()
  .then((text) => {
    if (typeof text === 'string' && text.trim()) {
      store.state.sharedContext = text;
      store.save();
    } else {
      syncContext();
    }
  })
  .catch(() => {});

director.start();

/* --------------------------- window chrome -------------------------- */

$('#win-min').addEventListener('click', () => window.api.win.minimize());
$('#win-max').addEventListener('click', () => window.api.win.toggleMaximize());
$('#win-close').addEventListener('click', () => window.api.win.close());

store.on('theme', (theme) => {
  document.documentElement.dataset.theme = theme;
});

window.api.sys
  .info()
  .then((info) => {
    ctx.sysInfo = info;
    if (!info.claude) {
      toast('Claude Code was not found on PATH — install it to launch agents.', 'warn');
    }
  })
  .catch(() => {});

/* ----------------------------- shortcuts ---------------------------- */

function isTyping(target) {
  const tag = target?.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || Boolean(target?.isContentEditable);
}

window.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key;

  if (mod && key.toLowerCase() === 'k') {
    event.preventDefault();
    commandBar.focus();
    return;
  }
  if (mod && event.shiftKey && key.toLowerCase() === 'd') {
    event.preventDefault();
    openDirectorLog();
    return;
  }
  if (mod && event.shiftKey && key.toLowerCase() === 'm') {
    event.preventDefault();
    voice.toggle();
    return;
  }
  if (mod && key.toLowerCase() === 'n') {
    event.preventDefault();
    if (event.shiftKey) spawnShell(canvas);
    else spawnClaude(canvas);
    return;
  }
  if (mod && key.toLowerCase() === 't') {
    event.preventDefault();
    spawnShell(canvas);
    return;
  }
  if (mod && (key === ',' || key === '<')) {
    event.preventDefault();
    settings.open();
    return;
  }
  if (mod && key >= '1' && key <= '9') {
    event.preventDefault();
    store.setActivePage(Number(key) - 1);
    return;
  }
  if (mod && event.shiftKey && key.toLowerCase() === 'h') {
    event.preventDefault();
    openHierarchy();
    return;
  }
  if (mod && event.shiftKey && key.toLowerCase() === 'o') {
    event.preventDefault();
    pages.openMap();
    return;
  }
  if (mod && key === '0') {
    event.preventDefault();
    canvas.resetZoom();
    return;
  }
  if (mod && (key === '=' || key === '+')) {
    event.preventDefault();
    canvas.setZoom(store.page.viewport.scale * 1.15);
    return;
  }
  if (mod && (key === '-' || key === '_')) {
    event.preventDefault();
    canvas.setZoom(store.page.viewport.scale / 1.15);
    return;
  }

  if (isTyping(event.target)) return;

  if (mod && key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) canvas.redo();
    else canvas.undo();
    return;
  }
  if (mod && key.toLowerCase() === 'y') {
    event.preventDefault();
    canvas.redo();
    return;
  }
  if (mod && key.toLowerCase() === 'a') {
    event.preventDefault();
    canvas.selectAll();
    return;
  }
  if (mod && key.toLowerCase() === 'd') {
    event.preventDefault();
    canvas.duplicateSelection();
    return;
  }

  if (key === 'Escape') {
    if (isOverlayOpen()) return;
    canvas.setTool('select');
    return;
  }
  if (key === 'Delete') {
    if (canvas.selection.size) {
      event.preventDefault();
      canvas.removeSelection();
    }
    return;
  }
  if (!mod) {
    if (key.toLowerCase() === 'i') {
      pickImage();
      return;
    }
    const tool = TOOL_KEYS[key.toLowerCase()];
    if (tool) canvas.setTool(tool);
  }
});

// Dev handle: lets the smoke test (and devtools) drive the app directly.
window.__xo = {
  ctx,
  store,
  canvas,
  director,
  spawnClaude: (prompt = '') => spawnClaude(canvas, prompt),
  spawnShell: () => spawnShell(canvas),
  // Test hook: type a line into a terminal session.
  writeTerminal: (id, text) => writeToNode(id, text),
  openBrowser: (url) => openBrowser(canvas, url),
  openMusic: (options) => openMusic(canvas, options),
  openBoard: (options) => openBoard(canvas, options),
  tryQuick: (text) => quick.tryHandle(text),
  canvasSummary: () => canvasSummary(ctx),
  openDirectorLog: () => openDirectorLog(),
  openHierarchy: () => openHierarchy(),
  normalizeModel,
  normalizeEffort,
  get settings() {
    return settings;
  },
  get pages() {
    return pages;
  },
  get commandBar() {
    return commandBar;
  },
  get voice() {
    return voice;
  },
};
