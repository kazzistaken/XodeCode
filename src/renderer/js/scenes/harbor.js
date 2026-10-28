import { Surface, hex, mix, shade, rng, fbm1, noise1, noise2, hash, ramp, water, makeStars, drawStars } from './pixel.js';

/**
 * Lantern Harbor: a fishing harbour just after sunset. Lanterns on the pier,
 * boats at their moorings, a lighthouse sweeping its beam, gulls going home.
 */

const C = {
  sky: ['#141331', '#1e1a42', '#2e2352', '#47295f', '#683466', '#924468', '#bf5a66', '#e07a63', '#f1a26a'].map(hex),
  star: hex('#ffe9d6'),
  cloudLit: hex('#f2a07a'),
  cloudMid: hex('#b85d6d'),
  cloudDark: hex('#5b2f5c'),
  coastFar: hex('#3d2753'),
  coastNear: hex('#2a1b3e'),
  town: hex('#ffcf8a'),
  rock: hex('#170f22'),
  rockLit: hex('#3a2340'),
  towerLit: hex('#efe3d6'),
  tower: hex('#b9a8a6'),
  band: hex('#b8424a'),
  bandDark: hex('#7c2c3b'),
  lamp: hex('#fff1c2'),
  beam: hex('#ffe2a6'),
  water: hex('#2a1d40'),
  waterNear: hex('#120d22'),
  ripple: hex('#f5b282'),
  pier: hex('#1d1220'),
  pierLit: hex('#4a2d33'),
  post: hex('#120a14'),
  lantern: hex('#ffc86b'),
  lanternGlow: hex('#a8562a'),
  hull: hex('#160e1d'),
  hullLit: hex('#5a3443'),
  sail: hex('#d9c3c0'),
  sailShade: hex('#9c8290'),
  mast: hex('#120a14'),
  gull: hex('#1b1222'),
};

