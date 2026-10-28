import { findScene } from './index.js';
import { Surface } from './pixel.js';

/**
 * Draws the animated background off the main thread, into a canvas the page
 * handed over (OffscreenCanvas). The page sends:
 *   { type: 'init', canvas }            once
 *   { type: 'scene', id, w, h }         pick a scene at a pixel size
 *   { type: 'play', on }                animate, or hold the current frame
 */

const FPS = 12;

let canvas = null;
let ctx = null;
let scene = null;
let state = null;
let out = null;
let image = null;
let timer = 0;
let playing = false;
const started = performance.now();

const now = () => (performance.now() - started) / 1000;

function draw() {
  if (!scene || !state) return;
  scene.frame(state, out, now());
  ctx.putImageData(image, 0, 0);
}

function schedule() {
  clearInterval(timer);
  timer = 0;
  if (playing && scene) timer = setInterval(draw, 1000 / FPS);
}

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init') {
    canvas = message.canvas;
    ctx = canvas.getContext('2d', { alpha: false });
    return;
  }
  if (message.type === 'scene') {
    scene = findScene(message.id);
    if (!scene || !ctx) return;
    canvas.width = message.w;
    canvas.height = message.h;
    state = scene.build(message.w, message.h);
    out = new Surface(message.w, message.h);
    image = new ImageData(new Uint8ClampedArray(out.px.buffer), message.w, message.h);
    draw();
    schedule();
    self.postMessage({ type: 'ready', id: message.id });
    return;
  }
  if (message.type === 'play') {
    playing = Boolean(message.on);
    schedule();
  }
};
