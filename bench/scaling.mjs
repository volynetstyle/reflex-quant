// Scaling suite: the same scenario families at growing size N, so the report
// shows how each runtime's cost per step grows with load, not just its level.
//
// Every family is a function of N; ids are `<family>@<N>`. Same contract as
// scenarios.mjs (setup outside the measured region, step result checksummed).
// bench/scaling-report.mjs fits the log-log slope of ns/step against N:
// ~0 constant, ~1 linear, ~2 quadratic in N.

export const SIZES = [16, 64, 256, 1024, 4096];

export const range = (n) => Array.from({ length: n }, (_, i) => i);
export const SMI = 0x3fffffff;

export function permutation(n, seed) {
  const order = range(n);
  let s = seed >>> 0 || 1;
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

const sumOf = (nodes, order) => {
  let t = 0;
  for (let i = 0; i < order.length; i++) t = (t + nodes[order[i]].get()) & SMI;
  return t;
};

/** family -> { note, mechanism, build(api, n) -> step } */
export const families = {
  chain: {
    note: "write -> N-deep computed chain -> effect (push + pull depth)",
    build(api, n) {
      const s = api.signal(0);
      let node = s;
      for (let k = 0; k < n; k++) {
        const prev = node;
        node = api.computed(() => prev.get() + 1);
        // Built bottom-up: the first read must not nest N user callbacks.
        node.get();
      }
      let out = 0;
      const leaf = node;
      api.effect(() => void (out = leaf.get()));
      return (i) => (s.set(i), out);
    },
  },
  "chain-cutoff": {
    note: "write marks an N-deep chain; the head cuts off (push + validation, no recompute)",
    build(api, n) {
      const s = api.signal(1);
      let node = api.computed(() => (s.get() > 0 ? 1 : 0));
      for (let k = 0; k < n; k++) {
        const prev = node;
        node = api.computed(() => prev.get() + 1);
        // Built bottom-up: the first read must not nest N user callbacks.
        node.get();
      }
      let runs = 0;
      const leaf = node;
      api.effect(() => void (leaf.get(), runs++));
      return (i) => (s.set(i + 1), runs);
    },
  },
  "fan-out-effects": {
    note: "one write reaches N effects (push width, scheduling)",
    build(api, n) {
      const s = api.signal(0);
      let out = 0;
      for (let k = 0; k < n; k++) api.effect(() => void (out = (out + s.get()) & SMI));
      return (i) => (s.set(i), out);
    },
  },
  "fan-in": {
    note: "one effect sums N signals; one write per step (re-tracking N stable edges)",
    build(api, n) {
      const ps = range(n).map((k) => api.signal(k));
      const order = range(n);
      let out = 0;
      api.effect(() => void (out = sumOf(ps, order)));
      return (i) => (ps[(i * 7) % n].set(-i), out);
    },
  },
  diamond: {
    note: "one source -> N computeds -> one sink computed; write + read sink",
    build(api, n) {
      const s = api.signal(0);
      const cs = range(n).map((k) => api.computed(() => s.get() + k));
      const order = range(n);
      const sink = api.computed(() => sumOf(cs, order));
      sink.get();
      return (i) => (s.set(i & 0xffff), sink.get());
    },
  },
  "validate-wide": {
    note: "N cut-off gates under one sink; one source changes; the sink validates N edges",
    build(api, n) {
      const ps = range(n).map((k) => api.signal(k + 1));
      const gates = ps.map((p) => api.computed(() => (p.get() > 0 ? 1 : 0)));
      const order = range(n);
      const sink = api.computed(() => sumOf(gates, order));
      sink.get();
      return (i) => (ps[i % n].set(i + 1), sink.get());
    },
  },
  "branch-switch": {
    note: "N computeds cond ? a_k : b_k under one effect; toggle cond (N edge swaps)",
    build(api, n) {
      const cond = api.signal(true);
      const a = range(n).map((k) => api.signal(k));
      const b = range(n).map((k) => api.signal(-k));
      const cs = range(n).map((k) => api.computed(() => (cond.get() ? a[k].get() : b[k].get())));
      const order = range(n);
      let out = 0;
      api.effect(() => void (out = sumOf(cs, order)));
      return (i) => (cond.set((i & 1) === 0), out);
    },
  },
  "insert-one": {
    note: "N sources; every other pass inserts one extra source in the middle (local edit)",
    build(api, n) {
      const ps = range(n + 1).map((k) => api.signal(k));
      const half = n >> 1;
      const orders = [range(n), [...range(half), n, ...range(n - half).map((k) => k + half)]];
      const tick = api.signal(0);
      const c = api.computed(() => sumOf(ps, orders[tick.get() & 1]));
      c.get();
      return (i) => (tick.set(i), c.get());
    },
  },
  reverse: {
    note: "N sources read forward, then reversed, alternately (reorder)",
    build(api, n) {
      const ps = range(n).map((k) => api.signal(k));
      const orders = [range(n), range(n).reverse()];
      const tick = api.signal(0);
      const c = api.computed(() => sumOf(ps, orders[tick.get() & 1]));
      c.get();
      return (i) => (tick.set(i), c.get());
    },
  },
  shuffle: {
    note: "N sources read in one of 4 fixed random permutations per pass (chaotic reorder)",
    build(api, n) {
      const ps = range(n).map((k) => api.signal(k));
      const orders = range(4).map((k) => permutation(n, 0x9e3779b9 + k));
      const tick = api.signal(0);
      const c = api.computed(() => sumOf(ps, orders[tick.get() & 3]));
      c.get();
      return (i) => (tick.set(i), c.get());
    },
  },
  "replace-all": {
    note: "N sources, then N other sources, alternately (every relation replaced; the pair of shuffle)",
    build(api, n) {
      const sets = [range(n).map((k) => api.signal(k)), range(n).map((k) => api.signal(n + k))];
      const order = range(n);
      const tick = api.signal(0);
      const c = api.computed(() => sumOf(sets[tick.get() & 1], order));
      c.get();
      return (i) => (tick.set(i), c.get());
    },
  },
  "replace-all-shared": {
    note: "replace-all, but another computed also reads every source (no new relation is proven absent for free)",
    build(api, n) {
      const sets = [range(n).map((k) => api.signal(k)), range(n).map((k) => api.signal(n + k))];
      const order = range(n);
      const other = api.computed(() => (sumOf(sets[0], order) + sumOf(sets[1], order)) & SMI);
      other.get();
      const tick = api.signal(0);
      const c = api.computed(() => sumOf(sets[tick.get() & 1], order));
      c.get();
      return (i) => (tick.set(i), c.get());
    },
  },
  "mount-dispose": {
    note: "mount and dispose N effects over one signal (lifecycle)",
    build(api, n) {
      const s = api.signal(1);
      let out = 0;
      return (i) => {
        const stops = [];
        for (let k = 0; k < n; k++) stops.push(api.effect(() => void (out += s.get())));
        for (let k = 0; k < n; k++) stops[k]();
        return (out + i) & SMI;
      };
    },
  },
};

export const scenarios = Object.entries(families).flatMap(([family, f]) =>
  SIZES.map((n) => ({
    id: `${family}@${n}`,
    group: family,
    family,
    n,
    note: f.note.replaceAll("N", String(n)),
    setup: (api) => f.build(api, n),
  })),
);
