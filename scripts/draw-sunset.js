// Draws the "Sunset lake" background: original pixel art, generated from code
// (no dependencies). Usage: node scripts/draw-sunset.js assets/backgrounds/sunset.png
const fs = require('fs');
const zlib = require('zlib');

const W = 384;
const H = 216;
const px = new Uint8Array(W * H * 3);

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const set = (x, y, c) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
};
const get = (x, y) => {
  const i = (y * W + x) * 3;
  return [px[i], px[i + 1], px[i + 2]];
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// 4x4 Bayer matrix for ordered dithering between colour bands.
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

const HORIZON = 132;

/* ---- sky: banded, dithered ---- */
const SKY = ['#1d1036', '#2e1647', '#4a1d57', '#6e2660', '#9a3463', '#c84a5c', '#e2674a', '#f08a45', '#f6ad55', '#f9c96b'];
const sky = SKY.map(hex);
for (let y = 0; y < HORIZON; y += 1) {
  const t = (y / HORIZON) ** 1.15 * (sky.length - 1);
  const band = Math.floor(t);
  const frac = t - band;
  for (let x = 0; x < W; x += 1) {
    const pick = frac > BAYER[y % 4][x % 4] ? Math.min(band + 1, sky.length - 1) : band;
    set(x, y, sky[pick]);
  }
}

/* ---- stars in the dark top ---- */
for (let i = 0; i < 70; i += 1) {
  const x = Math.floor(rand() * W);
  const y = Math.floor(rand() * 46);
  const bright = rand() > 0.8;
  set(x, y, bright ? hex('#fff4e0') : mix(get(x, y), hex('#f2d8ff'), 0.55));
}

/* ---- sun: banded with retro gaps on its lower half ---- */
const SUN = { x: 192, y: 112, r: 30 };
const sunTop = hex('#fff0a8');
const sunBottom = hex('#ff8a4c');
for (let y = SUN.y - SUN.r; y <= SUN.y + SUN.r; y += 1) {
  for (let x = SUN.x - SUN.r; x <= SUN.x + SUN.r; x += 1) {
    const dx = x - SUN.x;
    const dy = y - SUN.y;
    if (dx * dx + dy * dy > SUN.r * SUN.r) continue;
    const rel = y - SUN.y;
    // Gaps grow wider towards the bottom.
    if (rel > 4) {
      const period = 7;
      const gap = 1 + Math.floor((rel - 4) / 9);
      if ((rel - 4) % period < gap) continue;
    }
    set(x, y, mix(sunTop, sunBottom, (y - (SUN.y - SUN.r)) / (2 * SUN.r)));
  }
}
// Soft glow ring.
for (let y = SUN.y - SUN.r - 10; y <= SUN.y + SUN.r; y += 1) {
  for (let x = SUN.x - SUN.r - 10; x <= SUN.x + SUN.r + 10; x += 1) {
    const d = Math.hypot(x - SUN.x, y - SUN.y);
    if (d > SUN.r && d < SUN.r + 9 && y < HORIZON) {
      const t = 1 - (d - SUN.r) / 9;
      if (t * 0.9 > BAYER[y % 4][x % 4]) set(x, y, mix(get(x, y), hex('#ffc070'), 0.35));
    }
  }
}

/* ---- clouds: long pixel strips ---- */
const cloudDark = hex('#a8406a');
const cloudLight = hex('#f0907a');
const clouds = [
  [30, 52, 90], [210, 40, 120], [120, 70, 70], [280, 78, 80], [10, 92, 60], [300, 100, 70], [150, 30, 50],
];
for (const [cx, cy, len] of clouds) {
  for (let row = 0; row < 4; row += 1) {
    const inset = Math.abs(row - 1.5) * 9 + rand() * 6;
    for (let x = Math.round(cx + inset); x < cx + len - inset; x += 1) {
      set(x, cy + row, row === 0 ? cloudLight : mix(cloudDark, cloudLight, 0.25 - row * 0.06));
    }
  }
}

/* ---- mountains: two silhouettes ---- */
function ridge(base, height, color, rough, step) {
  let h = height * 0.5;
  for (let x = 0; x < W; x += 1) {
    if (x % step === 0) h = Math.max(4, Math.min(height, h + (rand() - 0.5) * rough));
    const peak = Math.round(base - h - Math.sin(x / 37) * height * 0.25);
    for (let y = peak; y < HORIZON; y += 1) set(x, y, color);
  }
}
ridge(HORIZON - 4, 34, hex('#5c2a55'), 10, 3);
ridge(HORIZON, 20, hex('#3b1a40'), 9, 2);

/* ---- pines along both shores ---- */
const pine = hex('#160b1e');
function tree(x, groundY, height) {
  for (let y = 0; y < height; y += 1) {
    const half = Math.max(0, Math.round(((y + 1) / height) * (height * 0.28) - ((y % 5) === 0 ? 1 : 0)));
    for (let dx = -half; dx <= half; dx += 1) set(x + dx, groundY - height + y, pine);
  }
  for (let y = 0; y < 4; y += 1) set(x, groundY + y, pine);
}
const shoreLeft = (x) => HORIZON + 14 - Math.round(x * 0.12);
const shoreRight = (x) => HORIZON + 14 - Math.round((W - x) * 0.12);
// Shores slope down into the water with an uneven, pixelly edge.
const edge = (d) => HORIZON + 22 - Math.round(d * 0.14) + (Math.floor(d / 6) % 3 === 0 ? 1 : 0);
for (let x = 0; x < 120; x += 1) for (let y = shoreLeft(x); y < edge(x); y += 1) set(x, y, pine);
for (let x = W - 120; x < W; x += 1) for (let y = shoreRight(x); y < edge(W - 1 - x); y += 1) set(x, y, pine);
for (let x = 2; x < 108; x += 7 + Math.floor(rand() * 5)) tree(x, shoreLeft(x) + 2, 22 + Math.floor(rand() * 40));
for (let x = W - 4; x > W - 108; x -= 7 + Math.floor(rand() * 5)) tree(x, shoreRight(x) + 2, 22 + Math.floor(rand() * 40));

/* ---- lake: darker mirrored sky with ripples ---- */
for (let y = HORIZON; y < H; y += 1) {
  const mirror = HORIZON - (y - HORIZON) * 1.4 - 2;
  for (let x = 0; x < W; x += 1) {
    const existing = get(x, y);
    if (existing[0] === pine[0] && existing[1] === pine[1] && existing[2] === pine[2]) continue;
    const my = Math.max(0, Math.min(HORIZON - 1, Math.round(mirror)));
    let c = mix(get(x, my), hex('#1a0e2a'), 0.35 + ((y - HORIZON) / (H - HORIZON)) * 0.35);
    if ((y + Math.floor(x / 23)) % 6 === 0) c = mix(c, hex('#ffffff'), 0.06);
    set(x, y, c);
  }
}
// Broken reflection of the sun.
for (let y = HORIZON + 1; y < H - 6; y += 2) {
  const spread = 26 - (y - HORIZON) * 0.12 + rand() * 6;
  const start = Math.round(SUN.x - spread + rand() * 8);
  const end = Math.round(SUN.x + spread - rand() * 8);
  for (let x = start; x < end; x += 1) {
    if (rand() < 0.18) continue;
    set(x, y, mix(hex('#ffd890'), hex('#ff8a4c'), (y - HORIZON) / (H - HORIZON)));
  }
}

/* ---- fireflies over the shores ---- */
for (let i = 0; i < 26; i += 1) {
  const left = rand() < 0.5;
  const x = left ? Math.floor(rand() * 120) : W - 1 - Math.floor(rand() * 120);
  const y = HORIZON - 30 + Math.floor(rand() * 60);
  set(x, y, hex('#d9ff8a'));
  if (rand() > 0.5) set(x + 1, y, hex('#9fdc5a'));
}

/* ---- PNG encode ---- */
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(process.argv[2], png);
console.log('wrote', process.argv[2], png.length, 'bytes');
