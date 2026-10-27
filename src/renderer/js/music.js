import { el } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { buildNodeChrome } from './node-chrome.js';
import { registerNodeType } from './canvas.js';

/**
 * Music player node.
 *
 * Radio tab: internet radio powered by the free Radio Browser API (no key),
 * played through an <audio> element.
 * Spotify tab: the official Spotify embed player for any track/album/playlist
 * link you paste.
 */

const DEFAULT_SPOTIFY = 'playlist/37i9dQZF1DXcBWIGoYBM5M';

function spotifyEmbed(raw) {
  const text = String(raw || '').trim();
  const match =
    text.match(/open\.spotify\.com\/(?:embed\/)?(track|album|playlist|artist|episode|show)\/([\w]+)/i) ||
    text.match(/spotify:(track|album|playlist|artist|episode|show):([\w]+)/i);
  const path = match ? `${match[1].toLowerCase()}/${match[2]}` : DEFAULT_SPOTIFY;
  return `https://open.spotify.com/embed/${path}?utm_source=generator&theme=0`;
}

function createMusicView(meta, canvas) {
  if (!meta.payload || typeof meta.payload !== 'object') meta.payload = {};
  let mode = meta.payload.mode === 'spotify' ? 'spotify' : 'radio';

  const chrome = buildNodeChrome(meta, {
    brand: 'music',
    iconName: 'sound',
    actions: [
      { icon: 'x', title: 'Close player', danger: true, onClick: () => canvas.closeNode(meta.id) },
    ],
  });
  chrome.titleEl.textContent = meta.callSign;
  chrome.subEl.textContent = 'Music';

  const audio = el('audio', { class: 'music-audio', preload: 'none' });

  /* ------------------------------ radio ------------------------------ */

  const searchInput = el('input', {
    class: 'music-search',
    type: 'search',
    placeholder: 'Search radio stations…',
    spellcheck: 'false',
  });
  const results = el('div', { class: 'music-results' });
  const nowEl = el('span', { class: 'music-now', text: 'Nothing playing' });
  const playBtn = el('button', {
    class: 'music-btn',
    type: 'button',
    title: 'Play',
    'aria-label': 'Play',
    html: icon('play'),
  });
  const volume = el('input', {
    class: 'music-volume',
    type: 'range',
    min: '0',
    max: '1',
    step: '0.01',
    value: '0.8',
    'aria-label': 'Volume',
  });

  const radioPanel = el(
    'div',
    { class: 'music-panel' },
    el('div', { class: 'music-bar' }, searchInput),
    el('div', { class: 'music-now-row' }, playBtn, nowEl, volume),
    results
  );

  /* ----------------------------- spotify ----------------------------- */

  const spotifyInput = el('input', {
    class: 'music-search',
    type: 'text',
    placeholder: 'Paste a Spotify link…',
    spellcheck: 'false',
    value: meta.payload.spotifyUrl || '',
  });
  const frame = el('iframe', {
    class: 'music-frame',
    src: spotifyEmbed(meta.payload.spotifyUrl),
    allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
    frameborder: '0',
  });
  const spotifyPanel = el('div', { class: 'music-panel' }, el('div', { class: 'music-bar' }, spotifyInput), frame);

  /* ------------------------------ tabs ------------------------------- */

  const radioTab = el('button', { class: 'music-tab', type: 'button', text: 'Radio' });
  const spotifyTab = el('button', { class: 'music-tab', type: 'button', text: 'Spotify' });
  const tabs = el('div', { class: 'music-tabs' }, radioTab, spotifyTab);

  chrome.body.classList.add('music-body');
  chrome.body.append(tabs, radioPanel, spotifyPanel, audio);

  function applyMode() {
    radioTab.classList.toggle('is-active', mode === 'radio');
    spotifyTab.classList.toggle('is-active', mode === 'spotify');
    radioPanel.hidden = mode !== 'radio';
    spotifyPanel.hidden = mode !== 'spotify';
    meta.payload.mode = mode;
    store.save();
  }

  radioTab.addEventListener('click', () => {
    mode = 'radio';
    applyMode();
  });
  spotifyTab.addEventListener('click', () => {
    mode = 'spotify';
    applyMode();
  });

  /* ----------------------------- playback ---------------------------- */

  let current = null;
  audio.volume = Number(volume.value) || 0.8;

  function setPlaying(playing) {
    playBtn.innerHTML = icon(playing ? 'pause' : 'play');
    playBtn.title = playing ? 'Pause' : 'Play';
  }

  playBtn.addEventListener('click', () => {
    if (!current) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => setPlaying(false));
  volume.addEventListener('input', () => {
    audio.volume = Number(volume.value);
  });

  function playStation(station) {
    current = station;
    audio.src = station.url;
    audio.play().catch(() => {});
    nowEl.textContent = station.name || station.url;
    meta.payload.station = { name: station.name, url: station.url };
    store.save();
    for (const row of results.querySelectorAll('.music-station')) {
      row.classList.toggle('is-active', row.dataset.url === station.url);
    }
  }

  async function runSearch(query) {
    results.replaceChildren(el('div', { class: 'music-empty', text: 'Searching…' }));
    try {
      const data = await window.api.radio.search({ query, limit: 30 });
      const stations = (data && data.stations) || [];
      results.replaceChildren();
      if (!stations.length) {
        results.append(el('div', { class: 'music-empty', text: 'No stations found.' }));
        return;
      }
      for (const station of stations) {
        results.append(
          el(
            'button',
            {
              class: 'music-station',
              type: 'button',
              dataset: { url: station.url },
              onclick: () => playStation(station),
            },
            el('span', { class: 'music-station-name', text: station.name || station.url }),
            el('span', {
              class: 'music-station-meta',
              text: [station.country, station.codec, station.bitrate ? `${station.bitrate}k` : '']
                .filter(Boolean)
                .join(' · '),
            })
          )
        );
      }
    } catch {
      results.replaceChildren(
        el('div', { class: 'music-empty', text: 'Could not reach the radio service.' })
      );
    }
  }

  let searchTimer = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = searchInput.value.trim();
    searchTimer = setTimeout(() => runSearch(query), 350);
  });
  searchInput.addEventListener('pointerdown', (event) => event.stopPropagation());

  spotifyInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      const url = spotifyInput.value.trim();
      frame.src = spotifyEmbed(url);
      meta.payload.spotifyUrl = url;
      store.save();
    }
  });
  spotifyInput.addEventListener('pointerdown', (event) => event.stopPropagation());

  applyMode();
  runSearch('');

  if (meta.payload.station && meta.payload.station.url) {
    current = meta.payload.station;
    audio.src = current.url;
    nowEl.textContent = current.name || current.url;
  }
  setPlaying(false);

  return {
    el: chrome.root,
    focus: () => {
      try {
        searchInput.focus();
      } catch {
        /* ignore */
      }
    },
    syncTitles: () => {
      chrome.titleEl.textContent = meta.callSign;
      chrome.subEl.textContent = 'Music';
    },
    resize: () => {},
    destroy: () => {
      try {
        audio.pause();
        audio.src = '';
      } catch {
        /* ignore */
      }
      try {
        frame.src = 'about:blank';
      } catch {
        /* ignore */
      }
    },
  };
}

registerNodeType('music', createMusicView);

export function openMusic(canvas, options = {}) {
  const url = String(options.url || '').trim();
  const spotify = String(options.spotify || '').trim();
  return canvas.createNode({
    kind: 'music',
    w: options.w ?? 420,
    h: options.h ?? 520,
    callSign: options.title || 'Music',
    title: options.title || 'Music',
    payload: {
      mode: spotify ? 'spotify' : 'radio',
      spotifyUrl: spotify,
      station: url ? { name: url, url } : null,
    },
  });
}
