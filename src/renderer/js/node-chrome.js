import { el } from './util.js';
import { icon } from './icons.js';

/**
 * Builds the shared window chrome (title bar, status dot, actions, resize grip)
 * that every canvas node reuses. Returns the pieces so node factories can fill
 * in the body and wire up their own behaviour.
 */
export function buildNodeChrome(meta, options = {}) {
  const { brand = 'shell', iconName = 'terminal', chrome = true, actions = [] } = options;

  const root = el('div', { class: `node node--${meta.kind}` });

  const titleEl = el('span', { class: 'node-title', text: meta.callSign || '' });
  const subEl = el('span', { class: 'node-sub', text: meta.subtitle || '' });
  const dotEl = el('span', { class: 'node-status is-idle' });
  const actionsEl = el('div', { class: 'node-actions' });

  let head = null;
  if (chrome) {
    const iconEl = el('span', {
      class: `node-ic brand-${brand}`,
      html: icon(iconName),
    });
    const jointEl = meta.joint
      ? el('span', {
          class: 'node-joint',
          text: meta.jointName || 'Joint',
          title: `Jointed team: ${meta.jointName || meta.joint}`,
        })
      : null;
    head = el(
      'div',
      { class: 'node-head' },
      iconEl,
      el('div', { class: 'node-titles' }, titleEl, subEl),
      jointEl,
      dotEl,
      actionsEl
    );
    root.append(head);
  }

  const body = el('div', { class: 'node-body' });
  root.append(body);

  const resize = el('div', { class: 'node-resize' });
  root.append(resize);

  for (const action of actions) {
    actionsEl.append(
      el('button', {
        class: `node-act${action.danger ? ' danger' : ''}`,
        type: 'button',
        title: action.title,
        'aria-label': action.title,
        html: icon(action.icon),
        // Never let a chrome button start a node drag or reach the canvas.
        onpointerdown: (event) => {
          event.stopPropagation();
        },
        onclick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          action.onClick(event);
        },
      })
    );
  }

  return { root, head, body, resize, titleEl, subEl, dotEl, actionsEl };
}

export function statusClass(status) {
  if (status === 'working') return 'node-status is-working';
  if (status === 'needs') return 'node-status is-needs';
  if (status === 'dead') return 'node-status is-dead';
  return 'node-status is-idle';
}
