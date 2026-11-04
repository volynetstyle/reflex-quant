// Benchmark scenarios over one neutral API, so quant, Reflex and
// alien-signals run the same program:
//
//   api.signal(v) -> { get(), set(v) }    api.computed(fn) -> { get() }
//   api.effect(fn) -> stop                 api.batch(fn)
//
// `setup(api)` builds the graph outside the measured region and returns
// `step(i)`, one measured operation; its return value is folded into a sink
// and, over the first steps, into a checksum that must agree across runtimes.
// Orders and permutations are precomputed: generating them is not measured.

const range = (n) => Array.from({ length: n }, (_, i) => i);

function permutation(n, seed) {
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
  for (let i = 0; i < order.length; i++) t += nodes[order[i]].get();
  return t;
};

/** A consumer that reads `nodes` in the order `orders[tick % orders.length]`. */
function ordered(api, nodes, orders, tick, salt = 0) {
  return api.computed(() => sumOf(nodes, orders[(tick.get() + salt) % orders.length]));
}

export const scenarios = [
  // ------------------------------------------------------------- static
  {
    id: "static.read-clean",
    group: "static",
    note: "1000 reads of a clean computed outside tracking",
    setup(api) {
      const s = api.signal(3);
      const c = api.computed(() => s.get() * 2);
      c.get();
      return () => {
        let t = 0;
        for (let i = 0; i < 1000; i++) t += c.get();
        return t;
      };
    },
  },
  {
    id: "static.chain-100",
    group: "static",
    note: "write -> 100-deep computed chain -> effect",
    setup(api) {
      const s = api.signal(0);
      let node = s;
      for (let i = 0; i < 100; i++) {
        const prev = node;
        node = api.computed(() => prev.get() + 1);
      }
      let out = 0;
      const leaf = node;
      api.effect(() => void (out = leaf.get()));
      return (i) => (s.set(i), out);
    },
  },
  // ------------------------------------------------------------- stable
  {
    id: "stable.wide-8",
    group: "stable",
    note: "computed re-reads the same 8 sources in order; one write per step",
    setup(api) {
      const ps = range(8).map((i) => api.signal(i));
      const order = range(8);
      const c = api.computed(() => sumOf(ps, order));
      c.get();
      return (i) => (ps[i & 7].set(-i), c.get());
    },
  },
  {
    id: "stable.wide-256",
    group: "stable",
    note: "computed re-reads the same 256 sources in order; one write per step",
    setup(api) {
      const ps = range(256).map((i) => api.signal(i));
      const order = range(256);
      const c = api.computed(() => sumOf(ps, order));
      c.get();
      return (i) => (ps[i & 255].set(-i), c.get());
    },
  },
  // ------------------------------------------------------------ diamond
  {
    id: "diamond.8x8",
    group: "diamond",
    note: "8 layers of 8 nodes, each reading two of the layer above; read the sink",
    setup(api) {
      const s = api.signal(0);
      let layer = range(8).map((k) => api.computed(() => s.get() + k));
      for (let l = 1; l < 8; l++) {
        const prev = layer;
        layer = range(8).map((k) => api.computed(() => prev[k].get() + prev[(k + 1) & 7].get()));
      }
      const last = layer;
      const order = range(8);
      const sink = api.computed(() => sumOf(last, order));
      sink.get();
      return (i) => (s.set(i), sink.get());
    },
  },
  // ------------------------------------------------------------- fan-in
  {
    id: "fan-in.1024",
    group: "fan-in",
    note: "one effect sums 1024 signals; one write per step",
    setup(api) {
      const ps = range(1024).map((i) => api.signal(i));
      const order = range(1024);
      let out = 0;
      api.effect(() => void (out = sumOf(ps, order)));
      return (i) => (ps[(i * 7) & 1023].set(-i), out);
    },
  },
  // ------------------------------------------------------------ fan-out
  {
    id: "fan-out.effects-1000",
    group: "fan-out",
    note: "one signal read by 1000 effects",
    setup(api) {
      const s = api.signal(0);
      let out = 0;
      for (let k = 0; k < 1000; k++) api.effect(() => void (out += s.get()));
      return (i) => (s.set(i), out);
    },
  },
  {
    id: "fan-out.computeds-1000",
    group: "fan-out",
    note: "one signal -> 1000 computeds -> one effect summing them",
    setup(api) {
      const s = api.signal(0);
      const cs = range(1000).map((k) => api.computed(() => s.get() + k));
      const order = range(1000);
      let out = 0;
      api.effect(() => void (out = sumOf(cs, order)));
      return (i) => (s.set(i), out);
    },
  },
  // ------------------------------------------------------------ dynamic
  {
    id: "branch.switch-100",
    group: "branch switch",
    note: "100 computeds cond ? a_k : b_k under one effect; toggle cond",
    setup(api) {
      const cond = api.signal(true);
      const a = range(100).map((k) => api.signal(k));
      const b = range(100).map((k) => api.signal(-k));
      const cs = range(100).map((k) => api.computed(() => (cond.get() ? a[k].get() : b[k].get())));
      const order = range(100);
      let out = 0;
      api.effect(() => void (out = sumOf(cs, order)));
      return (i) => (cond.set((i & 1) === 0), out);
    },
  },
  {
    id: "edit.insert-one-256",
    group: "local edit",
    note: "256 sources; every other pass inserts one extra source at position 128",
    setup(api) {
      const ps = range(257).map((i) => api.signal(i));
      const plain = range(256);
      const edited = [...range(128), 256, ...range(128).map((k) => k + 128)];
      const tick = api.signal(0);
      const c = ordered(api, ps, [plain, edited], tick);
      c.get();
      return (i) => (tick.set(i), c.get());
    },
  },
  {
    id: "reorder.reverse-8",
    group: "reorder",
    note: "8 sources read forward, then backward, alternating per pass",
    setup(api) {
      const ps = range(8).map((i) => api.signal(i));
      const tick = api.signal(0);
      const c = ordered(api, ps, [range(8), range(8).reverse()], tick);
      c.get();
      return (i) => (tick.set(i), c.get());
    },
  },
  {
    id: "reorder.rotate-256",
    group: "reorder",
    note: "256 sources, the read order rotates by one per pass",
    setup(api) {
      const ps = range(256).map((i) => api.signal(i));
      const orders = range(256).map((r) => range(256).map((k) => (k + r) & 255));
      const tick = api.signal(0);
      const c = ordered(api, ps, orders, tick);
      c.get();
      return (i) => (tick.set(i), c.get());
    },
  },
  {
    id: "value-sort.256x32",
    group: "value-sort",
    note: "32 consumers read 256 sources in one shared value-sorted order; each step swaps two adjacent ranks",
    setup(api) {
      const n = 256;
      const ps = range(n).map((i) => api.signal(i));
      // ranks[k] = source at rank k; a step swaps two neighbours' values, so
      // the sorted order changes in two positions (a realistic re-sort).
      const orders = [];
      let ranks = range(n);
      for (let k = 0; k < 64; k++) {
        ranks = [...ranks];
        const at = (k * 37) % (n - 1);
        [ranks[at], ranks[at + 1]] = [ranks[at + 1], ranks[at]];
        orders.push(ranks);
      }
      const tick = api.signal(0);
      const cs = range(32).map(() => ordered(api, ps, orders, tick));
      cs.forEach((c) => c.get());
      return (i) => {
        tick.set(i);
        let t = 0;
        for (const c of cs) t += c.get();
        return t;
      };
    },
  },
  {
    id: "replace-half.256",
    group: "replace-half",
    note: "256 sources per pass: 128 fixed, 128 alternating between two disjoint pools",
    setup(api) {
      const ps = range(384).map((i) => api.signal(i));
      const even = range(256);
      const odd = [...range(128), ...range(128).map((k) => k + 256)];
      const tick = api.signal(0);
      const c = ordered(api, ps, [even, odd], tick);
      c.get();
      return (i) => (tick.set(i), c.get());
    },
  },
  {
    id: "shared-chaotic.64x32",
    group: "shared chaotic",
    note: "32 consumers over the same 64 sources, each its own random permutation per pass",
    setup(api) {
      const ps = range(64).map((i) => api.signal(i));
      const orders = range(16).map((k) => permutation(64, 0x9e3779b9 + k));
      const tick = api.signal(0);
      const cs = range(32).map((j) => ordered(api, ps, orders, tick, j));
      cs.forEach((c) => c.get());
      return (i) => {
        tick.set(i);
        let t = 0;
        for (const c of cs) t += c.get();
        return t;
      };
    },
  },
  {
    id: "long-reorder.256",
    group: "long reorder",
    note: "one consumer, a uniform random permutation of 256 sources per pass (hostile)",
    setup(api) {
      const ps = range(256).map((i) => api.signal(i));
      const orders = range(16).map((k) => permutation(256, 1234 + k));
      const tick = api.signal(0);
      const c = ordered(api, ps, orders, tick);
      c.get();
      return (i) => (tick.set(i), c.get());
    },
  },
  // ------------------------------------------------------- effects/host
  {
    id: "batch.writes-32",
    group: "batch",
    note: "32 writes in one batch, one effect reading all 32",
    setup(api) {
      const ps = range(32).map((i) => api.signal(i));
      const order = range(32);
      let out = 0;
      api.effect(() => void (out = sumOf(ps, order)));
      return (i) => {
        api.batch(() => {
          for (let k = 0; k < 32; k++) ps[k].set(i + k);
        });
        return out;
      };
    },
  },
  {
    id: "lifecycle.mount-100",
    group: "lifecycle",
    note: "create 100 effects reading 4 shared signals, then dispose them",
    setup(api) {
      const ps = range(4).map((i) => api.signal(i));
      const order = range(4);
      return () => {
        let out = 0;
        const stops = [];
        for (let k = 0; k < 100; k++) stops.push(api.effect(() => void (out += sumOf(ps, order))));
        for (const stop of stops) stop();
        return out;
      };
    },
  },
];
