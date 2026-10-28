import { Surface, hex, mix, shade, rng, fbm1, fbm2, noise1, noise2, hash, ramp, pine, water, glitter, makeStars, drawStars } from './pixel.js';

/** Moonlit Lake: mountains, a pine shore, a shimmering moon path, fireflies. */

const C = {
  sky: ['#060a1a', '#0a1029', '#0e1636', '#131d45', '#1a2652', '#22305d', '#2c3b66'].map(hex),
  star: hex('#dfe6ff'),
  moon: hex('#f4efdc'),
  moonShade: hex('#d8cfb2'),
  moonGlow: hex('#3b4b86'),
  farA: hex('#19234b'),
  farB: hex('#27356a'),
  mist: hex('#5a6da8'),
  snow: hex('#7f8cc0'),
  snowLit: hex('#bcc6ec'),
  hill: hex('#10183a'),
  hillLit: hex('#1d2a58'),
  pine: hex('#080d22'),
  pineLit: hex('#16224a'),
  shore: hex('#0a1027'),
  water: hex('#081028'),
  waterNear: hex('#050a1b'),
  ripple: hex('#8ea6dd'),
  glitter: hex('#fff6d8'),
  reed: hex('#04060f'),
  reedLit: hex('#141d3c'),
  fly: hex('#d9f58a'),
  boat: hex('#05070f'),
  boatLit: hex('#2a3460'),
};

