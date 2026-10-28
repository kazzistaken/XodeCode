// Renders the animated backgrounds to PNG frames for review, without the app.
// Usage: node scripts/render-scenes.mjs <outDir> [scene,scene] [WxH] [scale] [t,t,...]
// e.g.   node scripts/render-scenes.mjs out harbor,lake 640x360 2 0,1.5
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { SCENES } from '../src/renderer/js/scenes/index.js';
import { Surface } from '../src/renderer/js/scenes/pixel.js';

const [outDir = 'scene-frames', only = '', size = '640x360', scaleArg = '2', times = '0'] = process.argv.slice(2);
const [W, H] = size.split('x').map(Number);
const scale = Number(scaleArg);
fs.mkdirSync(outDir, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

function png(surface, k) {
  const w = surface.w * k;
  const h = surface.h * k;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x += 1) {
      const c = surface.px[Math.floor(y / k) * surface.w + Math.floor(x / k)];
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = c & 255;
      raw[o + 1] = (c >> 8) & 255;
      raw[o + 2] = (c >> 16) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const scene of SCENES) {
  if (only && !only.split(',').includes(scene.id)) continue;
  const started = performance.now();
  const state = scene.build(W, H);
  const built = performance.now();
  const out = new Surface(W, H);
  let frameMs = 0;
  for (const t of times.split(',').map(Number)) {
    const f0 = performance.now();
    scene.frame(state, out, t);
    frameMs = Math.max(frameMs, performance.now() - f0);
    fs.writeFileSync(path.join(outDir, `${scene.id}-${t}.png`), png(out, scale));
  }
  console.log(`${scene.id}: build ${(built - started).toFixed(0)} ms, frame ${frameMs.toFixed(1)} ms`);
}
