import { uid } from './util.js';

const KEY = 'xodecode.state.v1';
const PAGE_COUNT = 1;

export const CALL_SIGNS = [
  'Skye', 'Marshall', 'Rocky', 'Rubble', 'Vega', 'Orion', 'Nova', 'Atlas',
  'Juno', 'Rook', 'Wren', 'Sable', 'Kestrel', 'Marlowe', 'Piper', 'Quill',
  'Rune', 'Halo', 'Onyx', 'Talon',
];

function makePage(index) {
  return {
    id: uid('pg'),
    name: `Page ${index + 1}`,
    workspace: '',
    viewport: { x: 0, y: 0, scale: 1 },
    layout: 'grid',
    mainId: null,
    nodes: [],
  };
}

function defaults() {
  return {
    theme: 'nightglass',
    workspace: '',
    sharedContext: '',
    settings: {
      agentNotifications: true,
      snapToGrid: false,
      sounds: true,
      voice: true,
      // 'windows' = Windows voice typing (Win+H); 'builtin' = XodeCode's own engine.
      dictation: 'windows',
      directorModel: 'claude-sonnet-5-5',
      directorEffort: 'low',
      background: '',
      backgroundFit: 'contain',
      // Tiled windows are screen-sized; zoom out to see them all.
      fullSizeWindows: true,
      agentFullPermissions: true,
      budgetUsd: 0,
      showTitles: true,
      autoLayout: true,
      // Glass is the default look; true swaps it for plain solid colors.
      flatUi: false,
    },
    pages: Array.from({ length: PAGE_COUNT }, (_, i) => makePage(i)),
    activePage: 0,
    joints: {},
    spend: { total: 0, byModel: {}, updatedAt: 0 },
  };
}

function normalizeNode(node) {
  return {
    id: node.id || uid('nd'),
    kind: node.kind || 'terminal',
    cli: node.cli || 'claude',
    x: Number.isFinite(node.x) ? node.x : 0,
    y: Number.isFinite(node.y) ? node.y : 0,
    w: Number.isFinite(node.w) ? node.w : 660,
    h: Number.isFinite(node.h) ? node.h : 400,
    z: Number.isFinite(node.z) ? node.z : 1,
    callSign: node.callSign || 'Agent',
    title: node.title || 'New session',
    subtitle: node.subtitle || '',
    cwd: node.cwd || '',
    model: node.model || null,
    effort: node.effort || null,
    joint: node.joint || null,
    jointName: node.jointName || '',
    jointContextPath: node.jointContextPath || '',
    // Hierarchy: only joint members carry a rank (see hierarchy.js).
    rank: node.joint ? node.rank || null : null,
    parentId: node.joint ? node.parentId || null : null,
    lastReport: node.joint && node.lastReport ? node.lastReport : null,
    // Never re-run a saved prompt when restoring a session on launch.
    prompt: '',
    status: 'idle',
    unread: false,
    payload: node.payload || null,
    // Claude GUI mode: which saved conversation this window shows.
    chatId: node.chatId || '',
    chatSessionId: node.chatSessionId || '',
    // Parked in the dock: hidden but still running.
    parked: Boolean(node.parked),
  };
}

function migrate(raw) {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;

  const state = {
    ...base,
    theme: raw.theme || base.theme,
    workspace: raw.workspace || '',
    sharedContext: typeof raw.sharedContext === 'string' ? raw.sharedContext : '',
    settings: (() => {
      const settings = { ...base.settings, ...(raw.settings || {}) };
      delete settings.speakFinished;
      delete settings.speakDirector;
      delete settings.ttsVoice;
      // Claude always renders in GUI mode now; the old switches are gone.
      delete settings.guiTerminals;
      delete settings.transparentUi;
      return settings;
    })(),
    joints: raw.joints && typeof raw.joints === 'object' ? raw.joints : {},
    spend:
      raw.spend && typeof raw.spend === 'object'
        ? {
            total: Number(raw.spend.total) || 0,
            byModel: raw.spend.byModel && typeof raw.spend.byModel === 'object' ? raw.spend.byModel : {},
            updatedAt: Number(raw.spend.updatedAt) || 0,
          }
        : { total: 0, byModel: {}, updatedAt: 0 },
  };

  if (Array.isArray(raw.pages) && raw.pages.length) {
    state.pages = raw.pages.map((page, index) => ({
      id: page.id || uid('pg'),
      name: page.name || `Page ${index + 1}`,
      workspace: typeof page.workspace === 'string' ? page.workspace : '',
      viewport: {
        x: Number.isFinite(page.viewport?.x) ? page.viewport.x : 0,
        y: Number.isFinite(page.viewport?.y) ? page.viewport.y : 0,
        scale: Number.isFinite(page.viewport?.scale) ? Math.min(2.4, Math.max(0.5, page.viewport.scale)) : 1,
      },
      layout: ['grid', 'columns', 'rows', 'focus'].includes(page.layout) ? page.layout : 'grid',
      mainId: page.mainId || null,
      nodes: Array.isArray(page.nodes) ? page.nodes.map(normalizeNode) : [],
    }));
    while (state.pages.length < PAGE_COUNT) state.pages.push(makePage(state.pages.length));
  }

  state.activePage = Math.min(Math.max(0, raw.activePage | 0), state.pages.length - 1);
  return state;
}