export default {
  id: 'lake',
  label: 'Moonlit lake',
  base: '#060a1a',

  build(w, h) {
    const u = h / 360;
    const rand = rng(11);
    const s = new Surface(w, h);
    const hy = Math.round(h * 0.63);
    const moon = { x: Math.round(w * 0.7), y: Math.round(h * 0.19), r: Math.max(8, Math.round(19 * u)) };

    s.vgrad(0, hy, C.sky);
    s.halo(moon.x, moon.y, moon.r * 5.5, C.moonGlow, 0.55);

    // Moon with soft craters.
    s.disc(moon.x, moon.y, moon.r, C.moon);
    for (let i = 0; i < 9; i += 1) {
      const a = rand() * 6.283;
      const d = Math.sqrt(rand()) * moon.r * 0.7;
      s.disc(moon.x + Math.cos(a) * d, moon.y + Math.sin(a) * d, 0.8 + rand() * moon.r * 0.13, C.moonShade);
    }
    // A thin shadow on the left limb.
    for (let y = -moon.r; y <= moon.r; y += 1) {
      const half = Math.sqrt(Math.max(0, moon.r * moon.r - y * y));
      s.set(Math.round(moon.x - half), moon.y + y, C.moonShade);
    }

    // Two mountain ranges: sharp ridged peaks, faces lit from the moon side,
    // snow above a ragged snow line, haze towards the water.
    const range = (seed, base, height, scale) => (x) => {
      const r = 1 - Math.abs(fbm1(x / (scale * u), seed, 5));
      return hy - base * u - (r * r * 0.8 + (fbm1(x / (scale * 0.4 * u), seed + 50, 3) * 0.5 + 0.5) * 0.2) * height * u;
    };
    const paintRange = (top, dark, lit, snowDark, snowLit, snowTop, hazeFrom) => {
      s.ridge(
        top,
        (x, y, depth) => {
          // Near the crest, light follows the silhouette; lower down it follows
          // the slopes of a rough terrain field, so faces break into ridges
          // and gullies instead of running straight down.
          const crest = (top(x + 4) - top(x - 4)) * Math.exp(-depth / (10 * u));
          const fx = x / (13 * u);
          const fy = y / (9 * u) + x / (26 * u);
          const terrain = (fbm2(fx + 0.15, fy, 31, 3) - fbm2(fx - 0.15, fy, 31, 3)) * 26;
          const isLit = crest + terrain + (noise2(x / (2.5 * u), y / (2.5 * u), 4) - 0.5) * 1.6 > 0.35;
          const snowLine = hy - snowTop * u + noise1(x / (14 * u), 8) * 9 * u;
          if (y < snowLine) return isLit ? snowLit : snowDark;
          const haze = Math.min(1, Math.max(0, (y - (hy - hazeFrom * u)) / (hazeFrom * u)));
          const body = isLit ? lit : dark;
          return ramp([body, mix(body, C.sky[6], 0.6)], haze, x, y);
        },
        hy
      );
    };
    const far = range(3, 40, 96, 170);
    paintRange(far, C.farA, C.farB, C.snow, C.snowLit, 104, 70);
    const near = range(21, 12, 50, 110);
    paintRange(near, C.hill, C.hillLit, mix(C.snow, C.hill, 0.5), mix(C.snowLit, C.hill, 0.4), 50, 40);

    // Mist lying on the water line.
    for (let y = hy - Math.round(14 * u); y < hy; y += 1) {
      const k = 1 - (hy - y) / (14 * u);
      for (let x = 0; x < w; x += 1) {
        const n = noise2(x / (40 * u), y / (6 * u), 12);
        s.blend(x, y, C.mist, k * k * 0.32 * (0.5 + n));
      }
    }

    // A pine shore.
    for (let x = -4; x < w + 4; x += 2 + Math.floor(rand() * 4)) {
      const local = noise1(x / (40 * u), 5) * 0.5 + 0.5;
      if (local < 0.3) continue;
      const th = Math.round((7 + rand() * 13 + local * 8) * u);
      pine(s, x, hy, th, C.pine, C.pineLit);
    }
    s.rect(0, hy - 1, w, 1, C.shore);

    // Stars only where the sky shows.
    const stars = makeStars(rand, w, hy - 40 * u, Math.round(260 * (w / 640))).filter(
      (star) => star.y < far(star.x) - 3 && Math.hypot(star.x - moon.x, star.y - moon.y) > moon.r * 2.4
    );

    // Reeds in the near corners.
    const reeds = [];
    for (let i = 0; i < 70; i += 1) {
      const left = i < 40;
      const x = left ? Math.floor(Math.pow(rand(), 1.6) * w * 0.22) : w - 1 - Math.floor(Math.pow(rand(), 1.6) * w * 0.16);
      reeds.push({ x, len: Math.round((10 + rand() * 30) * u), lean: (rand() - 0.5) * 0.5, phase: rand() * 6.28, head: rand() < 0.22 });
    }

    const flies = Array.from({ length: 16 }, (_, i) => ({
      x: i < 9 ? rand() * w * 0.3 : w * 0.7 + rand() * w * 0.3,
      y: hy - 6 * u - rand() * 22 * u,
      seed: i * 13 + 3,
      phase: rand() * 6.28,
    }));

    return { s, w, h, u, hy, moon, stars, reeds, flies };
  },

  frame(st, out, t) {
    const { w, h, u, hy, moon } = st;
    out.copyFrom(st.s);
    drawStars(out, st.stars, t, C.star);

    // A shooting star now and then.
    const cycle = 17;
    const k = (t % cycle) / 0.9;
    if (k < 1) {
      const n = Math.floor(t / cycle);
      const x0 = w * (0.1 + hash(n, 1) * 0.5);
      const y0 = h * (0.05 + hash(n, 2) * 0.15);
      const len = 46 * u;
      for (let i = 0; i < 14 * u; i += 1) {
        const p = k * len - i;
        if (p < 0) break;
        out.light(x0 + p, y0 + p * 0.35, C.star, (1 - i / (14 * u)) * (1 - k * 0.6));
      }
    }

    water(out, out, hy, t, { tint: C.water, tintNear: C.waterNear, ripple: C.ripple, amp: 1.6 * u, deep: 0.5, deepNear: 0.74 });
    glitter(out, hy, moon.x, 26 * u, t, C.glitter, 0.5);

    // A rowboat drifting at anchor.
    const bx = Math.round(w * 0.36 + Math.sin(t * 0.13) * 4 * u);
    const by = Math.round(hy + (h - hy) * 0.42 + Math.sin(t * 1.1) * 0.8);
    const bl = Math.round(26 * u);
    for (let i = 0; i < bl; i += 1) {
      const e = Math.abs(i - bl / 2) / (bl / 2);
      const top = Math.round(by - 2 * u + e * e * 2 * u);
      for (let y = top; y < by + Math.round(3 * u * (1 - e * 0.6)); y += 1) out.set(bx + i, y, y === top ? C.boatLit : C.boat);
    }
    for (let i = 2; i < bl - 2; i += 1) out.set(bx + i, by + Math.round(3 * u), shade(C.waterNear, 0.7));

    // Reeds sway.
    for (const reed of st.reeds) {
      const sway = Math.sin(t * 0.9 + reed.phase) * 0.12 + reed.lean;
      for (let j = 0; j < reed.len; j += 1) {
        const f = j / reed.len;
        const x = Math.round(reed.x + sway * j * f);
        out.set(x, h - 1 - j, f > 0.85 ? C.reedLit : C.reed);
      }
      if (reed.head) {
        const x = Math.round(reed.x + sway * reed.len);
        for (let j = 0; j < Math.round(5 * u); j += 1) out.set(x, h - reed.len - j, C.reedLit);
      }
    }

    // Fireflies blink and wander.
    for (const fly of st.flies) {
      const x = fly.x + noise1(t * 0.35, fly.seed) * 16 * u;
      const y = fly.y + noise1(t * 0.3, fly.seed + 7) * 6 * u;
      const on = Math.max(0, Math.sin(t * 1.3 + fly.phase));
      if (on > 0.05) {
        out.light(x, y, C.fly, on);
        out.light(x - 1, y, C.fly, on * 0.25);
        out.light(x + 1, y, C.fly, on * 0.25);
        out.light(x, y - 1, C.fly, on * 0.25);
        out.light(x, y + 1, C.fly, on * 0.25);
      }
    }
  },
};
