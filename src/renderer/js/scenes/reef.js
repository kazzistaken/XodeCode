import { Surface, hex, mix, shade, rng, fbm1, noise1, noise2, hash, ramp, SIN } from './pixel.js';

/**
 * Reef Shallows: under the surface of a warm sea. Light dances on the sand,
 * kelp sways, fish school past, bubbles rise.
 */

const C = {
  sea: ['#1d6f86', '#175f78', '#124f69', '#0e405a', '#0b334b', '#08273b', '#061d2e'].map(hex),
  surface: hex('#7fd0d8'),
  ray: hex('#a9e6e6'),
  caustic: hex('#bff1ea'),
  sand: ['#36463f', '#41524a', '#4f5f53', '#65735f'].map(hex),
  sandDark: hex('#22302f'),
  rockDark: hex('#1d2b33'),
  rock: hex('#2c3d44'),
  rockLit: hex('#4a5d60'),
  coralA: ['#7a2f4a', '#b2486a', '#e07a8f'].map(hex),
  coralB: ['#7a4a22', '#c07a35', '#efb066'].map(hex),
  coralC: ['#4a3373', '#7556a8', '#a689d6'].map(hex),
  kelp: hex('#2f5a34'),
  kelpLit: hex('#5b8a45'),
  fishA: hex('#f2c14e'),
  fishB: hex('#e8edf0'),
  fishStripe: hex('#2a2f3a'),
  bubble: hex('#cdeff2'),
};

