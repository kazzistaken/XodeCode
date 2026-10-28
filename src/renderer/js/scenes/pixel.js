/**
 * Tiny pixel-art toolkit for the animated backgrounds. Everything draws into
 * a Uint32Array of packed colours (the byte order ImageData uses on little-
 * endian machines: 0xAABBGGRR). No DOM here, so scenes also run in a worker
 * and in Node (scripts/render-scenes.js renders them to PNG for review).
 */

export function rgb(r, g, b) {
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export function hex(value) {
  const n = parseInt(value.slice(1), 16);
  return rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

export const R = (c) => c & 255;
export const G = (c) => (c >> 8) & 255;
export const B = (c) => (c >> 16) & 255;

export function mix(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  return rgb(
    Math.round(R(a) + (R(b) - R(a)) * t),
    Math.round(G(a) + (G(b) - G(a)) * t),
    Math.round(B(a) + (B(b) - B(a)) * t)
  );
}

/** Brighten towards a light colour (like a soft "add"). */
export function glow(base, light, t) {
  if (t <= 0) return base;
  const k = Math.min(1, t);
  return rgb(
    Math.min(255, Math.round(R(base) + R(light) * k)),
    Math.min(255, Math.round(G(base) + G(light) * k)),
    Math.min(255, Math.round(B(base) + B(light) * k))
  );
}

export function shade(c, k) {
  return rgb(
    Math.max(0, Math.min(255, Math.round(R(c) * k))),
    Math.max(0, Math.min(255, Math.round(G(c) * k))),
    Math.max(0, Math.min(255, Math.round(B(c) * k)))
  );
}

/** Seeded random numbers (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 0..1 value for an integer position (and optional time step). */
export function hash(x, y = 0, z = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Sine lookup for per-pixel work. */
export const SIN_SIZE = 1024;
const SIN_MASK = SIN_SIZE - 1;
export const SIN = new Float32Array(SIN_SIZE);
for (let i = 0; i < SIN_SIZE; i += 1) SIN[i] = Math.sin((i / SIN_SIZE) * 6.283185307);

/** Smooth 1D value noise, roughly -1..1. */
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  return (hash(i, seed) * 2 - 1) * (1 - smooth(f)) + (hash(i + 1, seed) * 2 - 1) * smooth(f);
}

/** Smooth 2D value noise, 0..1. */
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function fbm1(x, seed = 0, octaves = 4) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += noise1(x * freq, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

export function fbm2(x, y, seed = 0, octaves = 4) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += noise2(x * freq, y * freq, seed + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** 4x4 ordered dither thresholds, 0..1. */
export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

export const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];

/**
 * Pick from a list of colour stops at position t (0..1) with ordered
 * dithering between neighbours: crisp bands with a soft, pixel-y blend.
 */
export function ramp(stops, t, x, y) {
  const n = stops.length - 1;
  const p = Math.max(0, Math.min(0.99999, t)) * n;
  const i = Math.floor(p);
  return p - i > bayer(x, y) ? stops[Math.min(n, i + 1)] : stops[i];
}

export class Surface {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint32Array(w * h);
  }

  get(x, y) {
    if (x < 0) x = 0;
    else if (x >= this.w) x = this.w - 1;
    if (y < 0) y = 0;
    else if (y >= this.h) y = this.h - 1;
    return this.px[y * this.w + x];
  }

  set(x, y, c) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px[y * this.w + x] = c;
  }

  /** Blend a colour over a pixel. */
  blend(x, y, c, t) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || t <= 0) return;
    const i = y * this.w + x;
    this.px[i] = mix(this.px[i], c, t);
  }

  /** Add light to a pixel. */
  light(x, y, c, t) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || t <= 0) return;
    const i = y * this.w + x;
    this.px[i] = glow(this.px[i], c, t);
  }

  rect(x, y, w, h, c) {
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.w, (x + w) | 0);
    const y1 = Math.min(this.h, (y + h) | 0);
    for (let yy = y0; yy < y1; yy += 1) this.px.fill(c, yy * this.w + x0, yy * this.w + x1);
  }

  /** Vertical dithered gradient across rows y0..y1 using colour stops. */
  vgrad(y0, y1, stops) {
    for (let y = Math.max(0, y0); y < Math.min(this.h, y1); y += 1) {
      const t = (y - y0) / Math.max(1, y1 - y0 - 1);
      for (let x = 0; x < this.w; x += 1) this.px[y * this.w + x] = ramp(stops, t, x, y);
    }
  }

  disc(cx, cy, r, c) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) this.set(x, y, c);
      }
    }
  }

  /** Soft round light (radial falloff) added onto what is there. */
  halo(cx, cy, r, c, strength = 1) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy) / r;
        if (d < 1) {
          const k = (1 - d) * (1 - d) * strength;
          // Quantise the falloff into steps so it stays pixel art.
          this.light(x, y, c, Math.round(k * 6 + bayer(x, y) - 0.5) / 6);
        }
      }
    }
  }

  line(x0, y0, x1, y1, c) {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const ex = Math.round(x1);
    const ey = Math.round(y1);
    const dx = Math.abs(ex - x);
    const dy = -Math.abs(ey - y);
    const sx = x < ex ? 1 : -1;
    const sy = y < ey ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x, y, c);
      if (x === ex && y === ey) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Fill a polygon (even-odd scanlines). */
  poly(points, c) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of points) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(this.h - 1, Math.ceil(maxY)); y += 1) {
      const cy = y + 0.5;
      const xs = [];
      for (let i = 0; i < points.length; i += 1) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % points.length];
        if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.max(0, Math.round(xs[i])); x < Math.min(this.w, Math.round(xs[i + 1])); x += 1) {
          this.px[y * this.w + x] = c;
        }
      }
    }
  }

  /**
   * Fill everything below a skyline. `top(x)` gives the first row; `color(x,
   * y, depth)` picks the colour, with depth = rows below the skyline.
   */
  ridge(top, color, bottom = this.h) {
    for (let x = 0; x < this.w; x += 1) {
      const y0 = Math.max(0, Math.round(top(x)));
      for (let y = y0; y < Math.min(bottom, this.h); y += 1) this.px[y * this.w + x] = color(x, y, y - y0);
    }
  }

  /** Draw a sprite given as strings; each character maps through `palette` (space = clear). */
  sprite(rows, x, y, palette, flip = false) {
    for (let j = 0; j < rows.length; j += 1) {
      const row = rows[j];
      for (let i = 0; i < row.length; i += 1) {
        const c = palette[row[flip ? row.length - 1 - i : i]];
        if (c !== undefined) this.set(x + i, y + j, c);
      }
    }
  }

  copyFrom(other) {
    this.px.set(other.px);
  }
}

