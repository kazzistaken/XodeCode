/**
 * Draws the XodeCode icon: four agents linked to the Director, in white
 * pixels on a dithered dusk plate (the same look as the canvas scenes).
 *
 * Writes assets/xodecode.ico (16–256 px) and assets/xodecode.png (512 px).
 * Every size is drawn on its own whole-pixel grid instead of being scaled
 * down from a big one, so the small sizes stay sharp. No dependencies.
 *
 *   node scripts/make-icon.mjs
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// X = white, o = link (white at LINK strength), . = plate.
// The same grid is drawn as SVG for the app's own mark (icons.js: xodecode).
export const MARK = [
  'XX.......XX',
  'XX.......XX',
  '..o.....o..',
  '...o...o...',
  '....XXX....',
  '....X.X....',
  '....XXX....',
  '...o...o...',
  '..o.....o..',
  'XX.......XX',
  'XX.......XX',
];
const LINK = 0.55;

const TOP = [0x30, 0x33, 0x78];
const BOTTOM = [0x0c, 0x0d, 0x22];
const WHITE = [0xf5, 0xf6, 0xf7];
const STEPS = 5;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function insideRounded(x, y, x0, size, radius) {
  const cx = Math.min(Math.max(x, x0 + radius), x0 + size - radius);
  const cy = Math.min(Math.max(y, x0 + radius), x0 + size - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

/** RGBA pixels for one square icon size. */
function drawIcon(size) {
  const n = MARK.length;
  let cell = Math.max(1, Math.round((size * 0.56) / n));
  if (n * cell > size * 0.72) cell -= 1;
  const origin = Math.round((size - n * cell) / 2);

  const inset = size >= 32 ? size * 0.035 : 0;
  const plate = size - inset * 2;
  const radius = plate * 0.24;
  const dither = size >= 48;

  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 4×4 samples for a smooth plate edge.
      let cover = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          if (insideRounded(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4, inset, plate, radius)) cover++;
        }
      }
      if (!cover) continue;

      const gx = Math.floor((x - origin) / cell);
      const gy = Math.floor((y - origin) / cell);

      // Vertical dusk ramp, dithered in mark-sized blocks.
      let t = Math.min(1, Math.max(0, (y - inset) / plate));
      if (dither) {
        const q = t * STEPS;
        const threshold = (BAYER[((gy & 3) << 2) | (gx & 3)] + 0.5) / 16;
        t = (Math.floor(q) + (q - Math.floor(q) > threshold ? 1 : 0)) / STEPS;
      }
      let color = mix(TOP, BOTTOM, t);

      const ch = gx >= 0 && gy >= 0 ? MARK[gy]?.[gx] : undefined;
      if (ch === 'X') color = WHITE;
      else if (ch === 'o') color = mix(color, WHITE, LINK);

      out.set([...color.map(Math.round), Math.round((cover / 16) * 255)], (y * size + x) * 4);
    }
  }
  return out;
}

/* --------------------------------- PNG --------------------------------- */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * stride + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------- ICO --------------------------------- */

function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16;
    header[entry] = size >= 256 ? 0 : size;
    header[entry + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); // planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

/* -------------------------------- write -------------------------------- */

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const ico = encodeIco(icoSizes.map((size) => ({ size, png: encodePng(size, drawIcon(size)) })));
writeFileSync(path.join(assets, 'xodecode.ico'), ico);
writeFileSync(path.join(assets, 'xodecode.png'), encodePng(512, drawIcon(512)));
console.log(`Wrote assets/xodecode.ico (${icoSizes.join(', ')} px) and assets/xodecode.png (512 px)`);
