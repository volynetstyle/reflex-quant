// Mechanism-by-mechanism scenarios: each step exercises one mechanism of the
// runtime as directly as the neutral API allows, so quant, Reflex and
// alien-signals are compared operation by operation, not graph by graph.
//
// Same contract as scenarios.mjs: `setup(api)` builds outside the measured
// region and returns `step(i)`; its result feeds the cross-runtime checksum.
// The id prefix names the mechanism (`--only '^push\.'` selects one).
//
//   read.*       reads outside tracking (no edge work)
//   write.*      source writes with no or cut-off propagation
//   track.*      dependency tracking inside an evaluation: edge reuse,
//                duplicate reads, edge replacement
//   push.*       invalidation propagation; consumers are trivial
//   pull.*       lazy validation and recomputation on read
//   effect.*     effect scheduling and re-run
//   batch.*      write coalescing
//   lifecycle.*  node creation and disposal
//
// A public API cannot run push without pull or vice versa; where both occur,
// the scenario is shaped so that the named mechanism dominates the step.

const range = (n) => Array.from({ length: n }, (_, i) => i);
const N = 1000;

export const scenarios = [
  // --------------------------------------------------------------- read
  {
    id: "read.signal",
    group: "read",
    note: `${N} untracked reads of one signal`,
    setup(api) {
      const s = api.signal(3);
      return () => {
        let t = 0;
        for (let k = 0; k < N; k++) t += s.get();
        return t;
      };
    },
  },
  {
    id: "read.computed-clean",
    group: "read",
    note: `${N} untracked reads of one clean computed`,
    setup(api) {
      const s = api.signal(3);
      const c = api.computed(() => s.get() * 2);
      c.get();
      return () => {
        let t = 0;
        for (let k = 0; k < N; k++) t += c.get();
        return t;
      };
    },
  },
  // -------------------------------------------------------------- write
  {
    id: "write.no-subscribers",
    group: "write",
    note: `${N} writes of new values to a signal nobody reads`,
    setup(api) {
      const s = api.signal(0);
      return (i) => {
        for (let k = 0; k < N; k++) s.set(i * N + k);
        return s.get();
      };
    },
  },
  {
    id: "write.same-value",
    group: "write",
    note: `${N} writes of the current value to a signal under an effect (source cut-off)`,
    setup(api) {
      const s = api.signal(7);
      let runs = 0;
      api.effect(() => void (s.get(), runs++));
      return () => {
        for (let k = 0; k < N; k++) s.set(7);
        return runs;
      };
    },
  },
  // -------------------------------------------------------------- track
  {
    id: "track.stable-1",
    group: "track",
    note: "computed re-reads its one source; write + read",
    setup(api) {
      const s = api.signal(0);
      const c = api.computed(() => s.get());
      c.get();
      return (i) => (s.set(i), c.get());
    },
  },
  {
    id: "track.stable-64",
    group: "track",
    note: "computed re-reads the same 64 sources in order (edge reuse); write + read",
    setup(api) {
      const ps = range(64).map((k) => api.signal(k));
      const c = api.computed(() => {
        let t = 0;
        for (let k = 0; k < 64; k++) t += ps[k].get();
        return t;
      });
      c.get();
      return (i) => (ps[i & 63].set(-i), c.get());
    },
  },
  {
    id: "track.duplicate-64",
    group: "track",
    note: "computed reads one source 64 times per evaluation (duplicate-read dedup)",
    setup(api) {
      const s = api.signal(0);
      const c = api.computed(() => {
        let t = 0;
        for (let k = 0; k < 64; k++) t += s.get();
        return t;
      });
      c.get();
      return (i) => (s.set(i & 0xffff), c.get());
    },
  },
  {
    id: "track.swap-1",
    group: "track",
    note: "computed alternates between source a and b: one edge removed, one added",
    setup(api) {
      const cond = api.signal(true);
      const a = api.signal(1);
      const b = api.signal(2);
      const c = api.computed(() => (cond.get() ? a.get() : b.get()));
      c.get();
      return (i) => (cond.set((i & 1) === 0), c.get());
    },
  },
  {
    id: "track.swap-32",
    group: "track",
    note: "computed alternates between two disjoint sets of 32 sources",
    setup(api) {
      const cond = api.signal(true);
      const a = range(32).map((k) => api.signal(k));
      const b = range(32).map((k) => api.signal(-k));
      const c = api.computed(() => {
        const set = cond.get() ? a : b;
        let t = 0;
        for (let k = 0; k < 32; k++) t += set[k].get();
        return t;
      });
      c.get();
      return (i) => (cond.set((i & 1) === 0), c.get());
    },
  },
  {
    id: "track.fresh-after-reorder-64",
    group: "track",
    note: "reverse 64 retained sources, insert 64 newly subscribed sources after the first read, drop the previous set",
    setup(api) {
      const width = 64;
      const tick = api.signal(0);
      const retained = range(width).map((i) => api.signal(i));
      const pools = range(2).map((side) => range(width).map((i) => api.signal(side * width + i)));
      const c = api.computed(() => {
        const reverse = tick.get() & 1;
        const fresh = pools[reverse];
        let sum = 0;
        for (let i = 0; i < width; i++) {
          sum += retained[reverse ? width - i - 1 : i].get();
          if (i === 0) for (const source of fresh) sum += source.get();
        }
        return sum;
      });
      c.get();
      return (i) => (tick.set(i), c.get());
    },
  },
  // --------------------------------------------------------------- push
  {
    id: "push.chain-cutoff-100",
    group: "push",
    note: "write marks a 100-deep chain; the head computed cuts off, nothing below recomputes",
    setup(api) {
      const s = api.signal(1);
      const head = api.computed(() => (s.get() > 0 ? 1 : 0));
      let node = head;
      for (let k = 0; k < 100; k++) {
        const prev = node;
        node = api.computed(() => prev.get() + 1);
      }
      let runs = 0;
      const leaf = node;
      api.effect(() => void (leaf.get(), runs++));
      return (i) => (s.set(i + 1), runs);
    },
  },
  {
    id: "push.effects-1000",
    group: "push",
    note: "one write reaches 1000 effects directly",
    setup(api) {
      const s = api.signal(0);
      let out = 0;
      for (let k = 0; k < N; k++) api.effect(() => void (out = (out + s.get()) & 0x3fffffff));
      return (i) => (s.set(i), out);
    },
  },
  // --------------------------------------------------------------- pull
  {
    id: "pull.recompute-chain-100",
    group: "pull",
    note: "write, then a lazy read recomputes a 100-deep chain (no effects)",
    setup(api) {
      const s = api.signal(0);
      let node = s;
      for (let k = 0; k < 100; k++) {
        const prev = node;
        node = api.computed(() => prev.get() + 1);
      }
      const leaf = node;
      leaf.get();
      return (i) => (s.set(i), leaf.get());
    },
  },
  {
    id: "pull.validate-wide-256",
    group: "pull",
    note: "256 sources behind cut-off computeds; one changes; the sink validates, does not recompute",
    setup(api) {
      const ps = range(256).map((k) => api.signal(k + 1));
      const gates = ps.map((p) => api.computed(() => (p.get() > 0 ? 1 : 0)));
      let runs = 0;
      const sink = api.computed(() => {
        runs++;
        let t = 0;
        for (let k = 0; k < 256; k++) t += gates[k].get();
        return t;
      });
      sink.get();
      return (i) => (ps[i & 255].set(i + 1), sink.get() + runs);
    },
  },
  {
    id: "pull.diamond-1000",
    group: "pull",
    note: "one source, 1000 computeds, one sink computed summing them; write + read sink",
    setup(api) {
      const s = api.signal(0);
      const cs = range(N).map((k) => api.computed(() => s.get() + k));
      const sink = api.computed(() => {
        let t = 0;
        for (let k = 0; k < N; k++) t += cs[k].get();
        return t;
      });
      sink.get();
      return (i) => (s.set(i & 0xffff), sink.get());
    },
  },
  // ------------------------------------------------------------- effect
  {
    id: "effect.rerun-1",
    group: "effect",
    note: "one write re-runs one effect reading one signal (schedule + run)",
    setup(api) {
      const s = api.signal(0);
      let out = 0;
      api.effect(() => void (out = s.get()));
      return (i) => (s.set(i), out);
    },
  },
  {
    id: "effect.through-computed",
    group: "effect",
    note: "signal -> computed -> effect; one write",
    setup(api) {
      const s = api.signal(0);
      const c = api.computed(() => s.get() * 2);
      let out = 0;
      api.effect(() => void (out = c.get()));
      return (i) => (s.set(i), out);
    },
  },
  // -------------------------------------------------------------- batch
  {
    id: "batch.coalesce-64",
    group: "batch",
    note: "64 writes to distinct signals in one batch; one effect over all of them runs once",
    setup(api) {
      const ps = range(64).map((k) => api.signal(k));
      let out = 0;
      let runs = 0;
      api.effect(() => {
        runs++;
        let t = 0;
        for (let k = 0; k < 64; k++) t += ps[k].get();
        out = t;
      });
      return (i) => {
        api.batch(() => {
          for (let k = 0; k < 64; k++) ps[k].set(i + k);
        });
        return out + runs;
      };
    },
  },
  {
    id: "batch.empty",
    group: "batch",
    note: `${N} empty batches`,
    setup(api) {
      let t = 0;
      const body = () => void t++;
      return () => {
        for (let k = 0; k < N; k++) api.batch(body);
        return t & 0x3fffffff;
      };
    },
  },
  // ---------------------------------------------------------- lifecycle
  {
    id: "lifecycle.signal-create",
    group: "lifecycle",
    note: "create 100 signals and read each once",
    setup(api) {
      return (i) => {
        let t = 0;
        for (let k = 0; k < 100; k++) t += api.signal(i + k).get();
        return t;
      };
    },
  },
  {
    id: "lifecycle.computed-create",
    group: "lifecycle",
    note: "create 100 computeds over a fresh signal and read each once",
    setup(api) {
      // A fresh source per step: the step's graph is garbage after it. Over a
      // shared source, its subscriber list grew without bound (computeds are
      // never disposed here) and the step timed the collector, bimodally
      // (4.5..52 µs round medians on every runtime).
      return (i) => {
        const s = api.signal(1);
        let t = 0;
        for (let k = 0; k < 100; k++) t += api.computed(() => s.get() + k).get();
        return t + i;
      };
    },
  },
  {
    id: "lifecycle.effect-mount-dispose",
    group: "lifecycle",
    note: "mount and dispose 100 effects over one signal",
    setup(api) {
      const s = api.signal(1);
      let out = 0;
      return (i) => {
        const stops = [];
        for (let k = 0; k < 100; k++) stops.push(api.effect(() => void (out += s.get())));
        for (let k = 0; k < 100; k++) stops[k]();
        return (out + i) & 0x3fffffff;
      };
    },
  },
];
