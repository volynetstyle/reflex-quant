// Trade-off suite: the costs LOG 47-49 accepted, each along the axis where
// it could grow. Every family has its own sizes; ids are `<family>@<n>`, as
// in scaling.mjs, and the step result is checksummed.
//
//   link-fanout       an absent source with more subscribers than the source
//                     check covers (LOG 49): N readers relink each pass
//   link-subs         the source check's boundary: one reader with a long
//                     list relinks to a source with S other readers
//   replace-all-k1/k3 absent sources with 1 (proven by the source) or 3
//                     (proven by the scans) other readers, N per pass
//   swaps             k adjacent swaps per pass: two misses each (LOG 47)
//   swaps-nested      k skipped edges read back oldest first: past TAIL they
//                     are not at the very end, so the pass marks
//   move-earlier      one source moved d places earlier: two misses (LOG 47)
//   move-later        one source moved d places later: two misses, was d
//   burst-waves       one wave of W effects, then four of one effect: the
//                     ring's give-back policy (LOG 48)
import { range } from "./scaling.mjs";

const SMI = 0x3fffffff;
const L = 1024;

/** A computed that reads `ps` in the order `orders[tick & 1]`. */
function alternating(api, ps, orders) {
  const tick = api.signal(0);
  const c = api.computed(() => {
    const order = orders[tick.get() & 1];
    let t = 0;
    for (let k = 0; k < order.length; k++) t = (t + ps[order[k]].get()) & SMI;
    return t;
  });
  c.get();
  return (i) => (tick.set(i), c.get());
}

const swapped = (order, at) => {
  const o = [...order];
  for (const i of at) [o[i], o[i + 1]] = [o[i + 1], o[i]];
  return o;
};
const moved = (order, from, to) => {
  const o = [...order];
  const [x] = o.splice(from, 1);
  o.splice(to, 0, x);
  return o;
};

export const families = {
  "link-fanout": {
    sizes: [16, 64, 256, 1024, 4096],
    note: "N readers switch between sources a and b: N relations per pass to a source with up to N subscribers",
    build(api, n) {
      const cond = api.signal(true);
      const a = api.signal(1);
      const b = api.signal(2);
      const cs = range(n).map(() => api.computed(() => (cond.get() ? a.get() : b.get())));
      for (const c of cs) c.get();
      return (i) => {
        cond.set((i & 1) === 0);
        let t = 0;
        for (const c of cs) t = (t + c.get()) & SMI;
        return t;
      };
    },
  },
  "link-subs": {
    sizes: [0, 1, 2, 3, 8, 64, 512],
    note: "one reader of 33 sources switches its middle one between a and b, each with N other readers",
    build(api, n) {
      const cond = api.signal(true);
      const a = api.signal(1);
      const b = api.signal(2);
      for (let k = 0; k < n; k++) for (const s of [a, b]) api.computed(() => s.get()).get();
      const ts = range(32).map((k) => api.signal(k));
      const c = api.computed(() => {
        let t = 0;
        for (let k = 0; k < 16; k++) t += ts[k].get();
        t += cond.get() ? a.get() : b.get();
        for (let k = 16; k < 32; k++) t += ts[k].get();
        return t & SMI;
      });
      c.get();
      return (i) => (cond.set((i & 1) === 0), c.get());
    },
  },
  "replace-all-k1": {
    sizes: [16, 64, 256, 1024],
    note: "one reader switches between two disjoint sets of N sources, each with 1 other reader",
    build: (api, n) => replaceAll(api, n, 1),
  },
  "replace-all-k3": {
    sizes: [16, 64, 256, 1024],
    note: "one reader switches between two disjoint sets of N sources, each with 3 other readers",
    build: (api, n) => replaceAll(api, n, 3),
  },
  swaps: {
    sizes: [1, 4, 16, 64, 256],
    note: `${L} sources; every other pass swaps N disjoint adjacent pairs, spread over the list`,
    build(api, n) {
      const ps = range(L).map((k) => api.signal(k));
      const plain = range(L);
      const step = Math.floor(L / n);
      return alternating(api, ps, [plain, swapped(plain, range(n).map((k) => k * step))]);
    },
  },
  "swaps-nested": {
    sizes: [1, 2, 3, 4, 8, 32, 128],
    note: `${L} sources; from position 256, a window of 2N is read odd positions first, then even ones`,
    build(api, n) {
      const ps = range(L).map((k) => api.signal(k));
      const plain = range(L);
      const window = range(2 * n).map((k) => 256 + k);
      const odd = window.filter((k) => k & 1), even = window.filter((k) => !(k & 1));
      const nested = [...plain.slice(0, 256), ...odd, ...even, ...plain.slice(256 + 2 * n)];
      return alternating(api, ps, [plain, nested]);
    },
  },
  "move-earlier": {
    sizes: [1, 2, 4, 8, 16, 64, 256],
    note: `${L} sources; every other pass the source at position 512 + N is read at 512`,
    build(api, n) {
      const ps = range(L).map((k) => api.signal(k));
      const plain = range(L);
      return alternating(api, ps, [plain, moved(plain, 512 + n, 512)]);
    },
  },
  "move-later": {
    sizes: [1, 2, 4, 8, 16, 64, 256],
    note: `${L} sources; every other pass the source at position 512 is read N places later`,
    build(api, n) {
      const ps = range(L).map((k) => api.signal(k));
      const plain = range(L);
      return alternating(api, ps, [plain, moved(plain, 512, 512 + n)]);
    },
  },
  "burst-waves": {
    sizes: [256, 1024, 4096, 16384],
    note: "one write reaching N effects, then four writes reaching one effect, per step",
    build(api, n) {
      const big = api.signal(0);
      const small = api.signal(0);
      let out = 0;
      for (let k = 0; k < n; k++) api.effect(() => void (out = (out + big.get()) & SMI));
      api.effect(() => void (out = (out + small.get()) & SMI));
      return (i) => {
        big.set(i);
        for (let k = 1; k <= 4; k++) small.set(i * 4 + k);
        return out;
      };
    },
  },
};

function replaceAll(api, n, others) {
  const cond = api.signal(true);
  const pools = range(2).map((side) => range(n).map((k) => api.signal(side * n + k)));
  for (const pool of pools) for (const s of pool) for (let j = 0; j < others; j++) api.computed(() => s.get()).get();
  const c = api.computed(() => {
    const set = pools[cond.get() ? 0 : 1];
    let t = 0;
    for (let k = 0; k < n; k++) t = (t + set[k].get()) & SMI;
    return t;
  });
  c.get();
  return (i) => (cond.set((i & 1) === 0), c.get());
}

export const scenarios = Object.entries(families).flatMap(([family, f]) =>
  f.sizes.map((n) => ({
    id: `${family}@${n}`,
    group: family,
    family,
    n,
    note: f.note.replaceAll(/\bN\b/g, String(n)),
    setup: (api) => f.build(api, n),
  })),
);