export default {
  id: 'reef',
  label: 'Reef shallows',
  base: '#061d2e',

  build(w, h) {
    const u = h / 360;
    const rand = rng(64);
    const s = new Surface(w, h);
    const floor = (x) => h * 0.8 + fbm1(x / (90 * u), 4, 4) * 22 * u;

    s.vgrad(0, h, C.sea);
    // The underside of the surface.
    for (let y = 0; y < 6 * u; y += 1) {
      for (let x = 0; x < w; x += 1) s.blend(x, y, C.surface, (1 - y / (6 * u)) * 0.45);
    }

    // Distant rock shelves in the blue.
    const shelf = (x) => h * 0.55 + fbm1(x / (60 * u), 9, 4) * 40 * u;
    s.ridge(shelf, (x, y) => ramp([mix(C.rockDark, C.sea[3], 0.55), mix(C.rockDark, C.sea[4], 0.3)], (y - shelf(x)) / (60 * u), x, y));

    // Sand with ripples.
    s.ridge(floor, (x, y, depth) => {
      const r = Math.sin((x + noise1(y / (6 * u), 3) * 12 * u) / (5 * u) + y / (3 * u));
      const base = depth < 2 ? 3 : r > 0.6 ? 2 : r < -0.7 ? 0 : 1;
      return ramp([C.sand[base], C.sandDark], Math.min(1, depth / (h * 0.3)), x, y);
    });

    // Rocks with coral growing on them.
    const coralBranch = (x, y, len, angle, pal, depth) => {
      for (let i = 0; i < len; i += 1) {
        const px = x + Math.cos(angle) * i;
        const py = y + Math.sin(angle) * i;
        s.set(px, py, pal[i > len * 0.7 ? 2 : 1]);
        s.set(px + 1, py, pal[0]);
        if (depth < 3 && i > len * 0.4 && rand() < 0.12) coralBranch(px, py, len * 0.6, angle + (rand() - 0.5) * 1.4, pal, depth + 1);
      }
    };
    const fan = (cx, cy, r, pal) => {
      for (let a = -2.6; a < -0.5; a += 0.09) coralBranch(cx, cy, r * (0.7 + rand() * 0.3), a, pal, 2);
    };
    const brain = (cx, cy, r, pal) => {
      for (let y = Math.floor(cy - r * 0.8); y <= cy; y += 1) {
        for (let x = Math.floor(cx - r); x <= cx + r; x += 1) {
          const dx = (x - cx) / r;
          const dy = (y - cy) / (r * 0.8);
          if (dx * dx + dy * dy > 1) continue;
          const groove = Math.sin(x / (1.4 * u) + Math.sin(y / (2 * u)) * 2) > 0.3;
          s.set(x, y, dy < -0.6 ? pal[2] : groove ? pal[1] : pal[0]);
        }
      }
    };
    const outcrops = [];
    for (let i = 0; i < 7; i += 1) {
      const x = (i + 0.3 + rand() * 0.4) * (w / 7);
      const y = floor(x) + 2 * u;
      const r = (16 + rand() * 22) * u;
      // The rock.
      for (let yy = Math.floor(y - r * 0.9); yy <= y + 2; yy += 1) {
        for (let xx = Math.floor(x - r * 1.3); xx <= x + r * 1.3; xx += 1) {
          const dx = (xx - x) / (r * 1.3);
          const dy = (yy - y) / (r * 0.9);
          const d = dx * dx + dy * dy + (noise2(xx / (5 * u), yy / (5 * u), i) - 0.5) * 0.4;
          if (d > 1 || yy > y) continue;
          s.set(xx, yy, dy < -0.55 + dx * 0.3 ? C.rockLit : d > 0.75 ? C.rockDark : C.rock);
        }
      }
      outcrops.push({ x, y: y - r * 0.8, r });
      const pals = [C.coralA, C.coralB, C.coralC];
      for (let k = 0; k < 7; k += 1) {
        const cx = x + (rand() - 0.5) * r * 1.6;
        const cy = y - r * 0.55 - rand() * r * 0.3;
        const pick = pals[Math.floor(rand() * pals.length)];
        if (rand() < 0.55) fan(cx, cy, (12 + rand() * 16) * u, pick);
        else brain(cx, cy, (6 + rand() * 7) * u, pick);
      }
    }

    // Kelp, swaying, drawn each frame.
    const kelp = Array.from({ length: Math.round(16 * (w / 640)) }, () => {
      const x = rand() * w;
      return { x, base: floor(x) + 3 * u, len: (60 + rand() * 110) * u, phase: rand() * 6.28 };
    });

    // Three schools of fish.
    const schools = [
      { y: h * 0.32, speed: 14 * u, dir: 1, n: 14, color: C.fishA, seed: 1 },
      { y: h * 0.5, speed: 9 * u, dir: -1, n: 22, color: C.fishB, seed: 2 },
      { y: h * 0.2, speed: 6 * u, dir: 1, n: 6, color: C.fishB, seed: 3 },
    ];
    const bubbles = Array.from({ length: 40 }, () => ({
      x: rand() * w,
      y: rand(),
      v: (14 + rand() * 18) * u,
      r: rand() < 0.2 ? 2 : 1,
      phase: rand() * 6.28,
    }));

    // Sand cells that catch the moving light (caustics).
    const lit = [];
    for (let x = 0; x < w; x += 1) {
      const y0 = Math.round(floor(x));
      for (let y = y0; y < h; y += 1) lit.push(y * w + x);
    }

    return { s, w, h, u, floor, kelp, schools, bubbles, lit: Uint32Array.from(lit) };
  },

  frame(st, out, t) {
    const { w, h, u } = st;
    out.copyFrom(st.s);

    // Sun rays slanting down from the surface.
    for (let k = 0; k < 5; k += 1) {
      const x0 = w * (0.1 + k * 0.2) + Math.sin(t * 0.25 + k * 1.7) * 25 * u;
      const width = (8 + (k % 3) * 6) * u;
      const strength = 0.1 + 0.05 * Math.sin(t * 0.6 + k);
      for (let y = 0; y < h * 0.8; y += 1) {
        const fade = strength * (1 - y / (h * 0.8));
        const x1 = x0 + y * 0.28;
        for (let x = Math.floor(x1); x < x1 + width * (1 + y / h); x += 1) {
          if (((x + y) & 1) === 0) out.light(x, y, C.ray, fade);
        }
      }
    }

    // Caustics: a moving net of light on the sand.
    const TS = 1024 / 6.283;
    for (let i = 0; i < st.lit.length; i += 1) {
      const p = st.lit[i];
      const x = p % w;
      const y = (p / w) | 0;
      const warp = SIN[((y * 0.05 + t * 0.3) * TS + 4096000) & 1023] * 6;
      const a = SIN[(((x + warp) * 0.11 + t * 0.9 + y * 0.21) * TS + 4096000) & 1023];
      const b = SIN[((x * 0.07 - y * 0.15 - t * 0.7) * TS + 4096000) & 1023];
      const c = SIN[((x * 0.05 + y * 0.09 + t * 0.5) * TS + 4096000) & 1023];
      const v = Math.abs(a + b + c);
      if (v < 0.16) out.px[p] = mix(out.px[p], C.caustic, 0.22 * (1 - (y - h * 0.75) / (h * 0.4)));
    }

    // Kelp.
    for (const k of st.kelp) {
      const segs = Math.round(k.len);
      let x = k.x;
      for (let j = 0; j < segs; j += 1) {
        const f = j / segs;
        x = k.x + Math.sin(t * 0.8 + k.phase + f * 3) * f * 10 * u + Math.sin(t * 1.7 + f * 6) * f * 2 * u;
        const y = k.base - j;
        out.set(x - 1, y, shade(C.kelp, 0.7));
        out.set(x, y, C.kelp);
        out.set(x + 1, y, (j >> 2) % 3 === 0 ? C.kelpLit : C.kelp);
        // Leaves every so often.
        if (j % Math.round(9 * u) === 0 && j > 6) {
          const side = (j / Math.round(9 * u)) % 2 ? 1 : -1;
          for (let l = 1; l < 9 * u; l += 1) {
            out.set(x + side * l, y - l * 0.5, l < 4 * u ? C.kelpLit : C.kelp);
            out.set(x + side * l, y - l * 0.5 + 1, shade(C.kelp, 0.8));
          }
        }
      }
    }

    // Fish.
    for (const school of st.schools) {
      const span = w + 200 * u;
      const head = (((t * school.speed * school.dir + span * (0.45 + school.seed * 0.17)) % span) + span) % span;
      for (let i = 0; i < school.n; i += 1) {
        const ox = (hash(i, school.seed) - 0.5) * 70 * u;
        const oy = (hash(i, school.seed, 2) - 0.5) * 34 * u + Math.sin(t * 1.4 + i) * 2 * u;
        const x = school.dir > 0 ? head - 100 * u + ox : span - head - 100 * u + ox;
        const y = school.y + oy + Math.sin(t * 0.5 + school.seed) * 8 * u;
        drawFish(out, x, y, school.dir, school.color, u, t + i);
      }
    }

    // Bubbles rising and wobbling.
    for (const b of st.bubbles) {
      const y = h - (((b.y * h + t * b.v) % (h + 10)) - 5);
      const x = b.x + Math.sin(t * 2 + b.phase + y * 0.05) * 2 * u;
      if (b.r === 1) out.light(x, y, C.bubble, 0.6);
      else {
        out.light(x - 1, y, C.bubble, 0.5);
        out.light(x + 1, y, C.bubble, 0.5);
        out.light(x, y - 1, C.bubble, 0.7);
        out.light(x, y + 1, C.bubble, 0.35);
      }
    }
  },
};

function drawFish(out, x, y, dir, color, u, t) {
  const len = Math.max(4, Math.round(6 * u));
  const tail = Math.sin(t * 9) > 0 ? 1 : 0;
  for (let i = 0; i < len; i += 1) {
    const px = Math.round(x + (dir > 0 ? -i : i));
    const body = i === 0 || i === len - 1 ? 0 : 1;
    out.set(px, y, i === Math.floor(len / 2) ? shade(color, 0.6) : color);
    if (body) {
      out.set(px, y - 1, shade(color, 1.1));
      out.set(px, y + 1, shade(color, 0.7));
    }
  }
  const tx = Math.round(x + (dir > 0 ? -len : len));
  out.set(tx, y - 1 + tail, shade(color, 0.85));
  out.set(tx, y + tail, shade(color, 0.85));
  out.set(Math.round(x + (dir > 0 ? -1 : 1)), y - 1, C.fishStripe);
}
