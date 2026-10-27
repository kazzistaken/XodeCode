import { store } from './store.js';

/**
 * Rank hierarchy for jointed teams. Each joint is one team: a single lead and
 * the workers under it. The Director (the app) sits above every team, and the
 * user above the Director. Standalone sessions are outside the hierarchy and
 * never carry a rank.
 *
 * `joint.leadId` is the source of truth; `node.rank` / `node.parentId` mirror
 * it so views and the Director snapshot can read a node on its own.
 */

export const RANK_LABEL = { lead: 'Lead', worker: 'Worker' };

export function teamMembers(jointId) {
  return store.allNodes().filter((node) => node.joint === jointId);
}

export function teamLead(jointId) {
  const joint = store.joints[jointId];
  const members = teamMembers(jointId);
  return (
    (joint && members.find((node) => node.id === joint.leadId)) ||
    members.find((node) => node.rank === 'lead') ||
    members[0] ||
    null
  );
}

/** The rank a new member of `jointId` should get before it is created. */
export function rankForNewMember(jointId) {
  const lead = teamLead(jointId);
  return lead ? { rank: 'worker', parentId: lead.id } : { rank: 'lead', parentId: null };
}

/**
 * Make every team consistent: exactly one lead, every other member a worker
 * under it, no rank outside a team. Repairs old saves and a closed lead.
 * Returns true when anything changed.
 */
export function normalizeTeams() {
  let changed = false;
  const set = (target, key, value) => {
    if (target[key] !== value) {
      target[key] = value;
      changed = true;
    }
  };

  for (const node of store.allNodes()) {
    if (node.joint && !store.joints[node.joint]) {
      set(node, 'joint', null);
      set(node, 'jointName', '');
      set(node, 'jointContextPath', '');
    }
    if (!node.joint) {
      set(node, 'rank', null);
      set(node, 'parentId', null);
    }
  }

  for (const joint of Object.values(store.joints)) {
    const lead = teamLead(joint.id);
    set(joint, 'leadId', lead ? lead.id : null);
    for (const node of teamMembers(joint.id)) {
      set(node, 'rank', node === lead ? 'lead' : 'worker');
      set(node, 'parentId', node === lead ? null : lead.id);
    }
  }
  return changed;
}

/** Make `node` the lead of its team; the old lead becomes a worker. */
export function setLead(node) {
  if (!node.joint) throw new Error(`"${node.callSign}" is not in a team`);
  const joint = store.joints[node.joint];
  if (!joint) throw new Error(`"${node.callSign}" is not in a team`);
  joint.leadId = node.id;
  node.rank = 'lead';
}

/** Hand the lead role to the next member. Needs someone to take over. */
export function demoteLead(node) {
  if (node.rank !== 'lead') throw new Error(`"${node.callSign}" is not a lead`);
  const next = teamMembers(node.joint).find((member) => member !== node);
  if (!next) throw new Error(`"${node.callSign}" is the only member of its team`);
  setLead(next);
  node.rank = 'worker';
  return next;
}

/** Move `node` into `joint` as a worker, or out of every team when `joint` is null. */
export function moveToTeam(node, joint) {
  const leaving = node.joint ? store.joints[node.joint] : null;
  if (leaving && leaving.leadId === node.id) leaving.leadId = null;
  if (!joint) {
    node.joint = null;
    node.jointName = '';
    node.jointContextPath = '';
    node.rank = null;
    node.parentId = null;
    node.lastReport = null;
    return;
  }
  node.joint = joint.id;
  node.jointName = joint.name;
  node.jointContextPath = joint.path || '';
  node.rank = null;
  node.parentId = null;
  node.lastReport = null;
}

/** Normalise, save and redraw. Call after any change to teams. */
export function commitTeams(canvas) {
  normalizeTeams();
  store.save();
  canvas?.refreshTeams?.();
  store.emit('teams');
}

/** Teams as a tree: [{ joint, lead, workers }], in creation order. */
export function teamTree() {
  return Object.values(store.joints)
    .map((joint) => {
      const lead = teamLead(joint.id);
      const workers = teamMembers(joint.id).filter((node) => node !== lead);
      return { joint, lead, workers };
    })
    .filter((team) => team.lead);
}

/** Keep teams consistent as windows come and go. */
export function initHierarchy(canvas) {
  const sync = () => {
    if (normalizeTeams()) {
      store.save();
      canvas.refreshTeams();
    }
    store.emit('teams');
  };
  store.on('nodes', sync);
  store.on('joints', sync);
  sync();
}
