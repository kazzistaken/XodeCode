import { el } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { buildNodeChrome } from './node-chrome.js';
import { registerNodeType } from './canvas.js';
import { teamTasks } from './hierarchy.js';

/**
 * Task board node — a small kanban the Director (or you) keep updated as
 * workstreams move from todo to doing to done.
 *
 * A team board (`payload.joint`) shows that team's own tasks, which move by
 * themselves as members get work and report back.
 */

const COLUMNS = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done' },
];

function createBoardView(meta, canvas) {
  if (!meta.payload || typeof meta.payload !== 'object') meta.payload = {};
  if (!Array.isArray(meta.payload.tasks)) meta.payload.tasks = [];
  const team = () => (meta.payload.joint ? store.joints[meta.payload.joint] || null : null);
  // Team boards read and write the team's task list; others keep their own.
  const tasks = () => (team() ? teamTasks(team()) : meta.payload.tasks);

  const chrome = buildNodeChrome(meta, {
    brand: 'note',
    iconName: 'summarizer',
    actions: [
      { icon: 'x', title: 'Close board', danger: true, onClick: () => canvas.closeNode(meta.id) },
    ],
  });
  chrome.titleEl.textContent = meta.callSign;
  chrome.subEl.textContent = team() ? `${team().name} · live` : 'Task board';
  chrome.body.classList.add('board-body');

  function save() {
    store.save();
  }

  function moveTask(task, status) {
    task.status = status;
    save();
    render();
  }

  function removeTask(task) {
    const list = tasks();
    const index = list.indexOf(task);
    if (index !== -1) list.splice(index, 1);
    save();
    render();
  }

  function addTask(status, title) {
    const text = String(title || '').trim();
    if (!text) return;
    tasks().push({ id: `t_${Date.now().toString(36)}`, title: text, status, owner: '' });
    save();
    render();
  }

  function render() {
    chrome.body.replaceChildren();
    for (const column of COLUMNS) {
      const list = tasks().filter((task) => task.status === column.id);
      const input = el('input', {
        class: 'board-input',
        type: 'text',
        placeholder: '+ add',
        spellcheck: 'false',
        onpointerdown: (event) => event.stopPropagation(),
        onkeydown: (event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            addTask(column.id, input.value);
            input.value = '';
          }
        },
      });
      const col = el(
        'div',
        { class: 'board-col' },
        el(
          'div',
          { class: 'board-col-head' },
          el('span', { text: column.label }),
          el('span', { class: 'board-count', text: String(list.length) })
        ),
        ...list.map((task) => {
          const index = COLUMNS.findIndex((c) => c.id === task.status);
          return el(
            'div',
            { class: `board-card is-${task.status}${task.flag ? ` is-${task.flag}` : ''}` },
            el('div', { class: 'board-card-title', text: task.title }),
            task.owner
              ? el('div', { class: 'board-card-owner', text: task.flag ? `${task.owner} · ${task.flag}` : task.owner })
              : null,
            el(
              'div',
              { class: 'board-card-actions' },
              index > 0
                ? el('button', {
                    class: 'board-btn',
                    type: 'button',
                    title: 'Move back',
                    html: icon('chevronLeft'),
                    onclick: () => moveTask(task, COLUMNS[index - 1].id),
                  })
                : null,
              index < COLUMNS.length - 1
                ? el('button', {
                    class: 'board-btn',
                    type: 'button',
                    title: 'Move forward',
                    html: icon('chevronRight'),
                    onclick: () => moveTask(task, COLUMNS[index + 1].id),
                  })
                : null,
              el('button', {
                class: 'board-btn is-danger',
                type: 'button',
                title: 'Remove',
                html: icon('x'),
                onclick: () => removeTask(task),
              })
            )
          );
        }),
        input
      );
      chrome.body.append(col);
    }
  }

  render();
  const offTeams = meta.payload.joint ? store.on('teams', render) : null;

  return {
    el: chrome.root,
    focus: () => {},
    syncTitles: () => {
      chrome.titleEl.textContent = meta.callSign;
      chrome.subEl.textContent = team() ? `${team().name} · live` : 'Task board';
    },
    refresh: render,
    resize: () => {},
    destroy: () => offTeams?.(),
  };
}

registerNodeType('board', createBoardView);

export function openBoard(canvas, options = {}) {
  return canvas.createNode({
    kind: 'board',
    w: options.w ?? 720,
    h: options.h ?? 380,
    callSign: options.title || 'Board',
    title: options.title || 'Board',
    payload: {
      tasks: Array.isArray(options.tasks) ? options.tasks : [],
      joint: options.joint || undefined,
    },
  });
}
