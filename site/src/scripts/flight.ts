// Firefly flight, simplified from field observations of Photinus fireflies:
// - most males fly slowly and low over the grass on meandering paths, flashing as they go;
// - a flash is given on a short upward swoop (the "J" stroke of P. pyralis);
// - females mostly perch in the grass and answer from there;
// - fireflies gather where they emerged rather than spreading evenly over a field.
// This file is kinematics only. Who flashes when is decided by the reactive model.
export type Fly = {
  x: number; z: number; h: number;      // ground x (0..1), depth z (0 far .. 1 near), height h (0 grass .. 1)
  th: number; v: number;                // heading and speed (flyers); perchers have v = 0
  hx: number; hz: number;               // home: where it emerged
  h0: number; vh: number;               // preferred height, vertical speed
  perch: boolean; ph: number; b: number;
};

export function makeFlies(n: number, seed = 29): Fly[] {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const homes = Array.from({ length: Math.max(6, Math.round(n / 70)) }, () => ({ x: 0.06 + r() * 0.88, z: 0.08 + r() * 0.88 }));
  return Array.from({ length: n }, () => {
    const home = homes[(r() * homes.length) | 0], perch = r() < 0.2;
    return {
      x: home.x + (r() - 0.5) * 0.1, z: home.z + (r() - 0.5) * 0.12, h: perch ? 0.03 : 0.1 + r() * 0.3,
      th: r() * 6.283, v: perch ? 0 : 0.00003 + r() * 0.00004,
      hx: home.x, hz: home.z, h0: perch ? 0.03 : 0.08 + r() * 0.35, vh: 0,
      perch, ph: r() * 6.283, b: 0.6 + r() * 0.4,
    };
  });
}

/** Advance every fly by dt milliseconds. `swoop[i]` > 0 means flashing: climb (the J stroke). */
export function fly(fs: Fly[], dt: number, swoop: (i: number) => number, rand = Math.random) {
  for (let i = 0; i < fs.length; i++) {
    const f = fs[i];
    if (f.perch) { f.h = 0.03 + 0.01 * Math.sin(f.ph + performance.now() * 0.001); continue; }
    // meander: heading wanders, with a weak pull back toward home
    f.th += (rand() - 0.5) * 0.004 * dt;
    const dx = f.hx - f.x, dz = f.hz - f.z, d = Math.hypot(dx, dz);
    if (d > 0.08) f.th += Math.sin(Math.atan2(dz, dx) - f.th) * 0.0006 * dt;
    f.x += Math.cos(f.th) * f.v * dt;
    f.z += Math.sin(f.th) * f.v * dt * 0.5;            // depth reads slower on screen
    if (f.x < 0.02 || f.x > 0.98) { f.th = Math.PI - f.th; f.x = Math.min(0.98, Math.max(0.02, f.x)); }
    if (f.z < 0.02 || f.z > 0.98) { f.th = -f.th; f.z = Math.min(0.98, Math.max(0.02, f.z)); }
    // height: drift toward preferred, swoop up while flashing, never into the ground
    const up = swoop(i);
    f.vh += ((f.h0 - f.h) * 0.00002 + up * 0.00004 + (rand() - 0.5) * 0.00001) * dt;
    f.vh *= 0.96;
    f.h = Math.max(0.02, Math.min(0.9, f.h + f.vh * dt));
  }
}

/**
 * Who can see whom: up to `k` nearest flies within `reach` (ground distance, height counts
 * a little). A spatial hash on the ground plane keeps it near linear.
 */
export function neighbours(fs: Fly[], reach: number, k: number): number[][] {
  const cell = reach, cols = Math.ceil(1 / cell) + 1, grid = new Map<number, number[]>();
  fs.forEach((f, i) => { const key = ((f.z / cell) | 0) * cols + ((f.x / cell) | 0); (grid.get(key) ?? grid.set(key, []).get(key)!).push(i); });
  return fs.map((f, i) => {
    const cx = (f.x / cell) | 0, cz = (f.z / cell) | 0, found: [number, number][] = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const j of grid.get((cz + a) * cols + cx + b) ?? []) {
        if (j === i) continue;
        const g = fs[j], d = Math.hypot(g.x - f.x, (g.z - f.z) * 1.4, (g.h - f.h) * 0.3);
        if (d < reach) found.push([d, j]);
      }
    }
    found.sort((p, q) => p[0] - q[0]);
    return found.slice(0, k).map((p) => p[1]);
  });
}
