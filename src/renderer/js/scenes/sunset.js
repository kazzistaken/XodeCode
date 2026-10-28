import { Surface, hex, mix, shade, rng, fbm1, noise1, noise2, hash, ramp, pine, water, glitter } from './pixel.js';

/**
 * Sunset Lake: the sun going down over a wide lake. Bands of cloud catch the
 * light, the sun path glitters, birds cross now and then.
 */

const C = {
  sky: ['#2a1a4a', '#3d1f55', '#5a275e', '#7f3060', '#a8405e', '#cf5a57', '#ea7c4f', '#f6a14c', '#fbc35a'].map(hex),
  sun: hex('#fff1b8'),
  sunRim: hex('#ffd36b'),
  sunGlow: hex('#a8442a'),
  cloudTop: hex('#ffcf8a'),
  cloudLit: hex('#f08a5d'),
  cloudMid: hex('#b04f63'),
  cloudDark: hex('#5d2c58'),
  hillFar: hex('#6b3058'),
  hillMid: hex('#4a2148'),
  shore: hex('#241330'),
  shoreLit: hex('#3e1f40'),
  water: hex('#3a1f45'),
  waterNear: hex('#1a0f26'),
  ripple: hex('#ffc27a'),
  glitter: hex('#fff0bf'),
  bird: hex('#1c0f22'),
};

export default {
  id: 'sunset',
  label: 'Sunset lake',
  base: '#2a1a4a',

  build(w, h) {
    const u = h / 360;
    const rand = rng(8);
    const s = new Surface(w, h);
    const hy = Math.round(h * 0.6);
    const sun = { x: Math.round(w * 0.5), y: Math.round(hy - 18 * u), r: Math.round(30 * u) };

    s.vgrad(0, hy, C.sky);
    s.halo(sun.x, sun.y, 170 * u, C.sunGlow, 0.9);
    s.halo(sun.x, sun.y, 70 * u, hex('#7a3a1a'), 0.8);

    // The sun, banded near its bottom by the haze.
    for (let y = -sun.r; y <= sun.r; y += 1) {
      const half = Math.sqrt(Math.max(0, sun.r * sun.r - y * y));
      const yy = sun.y + y;
      if (yy >= hy) break;
      // Haze bands cut through the lower half.
      if (y > sun.r * 0.25 && Math.floor((y - sun.r * 0.25) / (3 * u)) % 2 === 1) continue;
      for (let x = Math.round(sun.x - half); x <= Math.round(sun.x + half); x += 1) {
        const rim = Math.abs(x - sun.x) > half - 2 * u || y < -sun.r + 2 * u;
        s.set(x, yy, rim ? C.sunRim : C.sun);
      }
    }

    // Far hills, then the shoreline with trees.
    const far = (x) => hy - 8 * u - (fbm1(x / (110 * u), 5, 4) * 0.5 + 0.5) * 24 * u;
    s.ridge(far, (x, y) => ramp([C.hillFar, mix(C.hillFar, C.sky[7], 0.4)], (y - far(x)) / (26 * u), x, y), hy);
    const mid = (x) => hy - 2 * u - Math.max(0, fbm1(x / (60 * u), 15, 4)) * 22 * u;
    s.ridge(mid, () => C.hillMid, hy);
    for (let x = 0; x < w; x += 2 + Math.floor(rand() * 3)) {
      if (Math.abs(x - sun.x) < 40 * u && rand() < 0.7) continue;
      if (noise1(x / (30 * u), 3) < -0.15) continue;
      pine(s, x, hy, Math.round((5 + rand() * 9) * u), C.shore, C.shoreLit);
    }
    s.rect(0, hy - 1, w, 1, C.shore);

    // Long bands of cloud, lit from below.
    const clouds = [];
    for (let i = 0; i < 9; i += 1) {
      const cw = Math.round((90 + rand() * 170) * u);
      const ch = Math.round((6 + rand() * 12) * u);
      const y = Math.round(hy * (0.12 + rand() * 0.62));
      const cells = [];
      for (let j = 0; j < ch; j += 1) {
        for (let k = 0; k < cw; k += 1) {
          const ex = Math.abs(k - cw / 2) / (cw / 2);
          const top = (1 - Math.pow(ex, 3)) * ch * (0.35 + (noise1(k / (8 * u), i * 3) * 0.5 + 0.5) * 0.65);
          if (ch - j <= top) {
            const fromBottom = ch - j;
            cells.push([k, j, fromBottom <= Math.max(1, Math.round(ch * 0.15)) ? 3 : fromBottom <= ch * 0.35 ? 2 : j < ch - top + 1 ? 0 : 1]);
          }
        }
      }
      clouds.push({ x: rand() * (w + 300 * u), y, cells, low: y / hy, speed: (0.8 + rand() * 1.2) * u });
    }

    return { s, w, h, u, hy, sun, clouds };
  },

  frame(st, out, t) {
    const { w, h, u, hy, sun } = st;
    out.copyFrom(st.s);

    for (const cloud of st.clouds) {
      const span = w + 300 * u;
      const x = Math.round(((((cloud.x - t * cloud.speed) % span) + span) % span) - 150 * u);
      const lit = mix(C.cloudMid, C.cloudLit, Math.min(1, cloud.low * 1.2));
      const shades = [C.cloudDark, mix(C.cloudDark, C.cloudMid, 0.7), lit, mix(lit, C.cloudTop, cloud.low)];
      for (const [i, j, tone] of cloud.cells) out.blend(x + i, cloud.y + j, shades[tone], tone === 0 ? 0.6 : 0.9);
    }

    water(out, out, hy, t, { tint: C.water, tintNear: C.waterNear, ripple: C.ripple, amp: 1.7 * u, deep: 0.3, deepNear: 0.62, rippleStrength: 0.3 });
    glitter(out, hy, sun.x, 34 * u, t, C.glitter, 0.6);

    // A line of birds now and then.
    const cycle = 31;
    const p = (t % cycle) / 16;
    if (p < 1) {
      const n = Math.floor(t / cycle);
      const baseY = hy * (0.25 + hash(n, 3) * 0.3);
      for (let b = 0; b < 5; b += 1) {
        const x = -20 * u + p * (w + 60 * u) - b * 9 * u;
        const y = baseY + Math.abs(b - 2) * 4 * u + Math.sin(t * 1.5 + b) * u;
        const up = Math.sin(t * 7 + b) > 0;
        const span = Math.max(2, Math.round(3 * u));
        out.set(x, y, C.bird);
        for (let i = 1; i <= span; i += 1) {
          const dy = up ? -Math.round(i * 0.6) : Math.round(i * 0.25);
          out.set(x - i, y + dy, C.bird);
          out.set(x + i, y + dy, C.bird);
        }
      }
    }
  },
};