export default {
  id: 'harbor',
  label: 'Lantern harbour',
  base: '#141331',

  build(w, h) {
    const u = h / 360;
    const rand = rng(5);
    const s = new Surface(w, h);
    const hy = Math.round(h * 0.6);

    s.vgrad(0, hy, C.sky);
    // The last of the sun, just below the horizon.
    const sunX = Math.round(w * 0.38);
    s.halo(sunX, hy + 6 * u, 150 * u, hex('#6b2a2a'), 0.75);

    // Coast with a little town on it.
    const coast = (x) => hy - 4 * u - (fbm1(x / (80 * u), 2, 4) * 0.5 + 0.5) * 22 * u;
    s.ridge(coast, (x, y) => ramp([C.coastFar, mix(C.coastFar, C.sky[7], 0.35)], (y - coast(x)) / (24 * u), x, y), hy);
    const near = (x) => hy - 1 - Math.max(0, fbm1(x / (50 * u), 13, 3) * 18 * u);
    s.ridge(near, () => C.coastNear, hy);
    const lights = [];
    for (let i = 0; i < 60 * (w / 640); i += 1) {
      const x = Math.floor(rand() * w * 0.75);
      const y = Math.round(coast(x) + 2 + rand() * (hy - coast(x) - 3));
      if (noise1(x / (30 * u), 4) > -0.1) lights.push({ x, y, phase: rand() * 6.28, b: 0.4 + rand() * 0.6 });
    }

    // Lighthouse on its rocks, right side.
    const lx = Math.round(w * 0.84);
    const rockTop = (x) => hy - (1 - Math.min(1, Math.abs(x - lx) / (46 * u))) * 22 * u - noise1(x / (4 * u), 6) * 3 * u;
    s.ridge(
      rockTop,
      (x, y) => (noise2(x / (3 * u), y / (3 * u), 2) > 0.62 || x < lx - 18 * u + (y - hy) * 0.5 ? C.rockLit : C.rock),
      hy
    );
    const towerH = Math.round(70 * u);
    const base = Math.round(hy - 18 * u);
    for (let j = 0; j < towerH; j += 1) {
      const y = base - j;
      const half = Math.round((7 - (j / towerH) * 2.5) * u);
      const stripe = Math.floor((j / towerH) * 5) % 2 === 1;
      for (let i = -half; i <= half; i += 1) {
        const lit = i < half * 0.25;
        const c = stripe ? (lit ? C.band : C.bandDark) : lit ? C.towerLit : C.tower;
        s.set(lx + i, y, c);
      }
    }
    const lampY = base - towerH - Math.round(5 * u);
    s.rect(lx - 6 * u, base - towerH - 1, 12 * u + 1, 2, C.mast);
    s.rect(lx - 4 * u, lampY, 8 * u + 1, 5 * u, C.lamp);
    for (let i = -4 * u; i <= 4 * u; i += 2) s.set(lx + i, lampY + 2 * u, shade(C.lamp, 0.75));
    s.poly(
      [
        [lx - 5 * u, lampY],
        [lx, lampY - 5 * u],
        [lx + 5 * u + 1, lampY],
      ],
      C.mast
    );

    // A wooden pier coming in from the left, with lantern posts.
    const pierY = Math.round(hy + (h - hy) * 0.5);
    const pierEnd = Math.round(w * 0.4);
    s.rect(0, pierY, pierEnd, Math.round(3 * u), C.pier);
    s.rect(0, pierY, pierEnd, 1, C.pierLit);
    const posts = [];
    for (let x = 4; x < pierEnd; x += Math.round(18 * u)) {
      s.rect(x, pierY + 3 * u, Math.max(1, Math.round(2 * u)), Math.round(11 * u), C.post);
      posts.push(x);
    }
    const lanterns = [];
    for (let i = 1; i < posts.length; i += 2) {
      const x = posts[i];
      s.rect(x, pierY - 18 * u, Math.max(1, Math.round(u)), 18 * u, C.post);
      lanterns.push({ x, y: Math.round(pierY - 20 * u), phase: rand() * 6.28 });
    }

    // Boats on the water (bobbing, so drawn each frame).
    const boats = [
      { x: w * 0.53, y: hy + (h - hy) * 0.22, len: 30, mast: 34, sail: true, phase: 0 },
      { x: w * 0.66, y: hy + (h - hy) * 0.36, len: 38, mast: 44, sail: true, phase: 1.7 },
      { x: w * 0.47, y: hy + (h - hy) * 0.72, len: 24, mast: 0, sail: false, phase: 3.1 },
    ];

    const stars = makeStars(rand, w, hy * 0.35, Math.round(80 * (w / 640)));
    const clouds = makeClouds(w, h, u, hy);

    return { s, w, h, u, hy, lx, lampY, lights, lanterns, boats, stars, clouds, pierY };
  },

  frame(st, out, t) {
    const { w, h, u, hy } = st;
    out.copyFrom(st.s);
    drawStars(out, st.stars, t, C.star);

    // Clouds drift slowly to the left.
    const shift = t * 1.6 * u;
    for (const cloud of st.clouds) {
      const cx = ((((cloud.x - shift) % (w + 160 * u)) + w + 160 * u) % (w + 160 * u)) - 80 * u;
      drawCloud(out, cloud, Math.round(cx));
    }

    // Town lights twinkle.
    for (const light of st.lights) {
      out.light(light.x, light.y, C.town, light.b * (0.6 + 0.4 * Math.sin(t * 1.5 + light.phase)));
    }

    // Lighthouse beam sweeping.
    // Mostly out to sea (left), swinging a little up and down.
    const angle = Math.PI + Math.sin(t * 0.45) * 0.42 - 0.08;
    const lampX = st.lx;
    const lampY = st.lampY + 2 * u;
    const reach = w * 0.9;
    for (let r = 6 * u; r < reach; r += 1) {
      const spread = 0.035 + r / reach / 30;
      const fade = (1 - r / reach) * (1 - r / reach) * 0.42;
      for (let a = -spread; a <= spread; a += 0.8 / r) {
        const x = lampX + Math.cos(angle + a) * r;
        const y = lampY + Math.sin(angle + a) * r * 0.45;
        if (y < hy) out.light(x, y, C.beam, fade * (1 - Math.abs(a) / spread));
      }
    }
    out.halo(lampX, lampY, 16 * u, C.beam, 0.7);

    water(out, out, hy, t, { tint: C.water, tintNear: C.waterNear, ripple: C.ripple, amp: 1.8 * u, deep: 0.3, deepNear: 0.62, rippleStrength: 0.28 });

    // The pier stands in the water: put it (posts and lantern poles) back on
    // top of the reflection.
    const solid = new Set([C.pier, C.pierLit, C.post]);
    const y0 = Math.max(hy, Math.round(st.pierY - 22 * u));
    const y1 = Math.min(h, Math.round(st.pierY + 15 * u));
    for (let y = y0; y < y1; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const c = st.s.px[y * w + x];
        if (solid.has(c)) out.px[y * w + x] = c;
      }
    }

    // Lantern light and its long broken reflection.
    for (const lantern of st.lanterns) {
      const k = 0.85 + 0.15 * Math.sin(t * 7 + lantern.phase) * Math.sin(t * 3.1 + lantern.phase);
      out.halo(lantern.x, lantern.y, 16 * u, C.lanternGlow, 1.1 * k);
      out.rect(lantern.x - 1, lantern.y - 1, 3, 3, C.lantern);
      for (let y = st.pierY + Math.round(4 * u); y < h; y += 1) {
        const dy = (y - st.pierY) / (h - st.pierY);
        const wob = Math.round(Math.sin(y * 0.8 + t * 3) * (1 + dy * 2));
        if (hash(y, lantern.x, Math.floor(t * 6)) < 0.55 - dy * 0.35) {
          out.light(lantern.x + wob, y, C.lantern, 0.8 * k * (1 - dy * 0.7));
          out.light(lantern.x + wob + 1, y, C.lantern, 0.45 * k * (1 - dy * 0.7));
          out.light(lantern.x + wob - 1, y, C.lantern, 0.25 * k * (1 - dy));
        }
      }
    }

    for (const boat of st.boats) drawBoat(out, boat, t, u);

    // Gulls heading home every so often.
    const cycle = 26;
    const p = (t % cycle) / 12;
    if (p < 1) {
      const n = Math.floor(t / cycle);
      for (let g = 0; g < 3; g += 1) {
        const gx = w * (1.05 - p * 1.2) + g * 14 * u;
        const gy = hy * (0.32 + hash(n, g) * 0.25) + g * 5 * u + Math.sin(t * 2 + g) * 2 * u;
        drawGull(out, gx, gy, t * 6 + g, u);
      }
    }
  },
};

