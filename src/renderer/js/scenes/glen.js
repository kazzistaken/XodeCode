import { Surface, hex, mix, shade, rng, fbm1, fbm2, noise1, noise2, hash, ramp, water } from './pixel.js';

/**
 * Waterfall Glen: a mossy gorge at dusk. The fall pours down a cliff into a
 * pool, mist rises, the stream runs out towards you, leaves drift down.
 */

const C = {
  sky: ['#0d1a24', '#12252f', '#1a3239', '#244141', '#345247', '#4a644f'].map(hex),
  ray: hex('#cfe3b0'),
  cliffFar: hex('#1d2f33'),
  cliff: ['#1a2628', '#22302f', '#2b3a36', '#35463e'].map(hex),
  cliffDark: hex('#111a1c'),
  moss: hex('#3f5a35'),
  mossLit: hex('#6b8a45'),
  treeDark: hex('#0b150f'),
  tree: hex('#132218'),
  treeMid: hex('#1c321e'),
  treeLit: hex('#2f4c26'),
  treeTip: hex('#557434'),
  trunk: hex('#120f0c'),
  fall: ['#6f9ea4', '#8fbdc0', '#b6dcd8', '#e3f4ef'].map(hex),
  foam: hex('#eef8f2'),
  pool: hex('#16343a'),
  poolNear: hex('#0b1d22'),
  ripple: hex('#a8d0cc'),
  mist: hex('#c4ddd6'),
  rock: hex('#1b2321'),
  rockLit: hex('#3a4a40'),
  leaf: ['#b8892f', '#c46a2b', '#8f9a35'].map(hex),
};

