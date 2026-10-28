import { el } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { buildNodeChrome } from './node-chrome.js';
import { registerNodeType } from './canvas.js';

const DEFAULT_URL = 'https://duckduckgo.com/';

/** Sites people name without a domain ("open youtube"). */
export const KNOWN_SITES = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  github: 'https://github.com',
  gmail: 'https://mail.google.com',
  reddit: 'https://www.reddit.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  spotify: 'https://open.spotify.com',
  wikipedia: 'https://www.wikipedia.org',
  netflix: 'https://www.netflix.com',
  twitch: 'https://www.twitch.tv',
  amazon: 'https://www.amazon.com',
  claude: 'https://claude.ai',
  chatgpt: 'https://chatgpt.com',
  stackoverflow: 'https://stackoverflow.com',
  'stack overflow': 'https://stackoverflow.com',
  hackernews: 'https://news.ycombinator.com',
  'hacker news': 'https://news.ycombinator.com',
  maps: 'https://maps.google.com',
  'google maps': 'https://maps.google.com',
  docs: 'https://docs.google.com',
  'google docs': 'https://docs.google.com',
  drive: 'https://drive.google.com',
  'google drive': 'https://drive.google.com',
  linkedin: 'https://www.linkedin.com',
  instagram: 'https://www.instagram.com',
  facebook: 'https://www.facebook.com',
  discord: 'https://discord.com/app',
  figma: 'https://www.figma.com',
  notion: 'https://www.notion.so',
  vercel: 'https://vercel.com',
  npm: 'https://www.npmjs.com',
  mdn: 'https://developer.mozilla.org',
};

/** Cap on how far a page is supersampled when zoomed in. */
const MAX_RENDER = 2.4;

