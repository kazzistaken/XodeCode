import { el, truncate } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { teamTree, teamTasks, teamSpendLabel } from './hierarchy.js';

/**
 * Hierarchy view: an org chart of the whole chain of command.
 *
 *   You (the user)
 *     the Director (the app's AI agent)
 *       one column per team: lead card, then its workers
 *
 * Each card shows status, current task and the latest report; clicking one
 * jumps to that window. Only jointed teams appear here.
 */

const STATUS_TEXT = { working: 'working', needs: 'needs you', dead: 'stopped', idle: 'idle' };

function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function currentTask(joint, node) {
  const tasks = teamTasks(joint).filter((task) => task.nodeId === node.id);
  const open = tasks.filter((task) => task.status !== 'done');
  return (open[open.length - 1] || tasks[tasks.length - 1] || null);
}

export function buildHierarchySheet(ctx, close) {
  const chart = el('div', { class: 'hv-chart' });
  const sheet = el(
    'div',
    { class: 'log-sheet hv-sheet' },
    el(
      'div',
      { class: 'hv-head' },
      el('h3', { text: 'Hierarchy' }),
      el('span', { class: 'hv-sub', text: 'You › Director › leads › workers' }),
      el('button', {
        class: 'sheet-close',
        type: 'button',
        title: 'Close',
        html: icon('x'),
        onclick: () => close(),
      })
    ),
    el('div', { class: 'hv-scroll' }, chart)
  );

  function card(node, joint, rank) {
    const task = currentTask(joint, node);
    const report = node.lastReport;
    const status = node.status || 'idle';
    return el(
      'button',
      {
        class: `hv-card is-${rank}`,
        type: 'button',
        style: { '--joint-color': joint.color || '#cfcfcf' },
        title: `Go to ${node.callSign}`,
        onclick: () => {
          ctx.canvas.focusAgent(node.id);
          close();
        },
      },
      el(
        'div',
        { class: 'hv-card-top' },
        el('span', { class: `hv-dot is-${status}` }),
        el('b', { text: node.callSign }),
        el('span', { class: 'hv-rank', text: rank === 'lead' ? 'Lead' : 'Worker' })
      ),
      el(
        'div',
        { class: 'hv-meta' },
        `${String(node.model || '').replace(/^claude-/, '')} · ${node.effort || 'medium'} · ${STATUS_TEXT[status] || status}${node.parked ? ' · docked' : ''}`
      ),
      el('div', {
        class: `hv-task${task && task.flag ? ` is-${task.flag}` : ''}`,
        text: task ? `${task.status === 'done' ? '✓ ' : ''}${truncate(task.title, 90)}` : node.title || 'No task yet',
      }),
      report
        ? el(
            'div',
            { class: `hv-report is-${report.status}` },
            el('b', { text: report.status }),
            el('span', { text: truncate(report.text, 120) }),
            el('i', { text: ago(report.at) })
          )
        : null
    );
  }

  function paint() {
    const teams = teamTree();
    const dstatus = ctx.director?.status?.().status || 'idle';
    const top = el(
      'div',
      { class: 'hv-top' },
      el('div', { class: 'hv-root is-user' }, el('b', { text: 'You' }), el('span', { text: 'the user' })),
      el('div', { class: 'hv-stem' }),
      el(
        'button',
        {
          class: 'hv-root is-director',
          type: 'button',
          title: 'Open the Director',
          onclick: () => {
            close();
            ctx.openDirectorLog();
          },
        },
        el('span', { class: `hv-dot is-${dstatus === 'working' ? 'working' : dstatus === 'dead' ? 'dead' : 'idle'}` }),
        el('b', { text: 'Director' }),
        el('span', { text: `AI agent · ${dstatus}` })
      )
    );
    if (!teams.length) {
      chart.replaceChildren(
        top,
        el('p', {
          class: 'hv-empty',
          text: 'No teams yet. Ask the Director for a jointed team, e.g. "make a team of 3 to build a todo app".',
        })
      );
      return;
    }
    const columns = teams.map(({ joint, lead, workers }) => {
      const tasks = teamTasks(joint);
      const count = (status) => tasks.filter((task) => task.status === status).length;
      return el(
        'div',
        { class: 'hv-team', style: { '--joint-color': joint.color || '#cfcfcf' } },
        el(
          'div',
          { class: 'hv-team-head' },
          el('b', { text: joint.name }),
          el('span', { text: `${teamSpendLabel(joint)} · ${count('doing')} doing · ${count('done')} done` })
        ),
        card(lead, joint, 'lead'),
        workers.length
          ? el('div', { class: 'hv-workers' }, ...workers.map((node) => card(node, joint, 'worker')))
          : el('div', { class: 'hv-none', text: 'No workers' })
      );
    });
    chart.replaceChildren(top, el('div', { class: 'hv-stem' }), el('div', { class: 'hv-teams' }, ...columns));
  }

  paint();
  const offs = [store.on('teams', paint), store.on('nodes', paint), ctx.director?.subscribe?.(paint)];
  // Status dots and "ago" times change without store events.
  const timer = setInterval(paint, 4000);

  return {
    el: sheet,
    destroy: () => {
      clearInterval(timer);
      for (const off of offs) if (typeof off === 'function') off();
    },
  };
}