export default {
  id: 'glen',
  label: 'Waterfall glen',
  base: '#0d1a24',

  build(w, h) {
    const u = h / 360;
    const rand = rng(41);
    const s = new Surface(w, h);
    const hy = Math.round(h * 0.7); // the pool surface
    const fx = Math.round(w * 0.5); // waterfall centre
    const fw = Math.round(30 * u); // waterfall width
    const lip = Math.round(h * 0.2); // where the water goes over

    s.vgrad(0, h, C.sky);

    // Far gorge walls, hazy.
    const farTop = (x) => h * 0.12 + Math.abs(x - fx) * -0.12 + fbm1(x / (40 * u), 2, 4) * 14 * u;
    s.ridge(farTop, (x, y) => ramp([C.cliffFar, mix(C.cliffFar, C.sky[5], 0.4)], (y - farTop(x)) / (h * 0.6), x, y), hy);

    // The main cliff face the water falls down, with ledges and moss.
    const cliffTop = (x) => lip - Math.max(0, Math.abs(x - fx) - fw * 0.6) * 0.22 + noise1(x / (6 * u), 7) * 2 * u;
    s.ridge(
      cliffTop,
      (x, y, depth) => {
        // Rock layers of uneven thickness that come and go.
        const warp = y + noise1(x / (16 * u), 5) * 9 * u + noise1(x / (5 * u), 6) * 2 * u;
        const band = 7 * u + noise1(Math.floor(warp / (10 * u)), 8) * 3 * u;
        const strata = Math.floor(warp / band);
        const inStrata = warp - strata * band;
        const n = fbm2(x / (10 * u), y / (6 * u), 9, 3);
        let c = C.cliff[Math.min(3, Math.floor(n * 3.6 + (strata % 3 === 0 ? 0.7 : 0)))];
        const crack = noise2(x / (9 * u), strata * 3.1, 12) > 0.38;
        // The top of each ledge catches light; under it is shadow.
        if (inStrata < 1.1 && crack) c = mix(c, C.cliff[3], 0.55);
        else if (inStrata > band - 1.6 * u && crack) c = C.cliffDark;
        // Vertical cracks.
        if (noise2(x / (2 * u), y / (14 * u), 13) > 0.83) c = C.cliffDark;
        if (depth < 3 || (inStrata < 2.4 && noise2(x / (5 * u), y / (4 * u), 3) > 0.6)) c = depth < 2 ? C.mossLit : C.moss;
        // Darker close to the fall (wet rock).
        if (Math.abs(x - fx) < fw * 0.9) c = shade(c, 0.7);
        return c;
      },
      hy
    );

    // Trees framing the gorge, layered clumps of foliage.
    const clump = (cx, cy, r, tone) => {
      for (let y = Math.floor(cy - r); y <= cy + r; y += 1) {
        for (let x = Math.floor(cx - r * 1.2); x <= cx + r * 1.2; x += 1) {
          const dx = (x - cx) / (r * 1.2);
          const dy = (y - cy) / r;
          const d = dx * dx + dy * dy + (noise2(x / (3 * u), y / (3 * u), tone) - 0.5) * 0.5;
          if (d > 1) continue;
          // Light from the upper left.
          const lit = -dx * 0.6 - dy * 0.8 + (noise2(x / (2 * u), y / (2 * u), 11) - 0.5) * 0.7;
          const c = lit > 0.55 ? C.treeTip : lit > 0.2 ? C.treeLit : lit > -0.25 ? C.treeMid : C.tree;
          s.set(x, y, c);
        }
      }
    };
    const side = (fromX, toX, base) => {
      for (let i = 0; i < 70; i += 1) {
        const x = fromX + rand() * (toX - fromX);
        const edge = Math.min(Math.abs(x - fromX), Math.abs(x - toX)) / Math.abs(toX - fromX);
        const y = base - rand() * h * (0.85 - edge * 0.5);
        clump(x, y, (10 + rand() * 18) * u, i);
      }
    };
    // Trunks first.
    for (let i = 0; i < 9; i += 1) {
      const left = i < 5;
      const x = left ? rand() * w * 0.24 : w - rand() * w * 0.22;
      s.rect(x, h * 0.1, Math.round((3 + rand() * 4) * u), h, C.trunk);
    }
    side(-20 * u, w * 0.3, hy + 10 * u);
    side(w * 0.72, w + 20 * u, hy + 10 * u);

    // Rocks at the pool edge.
    const rocks = [];
    for (let i = 0; i < 14; i += 1) {
      const x = rand() < 0.5 ? rand() * w * 0.35 : w * 0.65 + rand() * w * 0.35;
      rocks.push({ x, y: hy + rand() * 4 * u, r: (5 + rand() * 12) * u });
    }

    const leaves = Array.from({ length: 22 }, (_, i) => ({
      x: rand() * w,
      y: rand() * h,
      v: (8 + rand() * 10) * u,
      c: C.leaf[i % C.leaf.length],
      phase: rand() * 6.28,
    }));
    const mist = Array.from({ length: 70 }, () => ({ x: rand(), y: rand(), v: 4 + rand() * 8, r: (4 + rand() * 9) * u }));

    return { s, w, h, u, hy, fx, fw, lip, rocks, leaves, mist };
  },

  frame(st, out, t) {
    const { w, h, u, hy, fx, fw, lip } = st;
    out.copyFrom(st.s);

    // Soft light shafts through the canopy (left to right, downwards).
    for (let y = 0; y < hy; y += 1) {
      for (let k = 0; k < 3; k += 1) {
        const x0 = w * (0.2 + k * 0.17) + y * 0.55 + Math.sin(t * 0.2 + k) * 6 * u;
        const width = (10 + k * 4) * u;
        const a = 0.09 * (1 - y / hy) * (0.7 + 0.3 * Math.sin(t * 0.5 + k * 2));
        for (let x = Math.floor(x0); x < x0 + width; x += 1) {
          if (((x + y) & 1) === 0) out.light(x, y, C.ray, a);
        }
      }
    }

    // The fall: streaks scrolling down, brighter in the middle.
    const speed = 70 * u;
    for (let y = Math.round(lip - 2 * u); y < hy; y += 1) {
      const spread = Math.round((y - lip) * 0.05);
      for (let x = fx - fw / 2 - spread; x < fx + fw / 2 + spread; x += 1) {
        const across = Math.abs(x - fx) / (fw / 2 + spread);
        const col = Math.floor(x / Math.max(1, Math.round(2 * u)));
        const v = hash(col, Math.floor((y - t * speed * (0.9 + hash(col, 1) * 0.3)) / (6 * u)), 4);
        let level = v * 0.7 + (1 - across) * 0.5;
        if (across > 0.9 && hash(x, y, Math.floor(t * 8)) < 0.5) continue; // ragged edges
        level = Math.min(3, Math.floor(level * 3.2));
        out.set(x, y, C.fall[level]);
      }
    }
    // Lip of the fall.
    for (let x = fx - fw / 2; x < fx + fw / 2; x += 1) out.set(x, Math.round(lip - 2 * u), C.foam);

    // The pool and the stream: lively water.
    water(out, out, hy, t, { tint: C.pool, tintNear: C.poolNear, ripple: C.ripple, amp: 2.4 * u, deep: 0.45, deepNear: 0.72, rippleStrength: 0.4, speed: 1.6 });

    // Churning foam where the water lands.
    for (let i = 0; i < 260; i += 1) {
      const a = hash(i, Math.floor(t * 10), 2);
      const r = hash(i, 5) * fw * 1.4;
      const x = fx + (a - 0.5) * 2 * r;
      const y = hy + hash(i, Math.floor(t * 10), 6) * 10 * u * (1 - Math.abs(a - 0.5));
      out.blend(x, y, C.foam, 0.75);
    }

    // Rocks at the edges of the pool.
    for (const rock of st.rocks) {
      for (let y = Math.floor(rock.y - rock.r * 0.7); y <= rock.y + rock.r * 0.25; y += 1) {
        for (let x = Math.floor(rock.x - rock.r); x <= rock.x + rock.r; x += 1) {
          const dx = (x - rock.x) / rock.r;
          const dy = (y - rock.y) / (rock.r * 0.7);
          if (dx * dx + dy * dy > 1) continue;
          out.set(x, y, dx * 0.5 + dy < -0.45 ? C.rockLit : C.rock);
        }
      }
    }

    // Mist rising from the pool.
    for (const m of st.mist) {
      const life = (m.y + t / m.v) % 1;
      const x = fx + (m.x - 0.5) * fw * 4 + Math.sin(t * 0.4 + m.x * 9) * 8 * u;
      const y = hy + 4 * u - life * 70 * u;
      const a = Math.sin(life * Math.PI) * 0.22;
      const r = m.r * (0.6 + life);
      for (let yy = Math.floor(y - r); yy < y + r; yy += 1) {
        for (let xx = Math.floor(x - r); xx < x + r; xx += 1) {
          const d = ((xx - x) ** 2 + (yy - y) ** 2) / (r * r);
          if (d < 1 && ((xx + yy) & 1) === 0) out.blend(xx, yy, C.mist, a * (1 - d) * 2);
        }
      }
    }

    // Leaves drifting down.
    for (const leaf of st.leaves) {
      const y = (leaf.y + t * leaf.v) % (h + 10) - 5;
      const x = (leaf.x + Math.sin(t * 0.8 + leaf.phase) * 10 * u + w) % w;
      out.set(x, y, leaf.c);
      if (Math.sin(t * 3 + leaf.phase) > 0) out.set(x + 1, y, shade(leaf.c, 0.8));
      else out.set(x, y + 1, shade(leaf.c, 0.8));
    }
  },
};
