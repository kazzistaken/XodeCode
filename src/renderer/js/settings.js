import { el, MOD, SHIFT } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { openOverlay, closeOverlay } from './overlay.js';
import { BACKGROUNDS, setBackgroundPreset } from './backgrounds.js';
import { sceneThumb } from './scenes/view.js';

const TABS = [
  { id: 'appearance', label: 'Appearance', icon: 'style', blurb: 'The scene behind your windows and how the app looks.' },
  { id: 'canvas', label: 'Canvas', icon: 'grid', blurb: 'How windows are placed and arranged.' },
  { id: 'agents', label: 'Agents', icon: 'agents', blurb: 'Claude Code sessions and your terminals.' },
  { id: 'director', label: 'Director', icon: 'sparkle', blurb: 'The assistant that runs your agents, and dictation.' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'shortcuts', blurb: 'Keys worth knowing.' },
];

const MODEL_LABEL = {
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-fable-5-1': 'Fable 5.1',
};

/** Shrink a picked image so the data URL is small enough to persist. */
function downscaleImage(dataUrl, maxW = 1920, maxH = 1080, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxW / img.width, maxH / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function settingRow({ title, desc, value, onChange }) {
  const knob = el('button', {
    class: `switch${value ? ' is-on' : ''}`,
    type: 'button',
    role: 'switch',
    'aria-checked': String(Boolean(value)),
    onclick: () => {
      const next = !knob.classList.contains('is-on');
      knob.classList.toggle('is-on', next);
      knob.setAttribute('aria-checked', String(next));
      onChange(next);
    },
  });
  return el(
    'div',
    { class: 'setting' },
    el(
      'div',
      { class: 'setting-text' },
      el('div', { class: 'setting-title', text: title }),
      el('div', { class: 'setting-desc', text: desc })
    ),
    knob
  );
}

const groupLabel = (text) => el('div', { class: 'group-label', text });

/** Put each run of rows under a heading into one rounded group. */
function groupRows(body) {
  let group = null;
  for (const child of Array.from(body.children)) {
    if (child.matches('.setting, .field-row')) {
      if (!group) {
        group = el('div', { class: 'setting-group' });
        child.before(group);
      }
      group.append(child);
    } else {
      group = null;
    }
  }
}

export function initSettings(ctx) {
  let activeTab = 'appearance';

  function sheet() {
    const nav = el('nav', { class: 'sheet-nav' }, el('h2', { text: 'Settings' }));
    if (!TABS.some((item) => item.id === activeTab)) activeTab = 'appearance';
    const main = el('div', { class: 'sheet-main' });

    const renderMain = () => {
      main.replaceChildren();
      const tab = TABS.find((item) => item.id === activeTab) || TABS[0];

      main.append(
        el(
          'div',
          { class: 'sheet-head' },
          el('div', {}, el('h3', { text: tab.label }), el('p', { text: tab.blurb })),
          el('button', {
            class: 'sheet-close',
            type: 'button',
            title: 'Close',
            html: icon('x'),
            onclick: () => closeOverlay(),
          })
        )
      );

      const body = el('div', { class: 'sheet-body' });
      main.append(body);

      if (tab.id === 'appearance') {
        const settings = store.state.settings;
        const current = settings.background ? settings.backgroundPreset || 'custom' : 'none';
        // Built-in scenes plus "no picture", as preview cards.
        const card = (id, label, thumb, onPick) =>
          el(
            'button',
            {
              class: `bg-card${current === id ? ' is-active' : ''}`,
              type: 'button',
              title: label,
              onclick: () => {
                onPick();
                renderMain();
              },
            },
            thumb,
            el('span', { class: 'bg-card-label', text: label })
          );
        const thumbFor = (style) => el('span', { class: 'bg-card-thumb', style });
        const cards = [
          card('none', 'Dot grid', thumbFor({ backgroundColor: 'var(--canvas)' }), () => setBackgroundPreset('none')),
          ...BACKGROUNDS.map((preset) =>
            card(
              preset.id,
              preset.label,
              preset.scene
                ? sceneThumb(preset.scene)
                : thumbFor({
                    backgroundImage: `url("${preset.src}")`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    imageRendering: preset.pixelated ? 'pixelated' : 'auto',
                  }),
              () => setBackgroundPreset(preset.id)
            )
          ),
        ];
        if (current === 'custom') {
          cards.push(
            card(
              'custom',
              'Your picture',
              thumbFor({ backgroundImage: `url("${settings.background}")`, backgroundSize: 'cover', backgroundPosition: 'center' }),
              () => {}
            )
          );
        }

        body.append(
          groupLabel('Background'),
          el('div', { class: 'bg-cards' }, ...cards),
          el(
            'div',
            { class: 'field-row' },
            el(
              'div',
              { class: 'setting-text' },
              el('div', { class: 'setting-title', text: 'Your own picture' }),
              el('div', { class: 'setting-desc', text: 'It keeps its proportions: Fill crops the edges, Fit shows all of it.' })
            ),
            settings.background && !settings.backgroundPreset
              ? (() => {
                  const select = el('select', {
                    class: 'voice-select',
                    'aria-label': 'Picture fit',
                    onchange: (event) => {
                      store.setSetting('backgroundFit', event.target.value);
                      renderMain();
                    },
                  });
                  const fit = settings.backgroundFit || 'contain';
                  for (const [value, label] of [
                    ['cover', 'Fill'],
                    ['contain', 'Fit'],
                    ['center', 'Actual size'],
                    ['tile', 'Tile'],
                  ]) {
                    const option = el('option', { value, text: label });
                    if (value === fit) option.selected = true;
                    select.append(option);
                  }
                  return select;
                })()
              : null,
            el('button', {
              class: 'btn',
              type: 'button',
              text: 'Choose…',
              onclick: async () => {
                try {
                  const picked = await window.api.sys.pickImage();
                  if (!picked) return;
                  const dataUrl = await downscaleImage(picked.dataUrl);
                  setBackgroundPreset('none');
                  store.state.settings.backgroundFit = 'cover';
                  store.setSetting('background', dataUrl);
                  renderMain();
                } catch (error) {
                  ctx.toast(error?.message || 'Could not use that picture.', 'warn');
                }
              },
            })
          ),
          settingRow({
            title: 'Animate the scene',
            desc: 'Water, light and weather move gently. Pauses while XodeCode is minimized.',
            value: settings.animateScene !== false,
            onChange: (value) => store.setSetting('animateScene', value),
          }),
          groupLabel('Interface'),
          settingRow({
            title: 'Always show the page bar',
            desc: 'Keep pages and menus at the top instead of showing them when you point at the top edge or press Alt.',
            value: Boolean(settings.pinTopbar),
            onChange: (value) => store.setSetting('pinTopbar', value),
          }),
          settingRow({
            title: 'Solid panels',
            desc: 'Use plain solid colors instead of see-through panels.',
            value: Boolean(settings.flatUi),
            onChange: (value) => store.setSetting('flatUi', value),
          })
        );
      }

      if (tab.id === 'canvas') {
        body.append(
          groupLabel('Layout'),
          settingRow({
            title: 'Auto-arrange windows',
            desc: 'Keep every window in order automatically. Turn off to place windows freely.',
            value: store.state.settings.autoLayout !== false,
            onChange: (value) => {
              store.setSetting('autoLayout', value);
              if (value) ctx.canvas.relayout?.({ animate: true });
            },
          }),
          settingRow({
            title: 'Keep windows at their own size',
            desc: 'Windows line up in rows at the size you give them, past the edge of the screen; zoom out to see them all. Off: every window is tiled to fit on screen.',
            value: store.state.settings.flowLayout === true,
            onChange: (value) => {
              store.setSetting('flowLayout', value);
              ctx.canvas.relayout?.({ force: true, animate: true });
            },
          }),
          settingRow({
            title: 'Snap to grid',
            desc: 'Windows settle onto the grid as you move them.',
            value: store.state.settings.snapToGrid,
            onChange: (value) => store.setSetting('snapToGrid', value),
          }),
          groupLabel('This page’s workspace'),
          el(
            'div',
            { class: 'field-row' },
            el('code', {
              text: store.page.workspace || 'Not set. Agents start in your home folder.',
            }),
            el('button', {
              class: 'btn',
              type: 'button',
              text: 'Change…',
              onclick: () => ctx.pickPageWorkspace(),
            })
          )
        );
      }

      if (tab.id === 'agents') {
        const list = el('div', { class: 'agent-list' });
        const agents = store.allNodes().filter((node) => node.kind === 'terminal');

        if (!agents.length) {
          list.append(el('div', { class: 'agent-empty', text: 'No agents on the canvas yet.' }));
        }
        for (const node of agents) {
          list.append(
            el(
              'div',
              { class: 'agent-row' },
              el('span', { class: 'agent-row-dot', 'data-status': node.status }),
              el('span', { class: 'agent-row-name', text: node.callSign }),
              el('span', { class: 'agent-row-title', text: node.title || '' }),
              el('span', {
                class: 'agent-row-model',
                text:
                  node.cli === 'claude'
                    ? `${MODEL_LABEL[node.model] || node.model || '—'} · ${node.effort || '—'}`
                    : 'shell',
              })
            )
          );
        }

        body.append(
          groupLabel('Claude Code'),
          el(
            'div',
            { class: 'field-row' },
            el('code', {
              text: ctx.sysInfo?.claude
                ? 'claude found on PATH'
                : 'claude not found on PATH — install Claude Code',
            })
          ),
          groupLabel('Model policy'),
          el(
            'div',
            { class: 'setting' },
            el(
              'div',
              { class: 'setting-text' },
              el('div', { class: 'setting-title', text: 'Agents run Sonnet 5.5 or Opus 5.5' }),
              el('div', {
                class: 'setting-desc',
                text: 'Sonnet 5.5 by default, Opus 5.5 for hard work. Haiku and Fable are used only when you ask for them by name.',
              })
            ),
            el('span', { class: 'policy-tag', text: 'Default' })
          ),
          groupLabel('Watching'),
          settingRow({
            title: 'Follow mode',
            desc: 'When an agent starts working, needs you or finishes, the camera glides over to it, then back to where you were. Moving the camera yourself pauses it for a few seconds.',
            value: Boolean(store.state.settings.followMode),
            onChange: (value) => store.setSetting('followMode', value),
          }),
          groupLabel('Notifications'),
          settingRow({
            title: 'Agent notifications',
            desc: 'List agents when they finish or need you (top right), and send a system notification while XodeCode is in the background.',
            value: store.state.settings.agentNotifications,
            onChange: (value) => store.setSetting('agentNotifications', value),
          }),
          groupLabel('Permissions'),
          settingRow({
            title: 'Full permissions',
            desc: 'Agents run with --permission-mode bypassPermissions, so they never stop to ask before editing files or running commands. Turn this off to be prompted instead.',
            value: store.state.settings.agentFullPermissions !== false,
            onChange: (value) => {
              store.setSetting('agentFullPermissions', value);
              ctx.toast(
                value
                  ? 'Agents now run with full permissions.'
                  : 'Agents will ask before editing or running commands. Restart their terminals to apply.'
              );
            },
          }),
          groupLabel('On the canvas'),
          list
        );
      }

      if (tab.id === 'director') {
        const status = ctx.director.status();
        const editor = el('textarea', {
          class: 'context-editor',
          spellcheck: 'false',
          rows: '9',
        });
        editor.value = store.state.sharedContext || '';

        body.append(
          groupLabel('Session'),
          el(
            'div',
            { class: 'field-row' },
            el('code', { text: 'Opens, closes and arranges windows, and prompts agents' }),
            el('span', { class: `director-pill is-${status.status}`, text: status.status })
          ),
          el(
            'div',
            { class: 'field-row' },
            el('span', { class: 'setting-title', text: 'Model' }),
            (() => {
              const select = el('select', {
                class: 'voice-select',
                'aria-label': 'Director model',
                onchange: (event) => {
                  store.setSetting('directorModel', event.target.value);
                  ctx.director.restart();
                  ctx.toast('Director restarted on the new model.');
                },
              });
              for (const [id, label] of Object.entries(MODEL_LABEL)) {
                select.append(el('option', { value: id, text: label }));
              }
              select.value = store.state.settings.directorModel || 'claude-sonnet-5-5';
              return select;
            })(),
            el('span', { class: 'setting-title', text: 'Effort' }),
            (() => {
              const select = el('select', {
                class: 'voice-select',
                'aria-label': 'Director effort',
                onchange: (event) => {
                  store.setSetting('directorEffort', event.target.value);
                  ctx.director.restart();
                },
              });
              for (const effort of ['low', 'medium', 'high']) {
                select.append(el('option', { value: effort, text: effort }));
              }
              select.value = store.state.settings.directorEffort || 'low';
              return select;
            })()
          ),
          el('div', {
            class: 'setting-desc',
            style: { margin: '0 0 8px' },
            text: 'Sonnet at low effort answers fastest. Simple commands (open, close, arrange) skip the Director entirely.',
          }),
          el(
            'div',
            { class: 'field-row' },
            el('button', {
              class: 'btn',
              type: 'button',
              text: 'Open Director log',
              onclick: () => ctx.openDirectorLog(),
            }),
            el('code', { text: ctx.sysInfo?.paths?.cli || 'bin/xode.js' })
          ),
          groupLabel('Dictation'),
          settingRow({
            title: 'Use the Windows voice typing panel',
            desc: 'Off: dictation runs inside XodeCode and your words appear live in the prompt. On: the mic opens Windows voice typing (Win+H) and its panel instead.',
            value: store.state.settings.dictation === 'windows',
            onChange: (value) => {
              store.state.settings.dictationChosen = true;
              store.setSetting('dictation', value ? 'windows' : 'app');
            },
          }),
          groupLabel('Shared context'),
          el('div', {
            class: 'setting-desc',
            style: { margin: '0 0 8px' },
            text: `${ctx.sysInfo?.paths?.context || 'fleet-context.md'} — every agent reads this at startup.`,
          }),
          editor,
          el(
            'div',
            { class: 'editor-actions' },
            el('button', {
              class: 'btn primary',
              type: 'button',
              text: 'Save context',
              onclick: () => {
                store.state.sharedContext = editor.value;
                ctx.syncContext();
                ctx.toast('Shared context saved.');
              },
            })
          ),
          groupLabel('Spend'),
          el(
            'div',
            { class: 'field-row' },
            el('code', { text: `$${(store.state.spend.total || 0).toFixed(2)} spent this install` }),
            el('button', {
              class: 'btn',
              type: 'button',
              text: 'Reset',
              onclick: () => {
                store.state.spend = { total: 0, byModel: {}, updatedAt: 0 };
                store.save();
                store.emit('spend', store.state.spend);
                renderMain();
              },
            })
          ),
          el(
            'div',
            { class: 'field-row' },
            el('span', { class: 'setting-title', text: 'Budget cap' }),
            (() => {
              const input = el('input', {
                class: 'budget-input',
                type: 'number',
                min: '0',
                step: '1',
                value: String(store.state.settings.budgetUsd || 0),
                'aria-label': 'Budget cap in dollars',
                onchange: () => {
                  store.setSetting('budgetUsd', Math.max(0, Number(input.value) || 0));
                  ctx.toast('Budget updated.');
                },
              });
              return input;
            })()
          )
        );
      }

      if (tab.id === 'shortcuts') {
        const rows = [
          [`${MOD} K`, 'Focus the Director prompt'],
          [`${MOD} ${SHIFT} D`, 'Open the Director log'],
          [`${MOD} ${SHIFT} M`, 'Start or stop dictation'],
          [`${MOD} N`, 'New Claude agent terminal'],
          [`${MOD} ${SHIFT} N`, 'New plain terminal'],
          [`${MOD} 1…9`, 'Jump to a page'],
          [`${MOD} ${SHIFT} O`, 'Open the map'],
          [`${MOD} ,`, 'Open settings'],
          [`${MOD} 0`, 'Reset zoom to 100%'],
          [`${MOD} +/-`, 'Zoom in and out'],
          ['Drag empty canvas', 'Pan the canvas'],
          ['Scroll', 'Zoom the canvas'],
          ['Esc', 'Back to the select tool'],
          ['Delete', 'Remove the focused window'],
          ['I', 'Place an image'],
          ['F5', 'Reload the app (dev)'],
        ];
        for (const [key, desc] of rows) {
          body.append(
            el(
              'div',
              { class: 'shortcut-row' },
              el('kbd', { class: 'key', text: key }),
              el('span', { text: desc })
            )
          );
        }
      }

      groupRows(body);

      main.append(
        el(
          'div',
          { class: 'sheet-foot' },
          el('span', { text: `XodeCode ${ctx.sysInfo?.version || '0.1.0'}` }),
          el('span', {
            text: `${ctx.sysInfo?.shell || 'shell'} on ${ctx.sysInfo?.platform || ''}`,
            style: { marginLeft: 'auto' },
          })
        )
      );
    };

    for (const tab of TABS) {
      nav.append(
        el(
          'button',
          {
            class: `nav-item${tab.id === activeTab ? ' is-active' : ''}`,
            type: 'button',
            html: icon(tab.icon),
            onclick: () => {
              activeTab = tab.id;
              for (const button of nav.querySelectorAll('.nav-item')) {
                button.classList.remove('is-active');
              }
              renderMain();
              const index = TABS.findIndex((item) => item.id === activeTab);
              nav.querySelectorAll('.nav-item')[index]?.classList.add('is-active');
            },
          },
          el('span', { text: tab.label })
        )
      );
    }

    renderMain();
    return el('div', { class: 'sheet' }, nav, main);
  }

  return {
    open: (tab) => {
      if (tab) activeTab = tab;
      openOverlay(sheet());
    },
    close: closeOverlay,
  };
}