function makeClouds(w, h, u, hy) {
  const rand = rng(77);
  const clouds = [];
  for (let i = 0; i < 7; i += 1) {
    const cw = Math.round((70 + rand() * 130) * u);
    const ch = Math.round((9 + rand() * 12) * u);
    const y = Math.round(hy * (0.28 + rand() * 0.5));
    const cells = [];
    for (let j = 0; j < ch; j += 1) {
      for (let i2 = 0; i2 < cw; i2 += 1) {
        const ex = Math.abs(i2 - cw / 2) / (cw / 2);
        // Puffy top, flat base; lit along the underside by the low sun.
        const top = (1 - ex * ex) * ch * (0.45 + (noise1(i2 / (7 * u), i) * 0.5 + 0.5) * 0.55);
        if (ch - j <= top) cells.push([i2, j, j >= ch - Math.max(2, Math.round(ch * 0.22)) ? 2 : j > ch * 0.5 ? 1 : 0]);
      }
    }
    clouds.push({ x: rand() * (w + 160 * u), y, cells, lowSky: Math.min(1, y / hy + 0.2) });
  }
  return clouds;
}

function drawCloud(out, cloud, x) {
  // Lower clouds catch more of the sunset.
  const lit = mix(C.cloudMid, C.cloudLit, cloud.lowSky);
  const shades = [C.cloudDark, mix(C.cloudDark, C.cloudMid, 0.6), lit];
  for (const [i, j, tone] of cloud.cells) out.blend(x + i, cloud.y + j, shades[tone], tone === 0 ? 0.7 : 0.9);
}

function drawBoat(out, boat, t, u) {
  const bob = Math.round(Math.sin(t * 1.2 + boat.phase) * 0.9 * u);
  const roll = Math.sin(t * 0.9 + boat.phase) * 0.06;
  const len = Math.round(boat.len * u);
  const x0 = Math.round(boat.x - len / 2);
  const y0 = Math.round(boat.y) + bob;
  const depth = Math.round(4 * u);
  for (let i = 0; i < len; i += 1) {
    const e = Math.abs(i - len / 2) / (len / 2);
    const top = y0 - Math.round(e * e * 2 * u + (i - len / 2) * roll);
    const bottom = y0 + Math.round(depth * (1 - e * e * 0.7));
    for (let y = top; y < bottom; y += 1) out.set(x0 + i, y, y === top ? C.hullLit : C.hull);
  }
  // A dark waterline under the hull.
  for (let i = 1; i < len - 1; i += 1) out.blend(x0 + i, y0 + depth, C.waterNear, 0.7);
  if (!boat.mast) {
    out.rect(x0 + Math.round(len * 0.55), y0 - Math.round(5 * u), Math.round(6 * u), Math.round(4 * u), C.hullLit);
    return;
  }
  const mx = x0 + Math.round(len * 0.45);
  const mh = Math.round(boat.mast * u);
  const lean = roll * 30;
  for (let j = 0; j < mh; j += 1) out.set(mx + Math.round((lean * j) / mh), y0 - 2 - j, C.mast);
  if (boat.sail) {
    // A furled sail along the boom plus a small jib.
    for (let j = 0; j < mh * 0.8; j += 1) {
      const half = Math.round((1 - j / (mh * 0.8)) * len * 0.32);
      for (let i = 1; i <= half; i += 1) {
        out.set(mx + Math.round((lean * j) / mh) + i, y0 - 4 - j, i < half * 0.4 ? C.sail : C.sailShade);
      }
    }
  }
}

function drawGull(out, x, y, phase, u) {
  const up = Math.sin(phase) > 0;
  const span = Math.max(2, Math.round(4 * u));
  out.set(x, y, C.gull);
  for (let i = 1; i <= span; i += 1) {
    const dy = up ? -Math.round(i * 0.6) : Math.round(i * 0.2);
    out.set(x - i, y + dy, C.gull);
    out.set(x + i, y + dy, C.gull);
  }
}