/** A pine tree silhouette, `h` pixels tall, with a lit edge on one side. */
export function pine(s, x, base, h, dark, lit) {
  const trunk = Math.max(1, Math.round(h * 0.12));
  const crown = h - trunk;
  for (let j = 0; j < crown; j += 1) {
    const t = j / crown;
    // Stepped tiers: wider at the bottom of each tier.
    const tier = (j % Math.max(3, Math.round(crown / 4))) / Math.max(3, Math.round(crown / 4));
    const half = Math.max(0, Math.round((t * 0.42 + tier * 0.12) * h * 0.55));
    const y = base - h + j;
    for (let i = -half; i <= half; i += 1) s.set(x + i, y, i === half && lit !== undefined && j > 1 ? lit : dark);
  }
  for (let j = 0; j < trunk; j += 1) s.set(x, base - trunk + j, dark);
}

/**
 * Moving water: the scene above the horizon mirrored, with each row nudged
 * sideways over time (the wobble), tinted deeper with distance, and bright
 * ripple dashes running across it. `src` is the frame so far (reflections
 * include moving things), `dst` is written below `horizon`.
 */
export function water(dst, src, horizon, t, o = {}) {
  const { w, h } = dst;
  const sp = src.px;
  const dp = dst.px;
  const tint = o.tint ?? hex('#0a1626');
  const tintNear = o.tintNear ?? tint;
  const ripple = o.ripple ?? hex('#9cc4e4');
  const amp = o.amp ?? 2.2;
  const deep = o.deep ?? 0.35;
  const deepNear = o.deepNear ?? 0.6;
  const speed = o.speed ?? 1;
  const rippleK = o.rippleStrength ?? 0.32;
  const span = Math.max(1, h - horizon);
  const TS = SIN_SIZE / 6.283185307;
  const rr = R(ripple);
  const rg = G(ripple);
  const rb = B(ripple);
  for (let y = horizon; y < h; y += 1) {
    const d = (y - horizon) / span; // 0 far .. 1 near
    // Perspective: far rows are thin and calm, near rows wave wider.
    const wob =
      Math.sin(y * 0.55 + t * 2.1 * speed) * amp * (0.25 + d) +
      Math.sin(y * 1.7 - t * 3.3 * speed) * 0.7 * (o.chop ?? 1) * (0.4 + d);
    // Optional broken slices: each row jumps sideways now and then, which is
    // how lights on choppy water break up.
    const jitter = o.jitter ? (hash(y, Math.floor(t * (o.jitterRate ?? 5)), 3) - 0.5) * o.jitter * (0.3 + d) : 0;
    const ox = Math.round(wob + jitter);
    let sy = horizon - 1 - Math.floor((y - horizon) * (o.stretch ?? 1));
    if (sy < 0) sy = 0;
    const tintRow = mix(tint, tintNear, d);
    const tr = R(tintRow);
    const tg = G(tintRow);
    const tb = B(tintRow);
    const k = Math.round((deep + (deepNear - deep) * d) * 256);
    const ik = 256 - k;
    const kx = 0.9 / (0.18 + d * 1.4);
    const phase = hash(y, 7) * 6.283;
    const a1 = kx * 0.21 * TS;
    const b1 = (phase + t * 1.3 * speed) * TS + SIN_SIZE * 4096;
    const a2 = kx * 0.077 * TS;
    const b2 = (phase * 2 - t * 0.7 * speed) * TS + SIN_SIZE * 4096;
    const rk = Math.round(rippleK * (0.5 + d * 0.5) * 256);
    const irk = 256 - rk;
    const row = y * w;
    const srow = sy * w;
    for (let x = 0; x < w; x += 1) {
      let sx = x + ox;
      if (sx < 0) sx = 0;
      else if (sx >= w) sx = w - 1;
      const c = sp[srow + sx];
      let r = ((c & 255) * ik + tr * k) >> 8;
      let g = (((c >> 8) & 255) * ik + tg * k) >> 8;
      let b = (((c >> 16) & 255) * ik + tb * k) >> 8;
      // Ripple dashes drifting across the surface.
      const wave = SIN[(a1 * x + b1) & SIN_MASK] + SIN[(a2 * x + b2) & SIN_MASK];
      if (wave > 1.62) {
        r = (r * irk + rr * rk) >> 8;
        g = (g * irk + rg * rk) >> 8;
        b = (b * irk + rb * rk) >> 8;
      } else if (wave < -1.55) {
        r = (r * 220) >> 8;
        g = (g * 220) >> 8;
        b = (b * 220) >> 8;
      }
      dp[row + x] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
}

/** Sparkling light path on water below a light source at column cx. */
export function glitter(s, horizon, cx, width, t, color, density = 0.5) {
  const span = Math.max(1, s.h - horizon);
  const step = Math.floor(t * 7);
  for (let y = horizon; y < s.h; y += 1) {
    const d = (y - horizon) / span;
    const half = width * (0.25 + d * 0.9);
    for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x += 1) {
      const edge = 1 - Math.abs(x - cx) / half;
      if (edge <= 0) continue;
      const r = hash(x, y, step + ((x * 7 + y * 3) % 5));
      if (r < density * edge * edge * (0.45 + 0.55 * (1 - d))) {
        // Short horizontal dashes, longer close up.
        const len = 1 + Math.round(d * 3 * edge);
        for (let i = 0; i < len; i += 1) s.light(x + i, y, color, (0.55 + 0.45 * edge) * (1 - i / (len + 1)));
      }
    }
  }
}

/** Stars that twinkle. Returns a list to draw each frame. */
export function makeStars(rand, w, maxY, count, tooBright = 0.1) {
  const stars = [];
  for (let i = 0; i < count; i += 1) {
    const y = Math.floor(Math.pow(rand(), 1.4) * maxY);
    stars.push({
      x: Math.floor(rand() * w),
      y,
      b: 0.25 + rand() * 0.65,
      big: rand() < tooBright,
      speed: 0.6 + rand() * 2.2,
      phase: rand() * 6.283,
    });
  }
  return stars;
}

export function drawStars(s, stars, t, color) {
  for (const star of stars) {
    const k = star.b * (0.55 + 0.45 * Math.sin(t * star.speed + star.phase));
    s.light(star.x, star.y, color, k);
    if (star.big && k > 0.5) {
      s.light(star.x - 1, star.y, color, k * 0.35);
      s.light(star.x + 1, star.y, color, k * 0.35);
      s.light(star.x, star.y - 1, color, k * 0.35);
      s.light(star.x, star.y + 1, color, k * 0.35);
    }
  }
}
