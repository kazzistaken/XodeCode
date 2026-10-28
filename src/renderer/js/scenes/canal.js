import { Surface, hex, mix, shade, rng, noise1, noise2, hash, ramp, water } from './pixel.js';

/**
 * Rain Canal: a quiet city canal at night in the rain. Lit windows (some
 * switching on and off), street lamps, an arched bridge, long reflections and
 * rings where the drops land.
 */

const C = {
  sky: ['#05070d', '#080c16', '#0c121f', '#111a2a', '#172334', '#1e2c3c'].map(hex),
  cloud: hex('#1b2535'),
  farBlock: hex('#0d1420'),
  farWin: hex('#3c5170'),
  wall: ['#141b27', '#18202d', '#1c2433', '#121822', '#1a1f2a'].map(hex),
  wallLit: hex('#232c3c'),
  roof: hex('#0a0e16'),
  winOff: hex('#0b0f17'),
  winWarm: hex('#f2b866'),
  winWarm2: hex('#e58f4c'),
  winCool: hex('#9fc3e6'),
  frame: hex('#0a0d14'),
  quay: hex('#1c222d'),
  quayLit: hex('#2c3443'),
  quayDark: hex('#0e121a'),
  rail: hex('#07090e'),
  lamp: hex('#ffe3a3'),
  lampGlow: hex('#8a5a2a'),
  bridge: hex('#1a202b'),
  bridgeLit: hex('#2b3240'),
  bridgeDark: hex('#0c1017'),
  water: hex('#0b1320'),
  waterNear: hex('#060a12'),
  ripple: hex('#5d7593'),
  rain: hex('#8ea3bf'),
  mist: hex('#2a3a50'),
};

