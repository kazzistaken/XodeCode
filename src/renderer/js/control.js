import { store } from './store.js';
import { spawnTerminal, writeToNode, hasSession } from './terminal.js';
import { openBrowser } from './browser.js';
import { openMusic } from './music.js';
import { openBoard } from './board.js';
import { truncate, uid } from './util.js';
import { TILEABLE } from './layout.js';
import { setBackgroundPreset } from './backgrounds.js';
import {
  RANK_LABEL,
  teamMembers,
  rankForNewMember,
  setLead,
  demoteLead,
  moveToTeam,
  commitTeams,
  teamTree,
  teamTasks,
  assignTask,
  applyReport,
  teamBudgetLeft,
  teamSpendLabel,
} from './hierarchy.js';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_MODEL = 'claude-sonnet-5-5';

/**
 * Model aliases the user can ask for by name. Anything that looks like a model
 * id is passed through unchanged, so `--model haiku`, `--model fable` and full
 * ids all work. Only the *automatic* policy is limited to sonnet/opus — that
 * rule lives in the Director's instructions, not here.
 */
const MODEL_ALIASES = {
  sonnet: 'claude-sonnet-5-5',
  'sonnet 5.5': 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  'opus 5.5': 'claude-opus-5-5',
  haiku: 'claude-haiku-5-5',
  'haiku 5.5': 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
  'fable 5.1': 'claude-fable-5-1',
};

export function normalizeModel(model) {
  const text = String(model || '')
    .trim()
    .toLowerCase();
  if (!text) return DEFAULT_MODEL;
  if (MODEL_ALIASES[text]) return MODEL_ALIASES[text];
  if (/^[a-z0-9][a-z0-9._-]{1,60}$/i.test(text)) return text;
  return DEFAULT_MODEL;
}

export function normalizeEffort(effort) {
  return EFFORTS.has(effort) ? effort : 'medium';
}

function agentNodes() {
  return store.allNodes().filter((node) => node.kind === 'terminal');
}

function agentInfo(node) {
  const page = store.pageOfNode(node.id);
  return {
    id: node.id,
    callSign: node.callSign,
    title: node.title || '',
    cli: node.cli,
    status: node.status,
    model: node.model || null,
    effort: node.effort || null,
    prompt: node.prompt || '',
    joint: node.joint || undefined,
    page: page ? page.name : null,
  };
}

function resolveAgent(ref) {
  if (!ref) throw new Error('missing --agent <id|callSign>');
  const all = agentNodes();
  const wanted = String(ref).toLowerCase();
  return (
    all.find((node) => node.id === ref) ||
    all.find((node) => node.callSign.toLowerCase() === wanted) ||
    all.find((node) => node.title.toLowerCase() === wanted) ||
    null
  );
}

function requireAgent(ref) {
  const node = resolveAgent(ref);
  if (!node) throw new Error(`no agent matching "${ref}"`);
  return node;
}

function resolveNode(ref) {
  if (!ref) return null;
  const wanted = String(ref).toLowerCase();
  const all = store.allNodes();
  return (
    all.find((node) => node.id === ref) ||
    all.find((node) => String(node.callSign || '').toLowerCase() === wanted) ||
    all.find((node) => String(node.title || '').toLowerCase() === wanted) ||
    null
  );
}

function requireNode(ref) {
  const node = resolveNode(ref);
  if (!node) throw new Error(`no window matching "${ref}"`);
  return node;
}

/** "agent" for Claude Code sessions, "terminal" for shells, else the node kind. */
function kindOf(node) {
  if (node.kind === 'terminal') return node.cli === 'claude' ? 'agent' : 'terminal';
  return node.kind;
}

const KIND_ALIASES = {
  agents: 'agent', claude: 'agent', claudes: 'agent', session: 'agent', sessions: 'agent',
  terminals: 'terminal', shell: 'terminal', shells: 'terminal', console: 'terminal', consoles: 'terminal',
  browsers: 'browser', tab: 'browser', tabs: 'browser', web: 'browser', site: 'browser', sites: 'browser',
  notes: 'note', shapes: 'shape', images: 'image', texts: 'text', boards: 'board', player: 'music',
};

function normalizeKind(kind) {
  const text = String(kind || '').trim().toLowerCase();
  return KIND_ALIASES[text] || text;
}

function nodeInfo(node) {
  const page = store.pageOfNode(node.id);
  return {
    id: node.id,
    kind: kindOf(node),
    callSign: node.callSign,
    title: node.title || '',
    status: node.status || null,
    cli: node.kind === 'terminal' ? node.cli : undefined,
    cwd: node.kind === 'terminal' ? node.cwd || '' : undefined,
    joint: node.joint || undefined,
    jointName: node.jointName || undefined,
    page: page ? page.name : null,
    x: Math.round(node.x),
    y: Math.round(node.y),
    w: Math.round(node.w),
    h: Math.round(node.h),
    url: node.payload && node.payload.url ? node.payload.url : undefined,
    parked: node.parked || undefined,
  };
}

function pageByIndex(index) {
  const value = Number(index);
  if (!Number.isFinite(value) || value < 1 || value > store.pages.length) {
    throw new Error(`page index must be 1-${store.pages.length}`);
  }
  return store.pages[value - 1];
}

const THEME_ALIASES = {
  graphite: 'nightglass',
  nightglass: 'nightglass',
  slate: 'cupola',
  cupola: 'cupola',
  ash: 'ember',
  ember: 'ember',
};

/* ------------------------- JointedAgents -------------------------- */

const JOINT_COLORS = ['#f2764b', '#6ea8f7', '#4fc99b', '#e6a53c', '#a98bf5', '#56b6c2'];
const MAX_JOINT_MEMBERS = 5;

