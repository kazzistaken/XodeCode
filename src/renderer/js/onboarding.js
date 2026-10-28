import { el } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { BACKGROUNDS, setBackgroundPreset } from './backgrounds.js';
import { sceneThumb } from './scenes/view.js';

/**
 * First-run setup and the guided tour.
 *
 * Setup (shown once, the first time the app opens): welcome, pick a
 * background (applied live), and connect Claude Code (install / sign in if
 * needed). Then a tour: a card glides from one part of the interface to the
 * next, with a spotlight on the part it is describing.
 *
 * Both can be replayed from Help. Finishing or skipping either marks the app
 * as set up (`settings.onboarded`).
 */

const TOUR = [
  {
    target: '#console',
    title: 'Ask the Director',
    text: 'Type what you want in plain words: "open YouTube and GitHub side by side", "start a Claude session on the login bug", "make a team of 3 to build a todo app". The Director, an AI agent that runs the canvas for you, answers right above the prompt.',
  },
  {
    target: '#cb-mic',
    title: 'Talk instead of typing',
    text: 'Click the mic (or press Ctrl+Shift+M) to dictate into whichever prompt box you were using.',
  },
  {
    target: '#viewport',
    title: 'The canvas',
    text: 'Every app opens here as a window: Claude sessions, terminals, browsers, notes, boards. Drag empty space to pan, scroll to zoom. New windows open beside the last one; zoom out to see them all.',
    spot: 'center',
  },
  {
    target: '#topbar',
    bar: true,
    title: 'Pages and menus',
    text: 'They stay tucked away until you need them. Point at the arrow at the top of the screen, or press Alt, and this bar slides down. Each page is its own canvas; Ctrl+1–9 switches between them.',
  },
  {
    target: '#dock',
    title: 'The dock',
    text: 'Closing a window parks it down here, still running. Hover a logo to see it, click to bring it back, or × to close it for good.',
    spot: 'corner',
  },
  {
    target: null,
    title: "You're all set",
    text: 'Agents that finish or need you show up in the top-right corner. Try asking the Director: "open a Claude session".',
  },
];