class Store {
  constructor() {
    this.state = defaults();
    this.listeners = new Map();
    this.saveTimer = null;
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) {
      try {
        fn(payload);
      } catch (error) {
        console.error(`[store] listener for "${event}" failed`, error);
      }
    }
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.state = migrate(JSON.parse(raw));
    } catch (error) {
      console.warn('[store] could not read saved state', error);
    }
    return this.state;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(this.state));
      } catch (error) {
        console.warn('[store] could not persist state', error);
      }
    }, 260);
  }

  /* ------------------------------ pages ------------------------------ */

  get joints() {
    return this.state.joints;
  }

  addSpend(usd, model, nodeId) {
    const amount = Number(usd);
    if (!Number.isFinite(amount) || amount <= 0) return this.state.spend;
    const spend = this.state.spend;
    spend.total = Math.round((spend.total + amount) * 1e6) / 1e6;
    if (model) spend.byModel[model] = Math.round(((spend.byModel[model] || 0) + amount) * 1e6) / 1e6;
    spend.updatedAt = Date.now();
    // Team members also count toward their team's own spend.
    const node = nodeId ? this.findNode(nodeId)?.node : null;
    const joint = node && node.joint ? this.state.joints[node.joint] : null;
    if (joint) {
      joint.spend = Math.round(((Number(joint.spend) || 0) + amount) * 1e6) / 1e6;
      this.emit('teams');
    }
    this.save();
    this.emit('spend', spend);
    return spend;
  }

  budgetLeft() {
    const budget = Number(this.state.settings.budgetUsd) || 0;
    if (budget <= 0) return Infinity;
    return Math.max(0, budget - this.state.spend.total);
  }

  addJoint(joint) {
    this.state.joints[joint.id] = joint;
    this.save();
    this.emit('joints', this.state.joints);
    return joint;
  }

  findJoint(ref) {
    if (!ref) return null;
    if (this.state.joints[ref]) return this.state.joints[ref];
    const wanted = String(ref).toLowerCase();
    return (
      Object.values(this.state.joints).find(
        (joint) => String(joint.name || '').toLowerCase() === wanted
      ) || null
    );
  }

  get pages() {
    return this.state.pages;
  }

  get activeIndex() {
    return this.state.activePage;
  }

  get page() {
    return this.state.pages[this.state.activePage];
  }

  setActivePage(index) {
    const next = Math.min(Math.max(0, index), this.state.pages.length - 1);
    if (next === this.state.activePage) return;
    this.state.activePage = next;
    this.save();
    this.emit('page', next);
  }

  renamePage(id, name) {
    const page = this.state.pages.find((p) => p.id === id);
    if (!page) return;
    page.name = name.trim() || page.name;
    this.save();
    this.emit('page', this.state.activePage);
  }

  setPageWorkspace(id, dir) {
    const page = this.state.pages.find((p) => p.id === id);
    if (!page) return;
    page.workspace = String(dir || '');
    if (page.workspace && /^Page \d+$/.test(page.name)) {
      const base = page.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      if (base) page.name = base;
    }
    this.save();
    this.emit('page', this.state.activePage);
  }

  addPage() {
    const page = makePage(this.state.pages.length);
    this.state.pages.push(page);
    this.state.activePage = this.state.pages.length - 1;
    this.save();
    this.emit('page', this.state.activePage);
    return page;
  }

  removePage(id) {
    if (this.state.pages.length <= 1) return false;
    const index = this.state.pages.findIndex((p) => p.id === id);
    if (index === -1) return false;
    this.state.pages.splice(index, 1);
    if (index < this.state.activePage) this.state.activePage -= 1;
    this.state.activePage = Math.min(this.state.activePage, this.state.pages.length - 1);
    this.save();
    this.emit('page', this.state.activePage);
    return true;
  }

  /* ------------------------------ nodes ------------------------------ */

  allNodes() {
    return this.state.pages.flatMap((page) => page.nodes);
  }

  findNode(id) {
    for (const page of this.state.pages) {
      const node = page.nodes.find((n) => n.id === id);
      if (node) return { page, node };
    }
    return null;
  }

  addNode(node) {
    this.page.nodes.push(node);
    this.save();
    this.emit('nodes');
    return node;
  }

  removeNode(id) {
    for (const page of this.state.pages) {
      const index = page.nodes.findIndex((n) => n.id === id);
      if (index !== -1) {
        page.nodes.splice(index, 1);
        this.save();
        this.emit('nodes');
        return true;
      }
    }
    return false;
  }

  pageOfNode(id) {
    return this.state.pages.find((page) => page.nodes.some((n) => n.id === id)) || null;
  }

  /* ---------------------------- settings ----------------------------- */

  setSetting(key, value) {
    this.state.settings[key] = value;
    this.save();
    this.emit('settings', this.state.settings);
  }

  setTheme(theme) {
    this.state.theme = theme;
    this.save();
    this.emit('theme', theme);
  }

  setWorkspace(dir) {
    this.state.workspace = dir;
    this.save();
    this.emit('settings', this.state.settings);
  }
}

export const store = new Store();