const jointMembers = teamMembers;

function jointInfo(joint) {
  const members = jointMembers(joint.id);
  return {
    id: joint.id,
    name: joint.name,
    color: joint.color,
    path: joint.path,
    size: members.length,
    lead: joint.leadId || null,
    members: members.map((node) => ({
      id: node.id,
      rank: node.rank || undefined,
      callSign: node.callSign,
      title: node.title,
      model: node.model,
      effort: node.effort,
      status: node.status,
    })),
  };
}

async function ensureJoint(ref, name) {
  const existing = store.findJoint(ref);
  if (existing) return existing;
  const label = String(name || ref || 'Joint').trim() || 'Joint';
  const id = uid('jt');
  const color = JOINT_COLORS[Object.keys(store.joints).length % JOINT_COLORS.length];
  const created = await window.api.joint.create({ id, name: label });
  const joint = {
    id,
    name: label,
    color,
    path: created.path || '',
    page: store.page.id,
    createdAt: Date.now(),
  };
  store.addJoint(joint);
  return joint;
}

function boardNode() {
  return store.allNodes().find((node) => node.kind === 'board') || null;
}

function ensureBoard(ctx) {
  let node = boardNode();
  if (!node) node = openBoard(ctx.canvas, {});
  return node;
}

function refreshBoard(ctx, node) {
  ctx.canvas.views?.get?.(node.id)?.refresh?.();
}

function ensureContext(ctx) {
  if (store.state.sharedContext) return;
  store.state.sharedContext = '# Fleet context\n\n_No brief yet._\n';
  ctx.syncContext();
}

