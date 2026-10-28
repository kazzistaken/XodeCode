import { findScene } from './index.js';
import { Surface } from './pixel.js';

/** At least this many scene pixels from top to bottom of the screen (each one 2-4 screen pixels). */
const TARGET_ROWS = 450;

/**
 * The animated background behind the canvas. The scene is drawn in a worker
 * at a size where every scene pixel covers a whole number of screen pixels,
 * so the pixel art stays perfectly crisp, then scaled up without smoothing.
 */
export function createSceneView(host) {
  let canvas = null;
  let worker = null;
  let current = '';
  let size = '';
  let wantPlay = true;
  let ready = false;

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  function measure() {
    const dpr = window.devicePixelRatio || 1;
    const devW = Math.max(1, Math.round(host.clientWidth * dpr));
    const devH = Math.max(1, Math.round(host.clientHeight * dpr));
    const scale = Math.max(2, Math.floor(devH / TARGET_ROWS));
    const w = Math.ceil(devW / scale);
    const h = Math.ceil(devH / scale);
    return { w, h, cssW: (w * scale) / dpr, cssH: (h * scale) / dpr };
  }

  function ensure() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'scene-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.append(canvas);
    const offscreen = canvas.transferControlToOffscreen();
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
    worker.addEventListener('message', (event) => {
      if (event.data?.type === 'ready') {
        ready = true;
        canvas.classList.add('is-ready');
      }
    });
  }

  // Hold still while the camera moves (pan/zoom), so every frame goes to the
  // windows; the water picks up again the moment you stop.
  let cameraMoving = false;
  const viewport = host.closest('#viewport');
  if (viewport) {
    new MutationObserver(() => {
      const moving = viewport.classList.contains('is-moving');
      if (moving !== cameraMoving) {
        cameraMoving = moving;
        sync();
      }
    }).observe(viewport, { attributes: true, attributeFilter: ['class'] });
  }

  function playing() {
    return wantPlay && !cameraMoving && !document.hidden && !reduceMotion?.matches;
  }

  function sync() {
    worker?.postMessage({ type: 'play', on: Boolean(current) && playing() });
  }

  function layout(force = false) {
    if (!current) return;
    const m = measure();
    canvas.style.width = `${m.cssW}px`;
    canvas.style.height = `${m.cssH}px`;
    const key = `${current}:${m.w}x${m.h}`;
    if (!force && key === size) return;
    size = key;
    worker.postMessage({ type: 'scene', id: current, w: m.w, h: m.h });
    sync();
  }

  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => layout(), 150);
  }).observe(host);
  document.addEventListener('visibilitychange', sync);
  reduceMotion?.addEventListener?.('change', sync);

  return {
    show(id) {
      if (!findScene(id)) return;
      ensure();
      canvas.hidden = false;
      if (id !== current) {
        current = id;
        ready = false;
        canvas.classList.remove('is-ready');
      }
      layout();
      sync();
    },
    hide() {
      current = '';
      size = '';
      if (canvas) canvas.hidden = true;
      sync();
    },
    setPlaying(on) {
      wantPlay = Boolean(on);
      sync();
    },
    get ready() {
      return ready;
    },
  };
}

const thumbCache = new Map();

/**
 * A small preview of a scene for pickers: drawn once (and cached), and
 * animated while you point at it.
 */
export function sceneThumb(id, w = 320, h = 180) {
  const holder = document.createElement('span');
  holder.className = 'bg-card-thumb is-scene';
  const scene = findScene(id);
  if (!scene) return holder;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  holder.append(canvas);
  const ctx = canvas.getContext('2d');

  let cached = thumbCache.get(`${id}:${w}x${h}`);
  const paint = (t) => {
    scene.frame(cached.state, cached.out, t);
    ctx.putImageData(cached.image, 0, 0);
  };
  // Draw after the sheet has appeared, so opening Settings stays instant.
  setTimeout(() => {
    if (!cached) {
      const state = scene.build(w, h);
      const out = new Surface(w, h);
      cached = { state, out, image: new ImageData(new Uint8ClampedArray(out.px.buffer), w, h) };
      thumbCache.set(`${id}:${w}x${h}`, cached);
    }
    paint(2);
  }, 30);

  let timer = 0;
  let t = 2;
  holder.addEventListener('pointerenter', () => {
    if (!cached || timer) return;
    timer = setInterval(() => {
      if (!holder.isConnected) {
        clearInterval(timer);
        timer = 0;
        return;
      }
      paint((t += 1 / 12));
    }, 1000 / 12);
  });
  holder.addEventListener('pointerleave', () => {
    clearInterval(timer);
    timer = 0;
  });
  return holder;
}