export function initOnboarding(ctx) {
  let root = null;
  let keyHandler = null;
  let offResize = null;

  function finish() {
    store.setSetting('onboarded', true);
    close();
  }

  function close() {
    document.body.classList.remove('bar-tour');
    offResize?.();
    offResize = null;
    if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
    if (!root) return;
    const leaving = root;
    root = null;
    leaving.classList.add('is-leaving');
    setTimeout(() => leaving.remove(), 260);
  }

  function mount(className) {
    close();
    root = el('div', { class: `onboard ${className}`, role: 'dialog', 'aria-modal': 'true' });
    document.body.append(root);
    return root;
  }

  function onKeys(handlers) {
    if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
    keyHandler = (event) => {
      const handler = handlers[event.key];
      if (!handler) return;
      event.preventDefault();
      event.stopPropagation();
      handler();
    };
    document.addEventListener('keydown', keyHandler, true);
  }

  /* -------------------------------- setup -------------------------------- */

  function startSetup() {
    const host = mount('is-setup');
    const card = el('div', { class: 'onboard-card' });
    const dots = el('div', { class: 'onboard-dots' });
    host.append(card);
    const steps = [welcomeStep, backgroundStep, claudeStep, readyStep];
    let index = 0;

    function show(next) {
      index = Math.max(0, Math.min(steps.length - 1, next));
      const body = steps[index]();
      dots.replaceChildren(
        ...steps.map((_, i) => el('span', { class: `onboard-dot${i === index ? ' is-on' : ''}` }))
      );
      card.classList.remove('is-in');
      void card.offsetWidth;
      card.replaceChildren(body, dots);
      card.classList.add('is-in');
    }

    const button = (text, onClick, primary = false) =>
      el('button', { class: `onboard-btn${primary ? ' is-primary' : ''}`, type: 'button', text, onclick: onClick });

    const footer = (...buttons) => el('div', { class: 'onboard-foot' }, ...buttons);

    function welcomeStep() {
      return el(
        'div',
        { class: 'onboard-step' },
        el('span', { class: 'onboard-mark', html: icon('xodecode') }),
        el('h1', { text: 'Welcome to XodeCode' }),
        el('p', {
          text: 'A canvas for running Claude Code agents side by side — single sessions or whole teams — with an AI Director that opens, arranges and prompts them for you.',
        }),
        el('p', { class: 'onboard-dim', text: 'Setup takes about a minute.' }),
        footer(button('Skip setup', finish), button('Get started', () => show(1), true))
      );
    }

    function backgroundStep() {
      const options = [{ id: '', label: 'Dot grid' }, ...BACKGROUNDS];
      const grid = el('div', { class: 'onboard-bgs' });
      const paint = () => {
        const selected = store.state.settings.backgroundPreset || '';
        grid.replaceChildren(
          ...options.map((option) =>
            el(
              'button',
              {
                class: `onboard-bg${option.id === selected ? ' is-on' : ''}${option.id ? '' : ' is-dots'}`,
                type: 'button',
                onclick: () => {
                  setBackgroundPreset(option.id || 'none');
                  paint();
                },
              },
              option.scene ? sceneThumb(option.scene) : null,
              el('span', { text: option.label })
            )
          )
        );
      };
      paint();
      return el(
        'div',
        { class: 'onboard-step' },
        el('h2', { text: 'Pick a background' }),
        el('p', { text: 'It fills the screen behind your windows. Each one is a small animated scene. Change it any time in Settings, under Appearance.' }),
        grid,
        footer(button('Back', () => show(0)), button('Next', () => show(2), true))
      );
    }

    function claudeStep() {
      const status = el('div', { class: 'onboard-status is-checking' }, el('span', { class: 'onboard-spin' }), 'Checking for Claude Code…');
      const actions = el('div', { class: 'onboard-actions' });
      const step = el(
        'div',
        { class: 'onboard-step' },
        el('h2', { text: 'Connect Claude' }),
        el('p', {
          text: 'XodeCode runs Claude Code on your computer, with your own Claude account. Nothing extra to pay for here — agents use your plan.',
        }),
        status,
        actions,
        footer(button('Back', () => show(1)), button('Next', () => show(3), true))
      );

      const setStatus = (kind, text) => {
        status.className = `onboard-status is-${kind}`;
        status.replaceChildren(
          kind === 'checking' ? el('span', { class: 'onboard-spin' }) : el('span', { class: 'onboard-tick', text: kind === 'ok' ? '✓' : '!' }),
          text
        );
      };
      const consoleButton = (text, action, primary) =>
        button(
          text,
          async () => {
            const result = await window.api.claude.setupConsole(action);
            if (!result?.ok) ctx.toast(result?.error || 'Could not open a console window.', 'warn');
            else ctx.toast('Follow the steps in the console window, then press Check again.');
          },
          primary
        );

      async function check() {
        setStatus('checking', 'Checking for Claude Code…');
        actions.replaceChildren();
        let result = { installed: false, loggedIn: false };
        try {
          result = await window.api.claude.authStatus();
        } catch {
          /* treat as not installed */
        }
        if (!root) return;
        const again = button('Check again', check);
        if (!result.installed) {
          setStatus('warn', 'Claude Code is not installed yet.');
          actions.replaceChildren(
            consoleButton('Install Claude Code', 'install', true),
            button('Install guide', () =>
              window.api.sys.openExternal('https://docs.claude.com/en/docs/claude-code/setup')
            ),
            again
          );
        } else if (!result.loggedIn) {
          setStatus('warn', 'Claude Code is installed, but you are not signed in.');
          actions.replaceChildren(consoleButton('Sign in to Claude', 'login', true), again);
        } else {
          const how = result.method === 'claude.ai' ? 'your Claude account' : result.method || 'your account';
          setStatus('ok', `Connected — Claude Code is signed in with ${how}.`);
          // The Director may have failed to start before sign-in.
          if (ctx.director?.status?.().status === 'dead') ctx.director.restart();
        }
      }
      check();
      return step;
    }

    function readyStep() {
      return el(
        'div',
        { class: 'onboard-step' },
        el('span', { class: 'onboard-mark', html: icon('xodecode') }),
        el('h2', { text: 'Ready' }),
        el('p', { text: 'Want a quick tour of the interface? It takes thirty seconds.' }),
        footer(
          button('Skip tour', finish),
          button('Show me around', () => startTour(), true)
        )
      );
    }

    onKeys({ Escape: finish });
    show(0);
  }

  /* -------------------------------- tour -------------------------------- */

  function startTour() {
    const host = mount('is-tour');
    const ring = el('div', { class: 'tour-ring' });
    const card = el('div', { class: 'tour-card' });
    host.append(ring, card);
    let index = 0;

    function place() {
      const step = TOUR[index];
      // The page bar is normally hidden: hold it down for its step, and
      // measure once it has slid into place.
      const barShown = document.body.classList.contains('bar-tour');
      document.body.classList.toggle('bar-tour', Boolean(step.bar));
      if (step.bar && !barShown) {
        setTimeout(() => root === host && TOUR[index] === step && place(), 240);
      }
      const target = step.target ? document.querySelector(step.target) : null;
      let rect = target ? target.getBoundingClientRect() : null;
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (rect && step.spot === 'center') {
        rect = { left: w * 0.2, top: h * 0.22, width: w * 0.6, height: h * 0.46 };
      } else if (rect && step.spot === 'corner') {
        // The dock may be empty (invisible): point at its corner anyway.
        rect = { left: 12, top: h - 96, width: 64, height: 78 };
      } else if (rect && (rect.width < 4 || rect.height < 4)) {
        rect = null;
      }
      const pad = 8;
      if (rect) {
        ring.classList.remove('is-none');
        Object.assign(ring.style, {
          left: `${rect.left - pad}px`,
          top: `${rect.top - pad}px`,
          width: `${rect.width + pad * 2}px`,
          height: `${rect.height + pad * 2}px`,
        });
      } else {
        ring.classList.add('is-none');
        Object.assign(ring.style, { left: `${w / 2}px`, top: `${h / 2}px`, width: '0px', height: '0px' });
      }

      card.replaceChildren(
        el('div', { class: 'tour-count', text: `${index + 1} of ${TOUR.length}` }),
        el('h3', { text: step.title }),
        el('p', { text: step.text }),
        el(
          'div',
          { class: 'tour-foot' },
          index < TOUR.length - 1
            ? el('button', { class: 'onboard-btn is-quiet', type: 'button', text: 'Skip tour', onclick: finish })
            : el('span'),
          el(
            'div',
            { class: 'tour-nav' },
            index > 0 ? el('button', { class: 'onboard-btn', type: 'button', text: 'Back', onclick: () => go(-1) }) : null,
            el('button', {
              class: 'onboard-btn is-primary',
              type: 'button',
              text: index === TOUR.length - 1 ? 'Finish' : 'Next',
              onclick: () => (index === TOUR.length - 1 ? finish() : go(1)),
            })
          )
        )
      );

      // Beside the spotlight when there is room, kept fully on screen; the
      // transition on left/top makes it glide from step to step.
      const cw = card.offsetWidth || 360;
      const ch = card.offsetHeight || 180;
      let left;
      let top;
      if (!rect) {
        left = (w - cw) / 2;
        top = (h - ch) / 2;
      } else if (rect.top + rect.height + pad + 16 + ch < h - 12) {
        left = rect.left + rect.width / 2 - cw / 2;
        top = rect.top + rect.height + pad + 16;
      } else if (rect.top - pad - 16 - ch > 12) {
        left = rect.left + rect.width / 2 - cw / 2;
        top = rect.top - pad - 16 - ch;
      } else if (rect.left + rect.width + pad + 16 + cw < w - 12) {
        left = rect.left + rect.width + pad + 16;
        top = rect.top + rect.height / 2 - ch / 2;
      } else {
        left = rect.left - pad - 16 - cw;
        top = rect.top + rect.height / 2 - ch / 2;
      }
      card.style.left = `${Math.max(12, Math.min(w - cw - 12, left))}px`;
      card.style.top = `${Math.max(12, Math.min(h - ch - 12, top))}px`;
    }

    function go(step) {
      index = Math.max(0, Math.min(TOUR.length - 1, index + step));
      place();
    }

    onKeys({
      Escape: finish,
      ArrowRight: () => (index === TOUR.length - 1 ? finish() : go(1)),
      Enter: () => (index === TOUR.length - 1 ? finish() : go(1)),
      ArrowLeft: () => go(-1),
    });
    const onResize = () => root === host && place();
    window.addEventListener('resize', onResize);
    offResize = () => window.removeEventListener('resize', onResize);
    requestAnimationFrame(() => {
      place();
      host.classList.add('is-in');
    });
  }

  if (!store.state.settings.onboarded) {
    // Let the interface draw first so the tour can find its parts.
    setTimeout(startSetup, 400);
  }

  return { start: startSetup, tour: startTour };
}