async function handle(ctx, method, params) {
  switch (method) {
    case 'agents.list':
      return agentNodes().map(agentInfo);

    case 'app.state':
      return {
        activePage: store.page.name,
        activePageIndex: store.activeIndex + 1,
        pages: store.pages.map((page, index) => ({
          index: index + 1,
          name: page.name,
          workspace: page.workspace || null,
          windows: page.nodes.length,
          agents: page.nodes.filter((node) => node.kind === 'terminal').length,
        })),
        agents: agentNodes().map(agentInfo),
        nodes: store.allNodes().map(nodeInfo),
        workspace: store.page.workspace || store.state.workspace || null,
        theme: store.state.theme,
        spend: store.state.spend,
        budgetUsd: Number(store.state.settings.budgetUsd) || 0,
        contextPath: ctx.sysInfo?.paths?.context || null,
      };

    case 'workspace.get':
      return {
        page: store.page.name,
        workspace: store.page.workspace || null,
      };

    case 'workspace.set': {
      const dir = String(params.path || '').trim();
      if (!dir) throw new Error('workspace needs --path "<dir>"');
      store.setPageWorkspace(store.page.id, dir);
      return { page: store.page.name, workspace: dir };
    }

    case 'music.open': {
      const node = openMusic(ctx.canvas, {
        url: params.url,
        spotify: params.spotify,
        title: params.title,
      });
      return nodeInfo(node);
    }

    case 'joint.create': {
      const name = String(params.name || '').trim() || 'Joint';
      const joint = await ensureJoint(name, name);
      return jointInfo(joint);
    }

    case 'joint.list':
      return Object.values(store.joints).map(jointInfo);

    case 'joint.spawn': {
      const ref = String(params.joint || params.name || '').trim();
      if (!ref) throw new Error('joint spawn needs --joint "<name>"');
      const joint = await ensureJoint(ref, params.name || ref);
      if (jointMembers(joint.id).length >= MAX_JOINT_MEMBERS) {
        throw new Error(`joint "${joint.name}" is full (max ${MAX_JOINT_MEMBERS} members)`);
      }
      if (store.budgetLeft() <= 0) {
        throw new Error('budget reached — raise it with `budget --usd <amount>`');
      }
      if (teamBudgetLeft(joint) <= 0) {
        throw new Error(`team ${joint.name} is out of budget (${teamSpendLabel(joint)})`);
      }
      const prompt = String(params.prompt || '').trim();
      const place = rankForNewMember(joint.id);
      const isLead = place.rank === 'lead';
      const node = spawnTerminal(ctx.canvas, {
        cli: 'claude',
        prompt,
        cwd: params.cwd || undefined,
        model: params.model ? normalizeModel(params.model) : isLead ? 'claude-opus-5-5' : DEFAULT_MODEL,
        effort: params.effort ? normalizeEffort(params.effort) : isLead ? 'high' : 'medium',
        rank: place.rank,
        parentId: place.parentId,
        title: params.title
          ? truncate(params.title, 46)
          : params.role
            ? truncate(params.role, 46)
            : undefined,
        joint: joint.id,
        jointName: joint.name,
        jointContextPath: joint.path,
      });
      if (isLead) joint.leadId = node.id;
      if (prompt) assignTask(node, params.role ? `${params.role}: ${prompt}` : prompt);
      commitTeams(ctx.canvas);
      const info = jointInfo(joint);
      return { joint: info, member: agentInfo(node) };
    }

    case 'joint.context.get': {
      const joint = store.findJoint(params.joint);
      if (!joint) throw new Error(`no joint matching "${params.joint}"`);
      const text = await window.api.joint.read(joint.id);
      return { joint: joint.name, path: joint.path, text };
    }

    case 'joint.context.set': {
      const joint = store.findJoint(params.joint);
      if (!joint) throw new Error(`no joint matching "${params.joint}"`);
      await window.api.joint.write({ id: joint.id, content: String(params.text || '') });
      return { joint: joint.name, updated: true };
    }

    case 'joint.context.append': {
      const joint = store.findJoint(params.joint);
      if (!joint) throw new Error(`no joint matching "${params.joint}"`);
      const current = await window.api.joint.read(joint.id);
      const text = String(params.text || '');
      await window.api.joint.write({
        id: joint.id,
        content: `${current.trimEnd()}\n\n${text}\n`,
      });
      return { joint: joint.name, appended: true };
    }

    case 'nodes.list':
      return store.allNodes().map(nodeInfo);

    case 'canvas.snapshot':
      return canvasDetail(ctx);

    case 'batch': {
      const actions = Array.isArray(params.actions) ? params.actions : [];
      if (!actions.length) throw new Error('batch needs actions');
      // Every action starts at once; the canvas re-tiles a single time when
      // they have all landed.
      return ctx.canvas.batchAsync(() =>
        Promise.all(
          actions.map((action) =>
            runOp(ctx, action || {}).then(
              (result) => ({ op: action?.op, ok: true, result }),
              (error) => ({ op: action?.op, error: String((error && error.message) || error) })
            )
          )
        )
      );
    }

    case 'terminal.open': {
      const node = spawnTerminal(ctx.canvas, {
        cli: 'shell',
        cwd: params.cwd || undefined,
        title: params.title ? truncate(params.title, 46) : undefined,
      });
      return nodeInfo(node);
    }

    case 'node.focus': {
      const node = requireNode(params.node);
      ctx.canvas.focusAgent(node.id);
      return nodeInfo(node);
    }

    case 'node.close': {
      const node = requireNode(params.node);
      const info = nodeInfo(node);
      ctx.canvas.closeNode(node.id);
      return { closed: info.id, callSign: info.callSign };
    }

    case 'node.move': {
      const node = requireNode(params.node);
      if (Number.isFinite(Number(params.x))) node.x = Number(params.x);
      if (Number.isFinite(Number(params.y))) node.y = Number(params.y);
      ctx.canvas.applyGeometry(node, { animate: true });
      store.save();
      return nodeInfo(node);
    }

    case 'node.resize': {
      const node = requireNode(params.node);
      if (Number.isFinite(Number(params.w))) node.w = Math.max(160, Number(params.w));
      if (Number.isFinite(Number(params.h))) node.h = Math.max(120, Number(params.h));
      ctx.canvas.applyGeometry(node, { animate: true });
      store.save();
      return nodeInfo(node);
    }

    case 'layout':
    case 'layout.apply': {
      const rects = ctx.canvas.relayout({ force: true, animate: true });
      return { tiled: rects.length, rects };
    }

    case 'note.add': {
      const node = ctx.canvas.createNode({
        kind: 'note',
        x: Number.isFinite(Number(params.x)) ? Number(params.x) : undefined,
        y: Number.isFinite(Number(params.y)) ? Number(params.y) : undefined,
        w: 300,
        h: 220,
        callSign: 'Note',
        payload: { text: String(params.text || '') },
      });
      return nodeInfo(node);
    }

    case 'text.add': {
      const node = ctx.canvas.createNode({
        kind: 'text',
        x: Number.isFinite(Number(params.x)) ? Number(params.x) : undefined,
        y: Number.isFinite(Number(params.y)) ? Number(params.y) : undefined,
        w: 340,
        h: 110,
        callSign: 'Text',
        payload: { text: String(params.text || '') },
      });
      return nodeInfo(node);
    }

    case 'page.add': {
      const page = ctx.canvas.createPage();
      return { page: page.name, index: store.activeIndex + 1 };
    }

    case 'page.rename': {
      const page = params.id
        ? store.pages.find((p) => p.id === params.id)
        : pageByIndex(params.index);
      if (!page) throw new Error('no page to rename');
      store.renamePage(page.id, String(params.name || ''));
      return { renamed: page.name };
    }

    case 'page.close': {
      const page = params.id
        ? store.pages.find((p) => p.id === params.id)
        : pageByIndex(params.index);
      if (!page) throw new Error('no page to close');
      if (store.pages.length <= 1) throw new Error('cannot close the last page');
      const name = page.name;
      ctx.canvas.deletePage(page.id);
      return { closed: name, activePage: store.page.name };
    }

    case 'zoom.set': {
      if (params.reset) {
        ctx.canvas.resetZoom();
      } else if (Number.isFinite(Number(params.scale))) {
        ctx.canvas.setZoom(Number(params.scale));
      } else if (params.factor) {
        ctx.canvas.setZoom(store.page.viewport.scale * Number(params.factor));
      } else {
        throw new Error('zoom needs --scale <n> or reset');
      }
      return { scale: Math.round(store.page.viewport.scale * 100) / 100 };
    }

    case 'theme.set': {
      const theme = THEME_ALIASES[String(params.id || '').toLowerCase()];
      if (!theme) throw new Error('theme --id must be graphite | slate | ash');
      store.setTheme(theme);
      return { theme };
    }

    case 'browser.navigate': {
      const node = requireNode(params.node);
      if (node.kind !== 'browser') throw new Error(`${node.callSign} is not a browser`);
      const url = String(params.url || '').trim();
      if (!url) throw new Error('browser.navigate needs --url "<url>"');
      ctx.canvas.views?.get?.(node.id)?.navigate?.(url);
      return nodeInfo(node);
    }

    case 'shape.add': {
      const requested = String(params.kind || 'rect').toLowerCase();
      const allowed = new Set(['rect', 'ellipse', 'diamond', 'arrow', 'line', 'pen']);
      const shape = allowed.has(requested) ? requested : 'rect';
      const color = /^#[0-9a-f]{3,8}$/i.test(String(params.color || ''))
        ? String(params.color)
        : '#bdbdbd';
      const payload = { shape: shape === 'pen' ? 'line' : shape, color };
      if (payload.shape === 'arrow' || payload.shape === 'line') payload.a = [0, 0];
      const node = ctx.canvas.createNode({
        kind: 'shape',
        x: Number.isFinite(Number(params.x)) ? Number(params.x) : undefined,
        y: Number.isFinite(Number(params.y)) ? Number(params.y) : undefined,
        w: Number.isFinite(Number(params.w)) ? Number(params.w) : 220,
        h: Number.isFinite(Number(params.h)) ? Number(params.h) : 160,
        callSign: shape,
        payload,
      });
      return nodeInfo(node);
    }

    case 'image.add': {
      const filePath = String(params.path || '').trim();
      if (!filePath) throw new Error('image needs --path "<file>"');
      const file = await window.api.sys.readImage(filePath);
      const node = ctx.canvas.createNode({
        kind: 'image',
        w: 460,
        h: 340,
        callSign: file.name,
        payload: { src: file.dataUrl },
      });
      return nodeInfo(node);
    }

    case 'agent.spawn': {
      if (store.budgetLeft() <= 0) {
        throw new Error('budget reached — raise it with `budget --usd <amount>`');
      }
      const prompt = String(params.prompt || '').trim();
      const node = spawnTerminal(ctx.canvas, {
        cli: 'claude',
        prompt,
        cwd: params.cwd || undefined,
        model: normalizeModel(params.model),
        effort: normalizeEffort(params.effort),
        title: params.title ? truncate(params.title, 46) : prompt ? undefined : 'Claude',
      });
      return agentInfo(node);
    }

    case 'agent.send': {
      const node = requireAgent(params.agent);
      const text = String(params.text || '');
      if (!text) throw new Error('send needs --text "<message>"');
      if (!hasSession(node.id)) throw new Error(`${node.callSign} has no live session`);
      writeToNode(node.id, text);
      const task = String(params.task || text);
      node.title = truncate(task, 46) || node.title;
      ctx.canvas.refreshTitles(node.id);
      // Work handed to a team member lands on the team's board as "doing".
      if (node.joint && assignTask(node, task)) commitTeams(ctx.canvas);
      return agentInfo(node);
    }

    case 'agent.focus': {
      const node = requireAgent(params.agent);
      ctx.canvas.focusAgent(node.id);
      return agentInfo(node);
    }

    case 'agent.close': {
      const node = requireAgent(params.agent);
      const info = agentInfo(node);
      ctx.canvas.closeNode(node.id);
      return { closed: info.id, callSign: info.callSign };
    }

    case 'agent.model': {
      const node = requireAgent(params.agent);
      node.model = normalizeModel(params.model);
      const chat = ctx.canvas.views?.get?.(node.id);
      if (chat?.setModel) chat.setModel(node.model);
      else if (hasSession(node.id)) writeToNode(node.id, `/model ${node.model}`);
      store.save();
      return agentInfo(node);
    }

    case 'agent.effort': {
      const node = requireAgent(params.agent);
      node.effort = normalizeEffort(params.effort);
      const chat = ctx.canvas.views?.get?.(node.id);
      if (chat?.setEffort) chat.setEffort(node.effort);
      else if (hasSession(node.id)) writeToNode(node.id, `/effort ${node.effort}`);
      store.save();
      return agentInfo(node);
    }

    case 'browser.open': {
      const url = String(params.url || '').trim();
      if (!url) throw new Error('browser needs --url "<url>"');
      const node = openBrowser(ctx.canvas, url, { title: params.title });
      const page = store.pageOfNode(node.id);
      return { id: node.id, callSign: node.callSign, url: node.payload?.url || url, page: page ? page.name : null };
    }

    case 'canvas.undo':
      return { undone: ctx.canvas.undo() };

    case 'canvas.redo':
      return { redone: ctx.canvas.redo() };

    case 'canvas.select':
      ctx.canvas.selectAll();
      return { selected: ctx.canvas.selection.size };

    case 'canvas.duplicate':
      return { duplicated: (ctx.canvas.duplicateSelection() || []).length };

    case 'canvas.remove':
      ctx.canvas.removeSelection();
      return { removed: true };

    case 'board.open': {
      // {joint} opens that team's live board (one per team).
      const joint = params.joint ? store.findJoint(params.joint) : null;
      if (params.joint && !joint) throw new Error(`no team matching "${params.joint}"`);
      if (joint) {
        const existing = store.allNodes().find((node) => node.kind === 'board' && node.payload?.joint === joint.id);
        if (existing) {
          ctx.canvas.focusAgent(existing.id);
          return nodeInfo(existing);
        }
      }
      const node = openBoard(ctx.canvas, {
        title: params.title || (joint ? `${joint.name} tasks` : undefined),
        joint: joint ? joint.id : undefined,
      });
      return nodeInfo(node);
    }

    case 'board.list': {
      const node = boardNode();
      if (!node) return [];
      return node.payload.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        owner: task.owner || '',
      }));
    }

    case 'board.add': {
      const node = ensureBoard(ctx);
      const title = String(params.title || '').trim();
      if (!title) throw new Error('board add needs --title "<task>"');
      const status = ['todo', 'doing', 'done'].includes(params.status) ? params.status : 'todo';
      const task = {
        id: `t_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
        title,
        status,
        owner: String(params.owner || ''),
      };
      node.payload.tasks.push(task);
      store.save();
      refreshBoard(ctx, node);
      return task;
    }

    case 'board.move': {
      const node = ensureBoard(ctx);
      const wanted = String(params.task || '').toLowerCase();
      const task = node.payload.tasks.find(
        (t) => t.id === params.task || t.title.toLowerCase() === wanted
      );
      if (!task) throw new Error(`no task matching "${params.task}"`);
      if (!['todo', 'doing', 'done'].includes(params.status)) {
        throw new Error('board move needs --status todo|doing|done');
      }
      task.status = params.status;
      if (params.owner !== undefined) task.owner = String(params.owner);
      store.save();
      refreshBoard(ctx, node);
      return task;
    }

    case 'board.clear': {
      const node = ensureBoard(ctx);
      node.payload.tasks = [];
      store.save();
      refreshBoard(ctx, node);
      return { cleared: true };
    }

    case 'budget.get': {
      const left = store.budgetLeft();
      return {
        total: store.state.spend.total,
        byModel: store.state.spend.byModel,
        budgetUsd: Number(store.state.settings.budgetUsd) || 0,
        left: Number.isFinite(left) ? Math.round(left * 100) / 100 : null,
      };
    }

    case 'budget.set': {
      const usd = Number(params.usd);
      if (!Number.isFinite(usd) || usd < 0) throw new Error('budget needs --usd <amount>');
      store.setSetting('budgetUsd', usd);
      return { budgetUsd: usd };
    }

    case 'context.get':
      ensureContext(ctx);
      return { path: ctx.sysInfo?.paths?.context || null, text: store.state.sharedContext };

    case 'context.set': {
      const text = String(params.text || '');
      if (!text) throw new Error('context set needs --text "<brief>"');
      store.state.sharedContext = text;
      ctx.syncContext();
      return { updated: true, length: text.length };
    }

    case 'context.append': {
      const text = String(params.text || '');
      if (!text) throw new Error('context append needs --text "<text>"');
      ensureContext(ctx);
      store.state.sharedContext = `${store.state.sharedContext.trimEnd()}\n\n${text}\n`;
      ctx.syncContext();
      return { appended: true, length: text.length };
    }

    case 'app.notify': {
      const text = String(params.text || '');
      if (text) ctx.toast(text);
      return { shown: Boolean(text) };
    }

    case 'app.page': {
      const index = Number(params.index);
      if (!Number.isFinite(index) || index < 1 || index > store.pages.length) {
        throw new Error(`page index must be 1-${store.pages.length}`);
      }
      store.setActivePage(index - 1);
      return { page: store.page.name };
    }

    case 'app.open': {
      const target = String(params.target || '');
      if (target === 'settings') ctx.openSettings();
      else if (target === 'map') ctx.openMap();
      else if (target === 'director') ctx.openDirectorLog();
      else if (target === 'hierarchy') ctx.openHierarchy();
      else throw new Error('open --target must be settings | map | director | hierarchy');
      return { opened: target };
    }

    case 'app.clear':
      return { ...ctx.clearPage(), dock: 'parked windows wait in the dock; restore brings one back' };

    case 'app.tidy':
      ctx.canvas.tidy();
      return { tidied: true };

    default:
      throw new Error(`unknown method "${method}"`);
  }
}

/* ----------------------- Director actions (run) ----------------------- */

function count(value, max = 8) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : 1;
}

function closeOp(ctx, action) {
  let targets;
  if (action.all) {
    targets = store.page.nodes.filter((node) => action.forever || !node.parked);
  } else if (action.kind) {
    const kind = normalizeKind(action.kind);
    targets = store.page.nodes.filter((node) => kindOf(node) === kind && (action.forever || !node.parked));
  } else if (Array.isArray(action.nodes)) {
    targets = action.nodes.map(requireNode);
  } else {
    targets = [requireNode(action.node)];
  }
  // Closing sends windows to the dock (still running); only "forever" or a
  // window that cannot dock (shape, text, image) is removed outright.
  if (action.forever) {
    ctx.canvas.batch(() => {
      for (const node of targets) ctx.canvas.removeNode(node.id);
    });
    return { removed: targets.map((node) => node.callSign) };
  }
  const dockable = targets.filter((node) => ctx.canvas.isDockable(node) && !node.parked);
  ctx.canvas.batch(() => {
    for (const node of targets) if (!dockable.includes(node) && !node.parked) ctx.canvas.removeNode(node.id);
  });
  ctx.canvas.parkNodes(dockable);
  return { docked: dockable.map((node) => node.callSign) };
}

async function jointOp(ctx, action) {
  const name = String(action.name || action.joint || '').trim() || 'Joint';
  const joint = await ensureJoint(name, name);
  if (action.brief) {
    await window.api.joint.write({ id: joint.id, content: String(action.brief) });
  }
  const members = Array.isArray(action.members) ? action.members.slice(0, MAX_JOINT_MEMBERS) : [];
  // The lead spawns first so every worker is created under it.
  if (!teamMembers(joint.id).length) {
    const leadIndex = members.findIndex((member) => member.lead || /lead/i.test(member.role || ''));
    if (leadIndex > 0) members.unshift(members.splice(leadIndex, 1)[0]);
  }
  const spawned = [];
  for (const member of members) {
    spawned.push(
      await handle(ctx, 'joint.spawn', {
        joint: joint.id,
        role: member.role,
        model: member.model,
        effort: member.effort,
        title: member.title,
        prompt: member.prompt,
        cwd: member.cwd,
      }).then((result) => result.member)
    );
  }
  return {
    joint: joint.name,
    members: spawned.map((m) => `${m.callSign} ${RANK_LABEL[store.findNode(m.id)?.node.rank] || ''} (${m.model}/${m.effort})`),
  };
}

function rankOp(ctx, action) {
  const node = requireAgent(action.agent);
  if (action.op === 'lead') {
    setLead(node);
  } else if (action.op === 'demote') {
    demoteLead(node);
  } else {
    const ref = action.joint === undefined ? '' : String(action.joint || '').trim();
    const solo = !ref || /^(none|null|solo|out)$/i.test(ref);
    const joint = solo ? null : store.findJoint(ref);
    if (!solo && !joint) throw new Error(`no team matching "${ref}"`);
    if (joint && joint.id !== node.joint && teamMembers(joint.id).length >= MAX_JOINT_MEMBERS) {
      throw new Error(`team "${joint.name}" is full (max ${MAX_JOINT_MEMBERS} members)`);
    }
    moveToTeam(node, joint);
  }
  commitTeams(ctx.canvas);
  return {
    agent: node.callSign,
    team: node.jointName || null,
    rank: node.rank || 'solo',
  };
}

function pageOp(ctx, action) {
  if (action.add) {
    const page = ctx.canvas.createPage();
    if (action.name) store.renamePage(page.id, String(action.name));
    if (action.workspace) store.setPageWorkspace(page.id, String(action.workspace));
    return { page: page.name, index: store.activeIndex + 1 };
  }
  if (action.close !== undefined) return handle(ctx, 'page.close', { index: action.close });
  if (action.rename !== undefined) {
    return handle(ctx, 'page.rename', { index: action.rename, name: action.name });
  }
  return handle(ctx, 'app.page', { index: action.index });
}

function zoomOp(ctx, action) {
  const to = String(action.to || '').toLowerCase();
  if (to === 'fit') {
    ctx.canvas.fitAll();
    return { fit: true };
  }
  if (to === 'in') return handle(ctx, 'zoom.set', { factor: 1.25 });
  if (to === 'out') return handle(ctx, 'zoom.set', { factor: 0.8 });
  if (to === 'reset') return handle(ctx, 'zoom.set', { reset: true });
  return handle(ctx, 'zoom.set', { scale: action.scale });
}

/** Placing a tiled window by hand means the user wants free placement. */
function freePlacement(node) {
  if (TILEABLE.has(node.kind) && store.state.settings.autoLayout !== false) {
    store.setSetting('autoLayout', false);
  }
}

async function runOp(ctx, action) {
  const op = String(action.op || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  switch (op) {
    case 'terminal':
    case 'shell': {
      const opened = [];
      for (let i = 0; i < count(action.count); i += 1) {
        opened.push(await handle(ctx, 'terminal.open', { title: action.title, cwd: action.cwd }));
      }
      return opened.length === 1 ? opened[0] : opened;
    }
    case 'browser':
      if (action.node) return handle(ctx, 'browser.navigate', action);
      return handle(ctx, 'browser.open', action);
    case 'navigate':
      return handle(ctx, 'browser.navigate', action);
    case 'music':
      return handle(ctx, 'music.open', action);
    case 'board':
      return handle(ctx, 'board.open', action);
    case 'board_add':
      return handle(ctx, 'board.add', action);
    case 'board_move':
      return handle(ctx, 'board.move', action);
    case 'note':
      return handle(ctx, 'note.add', action);
    case 'text':
      return handle(ctx, 'text.add', action);
    case 'close':
      return closeOp(ctx, action);
    case 'focus':
      return handle(ctx, 'node.focus', { node: action.node });
    case 'arrange':
    case 'layout': {
      const main = action.main ? requireNode(action.main).id : undefined;
      ctx.canvas.setLayout(String(action.mode || 'grid').toLowerCase(), main);
      return { layout: store.page.layout, main: store.page.mainId };
    }
    case 'swap': {
      const a = requireNode(action.a);
      const b = requireNode(action.b);
      if (!ctx.canvas.swapNodes(a.id, b.id)) throw new Error('both windows must be tiled on this page');
      return { swapped: [a.callSign, b.callSign] };
    }
    case 'order': {
      const nodes = (Array.isArray(action.nodes) ? action.nodes : []).map(requireNode);
      ctx.canvas.orderNodes(nodes.map((node) => node.id));
      return { order: nodes.map((node) => node.callSign) };
    }
    case 'tile':
      store.setSetting('autoLayout', true);
      ctx.canvas.relayout({ force: true, animate: true });
      return { tiled: true };
    case 'move': {
      const node = requireNode(action.node);
      freePlacement(node);
      return handle(ctx, 'node.move', action);
    }
    case 'resize': {
      const node = requireNode(action.node);
      freePlacement(node);
      return handle(ctx, 'node.resize', action);
    }
    case 'zoom':
      return zoomOp(ctx, action);
    case 'agent':
    case 'spawn':
      return handle(ctx, 'agent.spawn', action);
    case 'send':
      return handle(ctx, 'agent.send', action);
    case 'model':
      return handle(ctx, 'agent.model', action);
    case 'effort':
      return handle(ctx, 'agent.effort', action);
    case 'joint':
      return jointOp(ctx, action);
    case 'joint_add':
      return handle(ctx, 'joint.spawn', action);
    case 'joint_brief':
      return handle(ctx, action.append ? 'joint.context.append' : 'joint.context.set', action);
    case 'lead':
    case 'demote':
    case 'move_team':
      return rankOp(ctx, action);
    case 'team_budget': {
      const joint = store.findJoint(action.joint);
      if (!joint) throw new Error(`no team matching "${action.joint}"`);
      const usd = Number(action.usd);
      if (!Number.isFinite(usd) || usd < 0) throw new Error('team_budget needs usd >= 0 (0 = no cap)');
      joint.budgetUsd = usd;
      commitTeams(ctx.canvas);
      return { team: joint.name, spend: teamSpendLabel(joint) };
    }
    case 'context':
      return handle(ctx, action.append ? 'context.append' : 'context.set', action);
    case 'page':
      return pageOp(ctx, action);
    case 'workspace':
      return handle(ctx, action.path ? 'workspace.set' : 'workspace.get', action);
    case 'theme':
      return handle(ctx, 'theme.set', action);
    case 'background': {
      const preset = setBackgroundPreset(String(action.id || action.name || 'none').toLowerCase());
      return { background: preset ? preset.label : 'dot grid' };
    }
    case 'notify':
      return handle(ctx, 'app.notify', action);
    case 'undo':
      return handle(ctx, 'canvas.undo', {});
    case 'redo':
      return handle(ctx, 'canvas.redo', {});
    case 'open':
      return handle(ctx, 'app.open', action);
    case 'clear':
      return handle(ctx, 'app.clear', {});
    case 'restore': {
      const targets = action.all
        ? store.page.nodes.filter((node) => node.parked)
        : (Array.isArray(action.nodes) ? action.nodes : [action.node]).map(requireNode);
      for (const node of targets) ctx.canvas.restoreNode(node.id);
      return { restored: targets.map((node) => node.callSign) };
    }
    case 'budget':
      return handle(ctx, action.usd !== undefined ? 'budget.set' : 'budget.get', action);
    default:
      throw new Error(`unknown op "${action.op}"`);
  }
}

/* --------------------------- canvas snapshot --------------------------- */

function describeNode(node, ctx, page) {
  const parts = [`${node.id} ${kindOf(node)} "${node.callSign}"`];
  if (node.title && node.title !== node.callSign) parts.push(`— ${truncate(node.title, 48)}`);
  const url = node.payload && node.payload.url;
  if (url) parts.push(truncate(url, 70));
  const extra = [];
  if (kindOf(node) === 'agent') {
    extra.push(node.status || 'idle');
    if (node.model) extra.push(`${String(node.model).replace(/^claude-/, '')}/${node.effort || 'medium'}`);
    if (node.jointName) extra.push(`${node.rank === 'lead' ? 'lead of' : 'worker in'} team ${node.jointName}`);
  }
  if (ctx.canvas.selectedId === node.id) extra.push('focused');
  if (page.mainId === node.id && page.layout === 'focus') extra.push('main');
  return extra.length ? `${parts.join(' ')} · ${extra.join(' · ')}` : parts.join(' ');
}

/** Compact text the Director gets in front of every prompt. */
export function canvasSummary(ctx) {
  const page = store.page;
  const vp = page.viewport;
  const auto = store.state.settings.autoLayout !== false;
  const lines = [
    `[canvas] page ${store.activeIndex + 1}/${store.pages.length} "${page.name}" · workspace ${page.workspace || store.state.workspace || 'none'} · layout ${auto ? page.layout || 'grid' : 'free (auto-tiling off)'} · zoom ${Math.round(vp.scale * 100) / 100}`,
  ];
  const tiles = ctx.canvas.tileableNodes(page);
  const loose = page.nodes.filter((node) => !TILEABLE.has(node.kind) && !node.parked);
  const parked = page.nodes.filter((node) => node.parked);
  if (!tiles.length && !loose.length) {
    lines.push('windows: none');
  } else {
    lines.push('windows (tile order):');
    tiles.forEach((node, index) => lines.push(`${index + 1}. ${describeNode(node, ctx, page)}`));
    for (const node of loose) lines.push(`- ${describeNode(node, ctx, page)}`);
  }
  if (parked.length) {
    lines.push(`dock (parked, hidden): ${parked.map((node) => `${node.id} ${kindOf(node)} "${node.callSign}"`).join(', ')}`);
  }
  const others = store.pages
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => p !== page)
    .map(({ p, index }) => `${index + 1} "${p.name}" (${p.nodes.length} windows)`);
  if (others.length) lines.push(`other pages: ${others.join(', ')}`);
  const teams = teamTree();
  if (teams.length) {
    lines.push('teams (joints; ranks: user > you, the Director > lead > workers):');
    const who = (node) => {
      const report = node.lastReport ? ` [reported ${node.lastReport.status}: "${truncate(node.lastReport.text, 80)}"]` : '';
      return `${node.id} "${node.callSign}" ${node.status || 'idle'}${node.parked ? ' docked' : ''}${report}`;
    };
    for (const { joint, lead, workers } of teams) {
      const under = workers.length ? ` > workers ${workers.map(who).join(', ')}` : ' > no workers';
      const tasks = teamTasks(joint);
      const count = (status) => tasks.filter((task) => task.status === status).length;
      const stats = ` · spend ${teamSpendLabel(joint)} · tasks ${count('doing')} doing, ${count('done')} done`;
      lines.push(`- ${joint.name}${stats}: lead ${who(lead)}${under}`);
    }
  }
  return lines.join('\n');
}

/** Full structured canvas state for the `canvas` tool. */
function canvasDetail(ctx) {
  const page = store.page;
  const vp = page.viewport;
  const tiles = ctx.canvas.tileableNodes(page);
  return {
    activePage: store.activeIndex + 1,
    screen: { w: ctx.canvas.viewportEl.clientWidth, h: ctx.canvas.viewportEl.clientHeight },
    viewport: { x: Math.round(vp.x), y: Math.round(vp.y), scale: Math.round(vp.scale * 100) / 100 },
    autoTile: store.state.settings.autoLayout !== false,
    layout: page.layout || 'grid',
    main: page.mainId || null,
    focused: ctx.canvas.selectedId || null,
    pages: store.pages.map((p, index) => ({
      index: index + 1,
      name: p.name,
      workspace: p.workspace || null,
      layout: p.layout || 'grid',
      windows: p.nodes.map((node) => ({
        ...nodeInfo(node),
        tile: p === page ? tiles.indexOf(node) + 1 || undefined : undefined,
        onScreen: p === page ? ctx.canvas.isOnScreen(node.id) : undefined,
        model: node.model || undefined,
        effort: node.effort || undefined,
      })),
    })),
    joints: Object.values(store.joints).map(jointInfo),
  };
}

/* ----------------------------- team tools ----------------------------- */

const MAX_WORKERS = 4;
const REPORT_STATUSES = new Set(['done', 'blocked', 'question', 'progress']);

function memberInfo(node) {
  return {
    id: node.id,
    callSign: node.callSign,
    rank: node.rank,
    status: node.status || 'idle',
    title: node.title || '',
    model: node.model || undefined,
    lastReport: node.lastReport || undefined,
  };
}

/**
 * Requests from a team agent's own MCP server. `callerId` comes from the
 * agent's token (set by the main process), so it cannot be faked by the agent;
 * every action is checked against the caller's rank and team.
 */
async function teamHandle(ctx, method, params, callerId) {
  const found = store.findNode(callerId);
  const caller = found && found.node;
  if (!caller) throw new Error('your window is gone');
  const joint = caller.joint ? store.joints[caller.joint] : null;
  if (!joint) throw new Error('you are not in a team');
  const members = teamMembers(joint.id);
  const lead = members.find((node) => node.rank === 'lead') || null;
  const overBudget = () => {
    if (teamBudgetLeft(joint) <= 0) {
      throw new Error(`team budget reached (${teamSpendLabel(joint)}) — report blocked so the Director can raise it`);
    }
  };
  const leadOnly = (what) => {
    if (caller.rank !== 'lead') {
      throw new Error(`only the team lead can ${what}${lead ? ` — ask ${lead.callSign} with report` : ''}`);
    }
  };

  switch (method) {
    case 'team.info':
      return {
        you: { callSign: caller.callSign, rank: caller.rank },
        team: joint.name,
        brief: joint.path,
        lead: lead ? lead.callSign : null,
        reportsTo: caller.rank === 'lead' ? 'the Director' : lead ? lead.callSign : null,
        members: members.map(memberInfo),
        maxWorkers: MAX_WORKERS,
        spend: teamSpendLabel(joint),
        tasks: teamTasks(joint)
          .slice(-15)
          .map((task) => ({ title: task.title, owner: task.owner, status: task.status, flag: task.flag })),
      };

    case 'team.report': {
      const status = REPORT_STATUSES.has(params.status) ? params.status : 'progress';
      const text = truncate(String(params.text || '').trim(), 400);
      if (!text) throw new Error('report needs text');
      caller.lastReport = { status, text, at: Date.now() };
      applyReport(caller, status);
      store.save();
      store.emit('teams');
      const toLead = caller.rank !== 'lead' && lead && lead !== caller;
      const to = toLead ? lead.callSign : 'the Director';
      if (status === 'progress') return { reported: status, to, delivered: false };
      ctx.toast(`${caller.callSign} → ${to}: ${status} — ${truncate(text, 90)}`);
      // Reports go up one level: a worker's into its lead's input, the lead's
      // to the Director. Either waits for the receiver's current turn.
      let delivered = false;
      if (toLead && hasSession(lead.id)) {
        delivered = writeToNode(lead.id, `[Report from ${caller.callSign}, your worker: ${status}] ${text}`);
      } else if (!toLead && ctx.director) {
        delivered = ctx.director.send(
          `[Team report] ${caller.callSign}, lead of team ${joint.name}: ${status} — ${text}`,
          { from: 'team' }
        );
      }
      return { reported: status, to, delivered };
    }

    case 'team.spawn': {
      leadOnly('start workers');
      overBudget();
      const workers = members.filter((node) => node.rank === 'worker');
      if (workers.length >= MAX_WORKERS) {
        throw new Error(`team is full (${MAX_WORKERS} workers) — prompt an existing worker instead`);
      }
      const result = await handle(ctx, 'joint.spawn', {
        joint: joint.id,
        role: params.role,
        prompt: params.prompt,
        model: params.model,
        effort: params.effort,
      });
      return { started: result.member.callSign, model: result.member.model, effort: result.member.effort };
    }

    case 'team.prompt': {
      leadOnly('prompt workers');
      overBudget();
      const wanted = String(params.worker || '').toLowerCase();
      const target = members.find(
        (node) => node.id === params.worker || String(node.callSign).toLowerCase() === wanted
      );
      if (!target) throw new Error(`no worker "${params.worker}" in team ${joint.name}`);
      if (target === caller) throw new Error('you cannot prompt yourself');
      const text = String(params.text || '').trim();
      if (!text) throw new Error('prompt_worker needs text');
      await handle(ctx, 'agent.send', {
        agent: target.id,
        text: `[From ${caller.callSign}, your team lead] ${text}`,
        task: text,
      });
      return { sent: target.callSign };
    }

    case 'team.brief':
      leadOnly('edit the brief');
      return handle(ctx, params.append ? 'joint.context.append' : 'joint.context.set', {
        joint: joint.id,
        text: params.text,
      });

    default:
      throw new Error(`unknown team method "${method}"`);
  }
}

export function initControl(ctx) {
  window.api.control.onRequest(async ({ id, method, params, caller }) => {
    try {
      // A team agent's token only ever reaches the team tools.
      const result = caller
        ? await teamHandle(ctx, method, params || {}, caller)
        : await handle(ctx, method, params || {});
      window.api.control.respond({ id, result });
    } catch (error) {
      window.api.control.respond({ id, error: String((error && error.message) || error) });
    }
  });
}