export default {
  id: 'canal',
  label: 'Rain canal',
  base: '#05070d',

  build(w, h) {
    const u = h / 360;
    const rand = rng(23);
    const s = new Surface(w, h);
    const hy = Math.round(h * 0.6); // the waterline at the far quay

    s.vgrad(0, hy, C.sky);
    // Low cloud lit faintly by the city.
    for (let y = 0; y < hy * 0.55; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const n = noise2(x / (70 * u), y / (18 * u), 3) * 0.7 + noise2(x / (22 * u), y / (7 * u), 4) * 0.3;
        if (n > 0.55) s.blend(x, y, C.cloud, Math.min(0.8, (n - 0.55) * 4));
      }
    }

    // Distant towers with a few lit windows.
    const quayTop = hy - Math.round(10 * u);
    for (let x = 0; x < w; ) {
      const bw = Math.round((14 + rand() * 30) * u);
      const bh = Math.round((50 + rand() * 90) * u);
      s.rect(x, quayTop - bh, bw, bh, C.farBlock);
      for (let wy = quayTop - bh + 4 * u; wy < quayTop - 4; wy += Math.round(5 * u)) {
        for (let wx = x + 2 * u; wx < x + bw - 2 * u; wx += Math.round(4 * u)) {
          if (rand() < 0.12) s.rect(wx, wy, Math.max(1, Math.round(u)), Math.max(1, Math.round(2 * u)), C.farWin);
        }
      }
      x += bw + Math.round(rand() * 6 * u);
    }

    // Canal houses along the far quay: tall, narrow, gabled.
    const windows = [];
    for (let x = -Math.round(rand() * 20 * u); x < w; ) {
      const bw = Math.round((34 + rand() * 30) * u);
      const bh = Math.round((70 + rand() * 60) * u);
      const top = quayTop - bh;
      const wall = C.wall[Math.floor(rand() * C.wall.length)];
      s.rect(x, top, bw, bh, wall);
      s.rect(x, top, Math.max(1, Math.round(2 * u)), bh, shade(wall, 0.75));
      s.rect(x + bw - Math.max(1, Math.round(u)), top, Math.max(1, Math.round(u)), bh, mix(wall, C.wallLit, 0.6));
      // Roof: gable or step gable.
      const gable = Math.round((10 + rand() * 12) * u);
      if (rand() < 0.5) {
        s.poly(
          [
            [x - 1, top + 1],
            [x + bw / 2, top - gable],
            [x + bw + 1, top + 1],
          ],
          C.roof
        );
      } else {
        const steps = 4;
        for (let k = 0; k < steps; k += 1) {
          const inset = (k * bw) / (steps * 2.4);
          s.rect(x + inset, top - ((k + 1) * gable) / steps, bw - inset * 2, gable / steps + 1, wall);
        }
      }
      // Windows in a grid.
      const cols = Math.max(2, Math.floor(bw / (11 * u)));
      const rows = Math.max(3, Math.floor(bh / (17 * u)));
      const ww = Math.max(2, Math.round(5 * u));
      const wh = Math.max(3, Math.round(8 * u));
      for (let r = 0; r < rows - 1; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const wx = Math.round(x + ((c + 0.5) * bw) / cols - ww / 2);
          const wy = Math.round(top + 7 * u + r * (bh / rows));
          s.rect(wx - 1, wy - 1, ww + 2, wh + 2, C.frame);
          s.rect(wx, wy, ww, wh, C.winOff);
          const roll = rand();
          windows.push({
            x: wx,
            y: wy,
            w: ww,
            h: wh,
            color: roll < 0.12 ? C.winCool : roll < 0.55 ? C.winWarm : C.winWarm2,
            on: rand() < 0.42,
            seed: Math.floor(rand() * 1e6),
          });
        }
      }
      x += bw + Math.round(rand() * 2 * u);
    }

    // The quay wall, with a railing.
    s.rect(0, quayTop, w, hy - quayTop, C.quay);
    s.rect(0, quayTop, w, 1, C.quayLit);
    for (let y = quayTop + 3; y < hy; y += Math.round(4 * u)) {
      const off = (y >> 2) % 2 ? 0 : Math.round(6 * u);
      for (let x = off; x < w; x += Math.round(12 * u)) s.set(x, y, C.quayDark);
      s.rect(0, y, w, 1, mix(C.quay, C.quayDark, 0.4));
    }
    s.rect(0, quayTop - Math.round(6 * u), w, 1, C.rail);
    for (let x = 0; x < w; x += Math.round(7 * u)) s.rect(x, quayTop - Math.round(6 * u), 1, Math.round(6 * u), C.rail);

    // Street lamps along the quay.
    const lamps = [];
    for (let x = Math.round(30 * u); x < w; x += Math.round(120 * u)) {
      s.rect(x, quayTop - Math.round(34 * u), Math.max(1, Math.round(u)), Math.round(34 * u), C.rail);
      s.rect(x - Math.round(2 * u), quayTop - Math.round(36 * u), Math.round(5 * u), Math.round(2 * u), C.rail);
      lamps.push({ x, y: quayTop - Math.round(33 * u) });
    }

    // Boats moored along the quay.
    const boats = [];
    for (let x = Math.round(16 * u); x < w - 60 * u; x += Math.round((90 + rand() * 120) * u)) {
      boats.push({ x, len: Math.round((40 + rand() * 30) * u), phase: rand() * 6.28, cabin: rand() < 0.6 });
    }

    const drops = Array.from({ length: Math.round(420 * (w / 640)) }, () => ({
      x: rand() * w,
      y: rand() * h,
      v: (190 + rand() * 120) * u,
      len: Math.round((3 + rand() * 4) * u),
      b: 0.12 + rand() * 0.2,
    }));
    const rings = Array.from({ length: 40 }, (_, i) => ({ seed: i * 31 + 7, period: 1.2 + rand() * 1.6, phase: rand() * 3 }));

    return { s, w, h, u, hy, quayTop, windows, lamps, drops, rings, boats };
  },

  frame(st, out, t) {
    const { w, h, u, hy } = st;
    out.copyFrom(st.s);

    // Windows: most stay as they are, now and then one switches.
    for (const win of st.windows) {
      const epoch = Math.floor((t + (win.seed % 97)) / 23);
      const on = hash(win.seed, epoch) < 0.06 ? !win.on : win.on;
      if (!on) continue;
      const flicker = win.color === C.winCool ? 0.85 + 0.15 * Math.sin(t * 9 + win.seed) : 1;
      for (let y = 0; y < win.h; y += 1) {
        for (let x = 0; x < win.w; x += 1) {
          // A lit room: brighter at the top, a curtain on one side sometimes.
          const curtain = win.seed % 3 === 0 && x < win.w / 3;
          const c = curtain ? shade(win.color, 0.55) : y < 2 ? win.color : shade(win.color, 0.85);
          out.px[(win.y + y) * w + win.x + x] = flicker < 1 ? shade(c, flicker) : c;
        }
      }
    }

    for (const lamp of st.lamps) {
      out.halo(lamp.x, lamp.y, 26 * u, C.lampGlow, 0.85);
      out.rect(lamp.x - 1, lamp.y - 1, 3, 2, C.lamp);
    }

    // The canal: long, calm reflections.
    water(out, out, hy, t, {
      tint: C.water,
      tintNear: C.waterNear,
      ripple: C.ripple,
      amp: 0.5 * u,
      chop: 0.1,
      jitter: 4 * u,
      jitterRate: 4,
      deep: 0.24,
      deepNear: 0.52,
      stretch: 0.6,
      rippleStrength: 0.18,
    });

    for (const boat of st.boats) {
      const bob = Math.round(Math.sin(t * 0.9 + boat.phase) * 0.8 * u);
      const y0 = hy + Math.round(6 * u) + bob;
      for (let i = 0; i < boat.len; i += 1) {
        const e = Math.abs(i - boat.len / 2) / (boat.len / 2);
        const depth = Math.round(5 * u * (1 - e * e * 0.6));
        for (let y = 0; y < depth; y += 1) out.set(boat.x + i, y0 + y, y === 0 ? C.quayLit : y === 1 ? C.quay : mix(C.quay, C.quayDark, 0.5));
      }
      if (boat.cabin) {
        const cx = boat.x + Math.round(boat.len * 0.3);
        out.rect(cx, y0 - Math.round(6 * u), Math.round(boat.len * 0.35), Math.round(6 * u), C.quay);
        out.rect(cx, y0 - Math.round(6 * u), Math.round(boat.len * 0.35), 1, C.quayLit);
        out.rect(cx + Math.round(3 * u), y0 - Math.round(4 * u), Math.round(3 * u), Math.round(2 * u), C.winWarm2);
      }
    }

    // Rings where drops land.
    for (const ring of st.rings) {
      const cyc = Math.floor((t + ring.phase) / ring.period);
      const p = ((t + ring.phase) % ring.period) / ring.period;
      const x = hash(ring.seed, cyc, 1) * w;
      const y = hy + 4 + hash(ring.seed, cyc, 2) * (h - hy - 4);
      const d = (y - hy) / (h - hy);
      const r = p * (3 + d * 9) * u;
      const steps = Math.max(8, Math.round(r * 5));
      for (let i = 0; i < steps; i += 1) {
        const a = (i / steps) * 6.283;
        out.light(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.32, C.ripple, (1 - p) * 0.5);
      }
    }

    // Rain over everything.
    for (const drop of st.drops) {
      const y = (drop.y + t * drop.v) % (h + 20) - 10;
      const x = (drop.x - (y * 0.18)) % w;
      for (let i = 0; i < drop.len; i += 1) out.light(x - i * 0.18, y - i, C.rain, drop.b * (1 - i / drop.len));
    }
  },
};