export function normalizeUrl(input) {
  const text = String(input || '').trim();
  if (!text) return DEFAULT_URL;
  if (/^(https?|file|about|data):/i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  const known = KNOWN_SITES[text.toLowerCase()];
  if (known) return known;
  // "localhost:3000", "example.com/path"
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(text)) return `http://${text}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(text)) return `https://${text}`;
  // A single bare word is almost always a .com; anything else is a search.
  if (/^[a-z0-9-]{2,30}$/i.test(text)) return `https://www.${text.toLowerCase()}.com`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/** True when the text looks like something to open in a browser. */
export function looksLikeSite(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return false;
  if (KNOWN_SITES[text]) return true;
  return /^(https?:\/\/|www\.)/.test(text) || /^[\w-]+(\.[\w-]{2,})+(:\d+)?(\/\S*)?$/.test(text) || /^localhost(:\d+)?/.test(text);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function navButton(iconName, title, onClick) {
  return el('button', {
    class: 'browser-btn',
    type: 'button',
    title,
    'aria-label': title,
    html: icon(iconName),
    onpointerdown: (event) => event.stopPropagation(),
    onclick: (event) => {
      event.stopPropagation();
      onClick();
    },
  });
}

function createBrowserView(meta, canvas) {
  if (!meta.payload || typeof meta.payload !== 'object') meta.payload = {};
  let url = normalizeUrl(meta.payload.url);
  meta.payload.url = url;

  const chrome = buildNodeChrome(meta, {
    brand: 'browser',
    iconName: 'globe',
    actions: [
      {
        icon: 'x',
        title: 'Close browser',
        danger: true,
        onClick: () => canvas.closeNode(meta.id),
      },
    ],
  });

  const webview = el('webview', {
    class: 'browser-view',
    src: url,
    partition: 'persist:xode-browser',
  });

  const address = el('input', {
    class: 'browser-url',
    type: 'text',
    spellcheck: 'false',
    value: url,
    'aria-label': 'Address',
    onpointerdown: (event) => event.stopPropagation(),
    onfocus: () => address.select(),
    onkeydown: (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        go(address.value);
        address.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        address.value = url;
        address.blur();
      }
    },
  });

  const back = navButton('chevronLeft', 'Back', () => webview.goBack?.());
  const forward = navButton('chevronRight', 'Forward', () => webview.goForward?.());
  const reload = navButton('refresh', 'Reload', () => webview.reload?.());
  const toolbar = el('div', { class: 'browser-bar' }, back, forward, reload, address);

  const host = el('div', { class: 'browser-host' }, webview);
  chrome.body.append(toolbar, host);


  function setUrl(next, { load = false } = {}) {
    url = next;
    meta.payload.url = next;
    address.value = next;
    if (meta.title) chrome.subEl.textContent = meta.title;
    if (load) webview.loadURL(next);
    store.save();
  }

  function go(input) {
    const next = normalizeUrl(input);
    setUrl(next, { load: true });
  }

  function updateNav() {
    try {
      back.disabled = !webview.canGoBack?.();
      forward.disabled = !webview.canGoForward?.();
    } catch {
      /* webview not ready yet */
    }
  }

  function setTitle(title) {
    meta.title = title || hostOf(url) || 'Browser';
    chrome.subEl.textContent = meta.title;
    store.save();
  }

  // Agent tools wait for a page to finish loading before reading it.
  let loading = true;
  const loadWaiters = new Set();
  function waitForLoad(timeout = 15000) {
    if (!loading && domReady) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        loadWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeout);
      loadWaiters.add(done);
    });
  }

  webview.addEventListener('did-start-loading', () => {
    loading = true;
    chrome.root.classList.add('is-loading');
  });
  webview.addEventListener('did-stop-loading', () => {
    loading = false;
    chrome.root.classList.remove('is-loading');
    updateNav();
    for (const done of [...loadWaiters]) done();
  });
  webview.addEventListener('did-navigate', (event) => {
    setUrl(event.url);
    updateNav();
  });
  webview.addEventListener('did-navigate-in-page', (event) => {
    setUrl(event.url);
    updateNav();
  });
  webview.addEventListener('page-title-updated', (event) => setTitle(event.title));
  webview.addEventListener('did-fail-load', (event) => {
    if (event.errorCode === -3) return; // user aborted
    chrome.root.classList.add('has-error');
  });
  // Page zoom follows the window size, so text grows with the window.
  let contentScale = 1;
  let domReady = false;
  // Like terminals, the page renders at the canvas zoom (bigger box, higher
  // page zoom) and is scaled back down, so zooming in stays sharp instead of
  // magnifying a 100% bitmap. Zoomed out, 1x is already crisp.
  let renderScale = Math.min(MAX_RENDER, Math.max(1, store.page.viewport?.scale || 1));
  let zoomTimer = null;
  const applyRenderScale = () => {
    webview.style.width = `${renderScale * 100}%`;
    webview.style.height = `${renderScale * 100}%`;
    webview.style.transform = renderScale === 1 ? '' : `scale(${1 / renderScale})`;
  };
  const applyContentScale = () => {
    applyRenderScale();
    if (!domReady) return;
    try {
      webview.setZoomFactor(contentScale * renderScale);
    } catch {
      /* not attached yet */
    }
  };
  applyRenderScale();
  webview.addEventListener('dom-ready', () => {
    domReady = true;
    updateNav();
    applyContentScale();
  });

  return {
    el: chrome.root,
    focus: () => {
      try {
        address.focus();
      } catch {
        /* ignore */
      }
    },
    syncTitles: () => {
      chrome.titleEl.textContent = meta.callSign;
      chrome.subEl.textContent = meta.title || hostOf(url) || 'Browser';
    },
    navigate: (next) => go(next),
    // For agent tools: run code in the page, wait for loads, history, capture.
    exec: (code) => webview.executeJavaScript(code, true),
    waitForLoad,
    history: (step) => {
      if (step === 'back') webview.goBack?.();
      else if (step === 'forward') webview.goForward?.();
      else webview.reload?.();
    },
    webContentsId: () => (domReady ? webview.getWebContentsId() : null),
    setContentScale: (scale) => {
      if (Math.abs(scale - contentScale) < 0.01) return;
      contentScale = scale;
      applyContentScale();
    },
    setZoom: (scale) => {
      const next = Math.min(MAX_RENDER, Math.max(1, Number(scale) || 1));
      if (Math.abs(next - renderScale) < 0.02) return;
      // Re-render once the zoom gesture pauses, not on every frame.
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(() => {
        renderScale = next;
        applyContentScale();
      }, 140);
    },
    resize: () => {},
    destroy: () => {
      try {
        webview.remove();
      } catch {
        /* ignore */
      }
    },
  };
}

registerNodeType('browser', createBrowserView);

export function openBrowser(canvas, url, options = {}) {
  const target = normalizeUrl(url);
  const label = options.title || hostOf(target) || 'Browser';
  return canvas.createNode(
    {
      kind: 'browser',
      w: options.w ?? 820,
      h: options.h ?? 560,
      callSign: label,
      title: label,
      // ownerId: the agent window that opened it (agent tools only).
      payload: options.ownerId ? { url: target, ownerId: options.ownerId } : { url: target },
    },
    // An agent opening a browser must not steal the user's keyboard focus.
    { focus: options.focus !== false }
  );
}
