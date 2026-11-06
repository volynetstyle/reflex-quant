// Cost-model probes (suite "cost"; driven by bench/cost/run.mjs). Each probe
// asks where the CPU bills for one part of the architecture, with the same
// step contract as the other suites: setup outside the measured region,
// `step(i)` measured, its result folded into a checksum.
//
//   regime.*   shuffle / reverse at finer N (512..8192): does cost per N
//              jump while the structural work per N stays flat?
//   layout.*   the same shuffle program, the same code, different placement
//              of nodes and edges in the heap (see layoutShuffle)
//   decompose.* quant only (quant-internals bundle): one shuffle pass split
//              into reads, index + unindex, slot lookups, list moves
//   leaf.*     get / set split into stages (A: bare field ... E: public API),
//              next to the bench adapters and alien-signals
//   lb.*       reverse / shuffle / insert-one for the lower-bound variants of
//              quant (bench/cost/build.mjs): what each constant-factor
//              mechanism costs on these workloads
import { families, permutation, range, SMI } from "../scaling.mjs";

export const REGIME_SIZES = [512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192];
export const LAYOUT_SIZES = [1024, 2048, 4096, 8192];
export const DECOMPOSE_SIZES = [256, 1024, 4096];
export const LOWER_SIZES = [256, 1024, 4096];
/** Operations per step of a leaf probe. */
export const OPS = 1000;

const sized = (prefix, sizes, build, extra = {}) =>
  sizes.map((n) => ({ id: `${prefix}@${n}`, n, ...extra, setup: (api) => build(api, n) }));

// ------------------------------------------------------------------ layout

/** Written by the churn loop so the allocations escape and really happen. */
let escaped = null;

/**
 * Shuffle whose code is identical in every variant; only object placement
 * differs. `pad` retained objects follow each signal and each edge of the
 * first pass (scattered); `churn` rounds of short-lived allocation after the
 * build make the graph survive scavenges, so it is copied in the collector's
 * order before promotion (scavenged).
 */
function layoutShuffle(api, n, { pad = 0, churn = 0 } = {}) {
  const keep = [];
  const junk = () => {
    for (let k = 0; k < pad; k++) keep.push({ a: 0, b: null, c: 0, d: null, e: 0, f: null, g: 0, h: null });
  };
  const ps = [];
  for (let k = 0; k < n; k++) {
    ps.push(api.signal(k));
    junk();
  }
  const orders = range(4).map((k) => permutation(n, 0x9e3779b9 + k));
  const tick = api.signal(0);
  let building = true;
  const c = api.computed(() => {
    const order = orders[tick.get() & 3];
    let t = 0;
    for (let i = 0; i < order.length; i++) {
      t = (t + ps[order[i]].get()) & SMI;
      if (building) junk();
    }
    return t;
  });
  c.get();
  building = false;
  for (let r = 0; r < churn; r++) for (let k = 0; k < 1 << 20; k++) escaped = { k, r };
  escaped = null;
  return (i) => (tick.set(i), c.get() + (keep.length & 0));
}

// --------------------------------------------------------------- decompose

/** The shuffle program on raw handles (quant-internals). */
function rawShuffle(q, n) {
  const { computed, get, signal } = q;
  const ps = range(n).map((k) => signal(k));
  const orders = range(4).map((k) => permutation(n, 0x9e3779b9 + k));
  const tick = signal(0);
  const c = computed(() => {
    const order = orders[get(tick) & 3];
    let t = 0;
    for (let k = 0; k < order.length; k++) t = (t + get(ps[order[k]])) & SMI;
    return t;
  });
  get(c);
  return { ps, orders, tick, c };
}

const decompose = {
  /** The real pass: write, then a tracked re-evaluation that reorders N edges. */
  full(q, n) {
    const { tick, c } = rawShuffle(q, n);
    const { get, set } = q;
    return (i) => (set(tick, i), get(c));
  },
  /** The body alone: N untracked reads in the same order (peek). */
  reads(q, n) {
    const { ps, orders } = rawShuffle(q, n);
    const { peek } = q;
    return (i) => {
      const order = orders[i & 3];
      let t = 0;
      for (let k = 0; k < order.length; k++) t = (t + peek(ps[order[k]])) & SMI;
      return t;
    };
  },
  /** index(c) then a replica of unindex: two walks of the source set. */
  index(q, n) {
    const { c } = rawShuffle(q, n);
    const { index, clearIndex } = q;
    return (i) => {
      index(c, c.deps);
      clearIndex(c);
      return i & 1;
    };
  },
  /** N slot hits in read order, slots prepared once: load, compare, store. */
  lookup(q, n) {
    const { ps, orders, c } = rawShuffle(q, n);
    q.index(c, null);
    return (i) => {
      const order = orders[i & 3];
      let t = 0;
      for (let k = 0; k < order.length; k++) {
        const s = ps[order[k]];
        const cell = s.slot;
        if (cell.to === c) {
          cell.ver = s.ver;
          t++;
        }
      }
      return t;
    };
  },
  /** Relink the list into the next order with known edges: cursor + move only. */
  move(q, n) {
    const { ps, orders, c } = rawShuffle(q, n);
    const { move } = q;
    const edgeOf = new Map();
    for (let e = c.deps; e !== null; e = e.next) edgeOf.set(e.from, e);
    const seqs = orders.map((order) => order.map((k) => edgeOf.get(ps[k])));
    return (i) => {
      const seq = seqs[i & 3];
      let last = null;
      for (let k = 0; k < seq.length; k++) {
        const e = seq[k];
        const next = last === null ? c.deps : last.next;
        if (next !== e) move(c, e, last, next);
        last = e;
      }
      return c.deps.from.value;
    };
  },
  /** Slot lookup and move together: the indexed branch of a miss, without the call. */
  "lookup-move"(q, n) {
    const { ps, orders, c } = rawShuffle(q, n);
    const { move } = q;
    q.index(c, null);
    return (i) => {
      const order = orders[i & 3];
      let last = null;
      for (let k = 0; k < order.length; k++) {
        const s = ps[order[k]];
        const cell = s.slot;
        cell.ver = s.ver;
        const next = last === null ? c.deps : last.next;
        if (next !== cell) move(c, cell, last, next);
        last = cell;
      }
      return c.deps.from.value;
    };
  },
  // The marked pass (LOG 28): no slots; a walk over edges marks them, and a
  // read finds its pair as the source's first subscriber.
  /** The mark walk alone: UNREAD on every edge, in list order (edges only). */
  mark(q, n) {
    const { c } = rawShuffle(q, n);
    const { UNREAD } = q;
    return (i) => {
      for (let e = c.deps; e !== null; e = e.next) e.ver = UNREAD;
      return i & 1;
    };
  },
  /** N lookups through the subscribers in read order: the first one is the pair. */
  subs(q, n) {
    const { ps, orders, c } = rawShuffle(q, n);
    return (i) => {
      const order = orders[i & 3];
      let t = 0;
      for (let k = 0; k < order.length; k++) {
        const s = ps[order[k]];
        const e = s.subs;
        if (e.to === c) {
          e.ver = s.ver;
          t++;
        }
      }
      return t;
    };
  },
  /** Subscriber lookup and move together: the marked branch of a miss, without the call. */
  "subs-move"(q, n) {
    const { ps, orders, c } = rawShuffle(q, n);
    const { move } = q;
    return (i) => {
      const order = orders[i & 3];
      let last = null;
      for (let k = 0; k < order.length; k++) {
        const s = ps[order[k]];
        const e = s.subs;
        e.ver = s.ver;
        const next = last === null ? c.deps : last.next;
        if (next !== e) move(c, e, last, next);
        last = e;
      }
      return c.deps.from.value;
    };
  },
};

// -------------------------------------------------------------------- leaf

/** Stand-in for the kernel's private `active` register (stage C). */
let active = null;

const loopRead = (fn) => () => {
  let t = 0;
  for (let k = 0; k < OPS; k++) t = (t + fn()) & SMI;
  return t;
};

const leaf = {
  // ---- read: quant stages on a raw signal node (quant-internals)
  "read.A-value": (q) => {
    const n = q.signal(3);
    return loopRead(() => n.value);
  },
  "read.B-flags": (q) => {
    const n = q.signal(3);
    const M = q.PULL_FLAGS;
    return loopRead(() => ((n.flags & M) !== 0 ? -1 : n.value));
  },
  "read.C-active": (q) => {
    const n = q.signal(3);
    const M = q.PULL_FLAGS;
    return loopRead(() => ((n.flags & M) !== 0 || active !== null ? -1 : n.value));
  },
  "read.D-kernel": (q) => {
    const n = q.signal(3);
    const { read } = q;
    return loopRead(() => read(n));
  },
  "read.E-get": (q) => {
    const n = q.signal(3);
    const { get } = q;
    return loopRead(() => get(n));
  },
  // ---- read: through the neutral bench adapter (quant, reflex, alien bundles)
  "read.adapter": (api) => {
    const s = api.signal(3);
    return loopRead(() => s.get());
  },
  // ---- read: alien's signal function called directly (alien bundle)
  "read.bare": (api) => {
    const g = api.signal(3).get;
    return loopRead(() => g());
  },

  // ---- write: quant stages on a raw signal node with no subscribers
  "write.A-is": (q) => {
    const n = q.signal(0);
    return (i) => {
      for (let k = 0; k < OPS; k++) {
        const v = i * OPS + k;
        if (!Object.is(n.value, v)) n.value = v;
      }
      return n.value;
    };
  },
  "write.B-version": (q) => {
    const n = q.signal(0);
    const M = q.VERSION_MASK;
    return (i) => {
      for (let k = 0; k < OPS; k++) {
        const v = i * OPS + k;
        if (!Object.is(n.value, v)) {
          n.value = v;
          n.ver = (n.ver + 1) & M;
        }
      }
      return n.value;
    };
  },
  "write.C-subs": (q) => {
    const n = q.signal(0);
    const M = q.VERSION_MASK;
    return (i) => {
      let t = 0;
      for (let k = 0; k < OPS; k++) {
        const v = i * OPS + k;
        if (!Object.is(n.value, v)) {
          n.value = v;
          n.ver = (n.ver + 1) & M;
          for (let e = n.subs; e !== null; e = e.nextSub) t++;
        }
      }
      return n.value + t;
    };
  },
  "write.D-kernel": (q) => {
    const n = q.signal(0);
    const { write } = q;
    return (i) => {
      for (let k = 0; k < OPS; k++) write(n, i * OPS + k);
      return n.value;
    };
  },
  "write.E-set": (q) => {
    const n = q.signal(0);
    const { set } = q;
    return (i) => {
      for (let k = 0; k < OPS; k++) set(n, i * OPS + k);
      return n.value;
    };
  },
  "write.adapter": (api) => {
    const s = api.signal(0);
    return (i) => {
      for (let k = 0; k < OPS; k++) s.set(i * OPS + k);
      return s.get();
    };
  },
  "write.bare": (api) => {
    const ref = api.signal(0);
    const g = ref.set;
    return (i) => {
      for (let k = 0; k < OPS; k++) g(i * OPS + k);
      return ref.get();
    };
  },
};

// ------------------------------------------------------------------- suite

export const scenarios = [
  ...sized("regime.shuffle", REGIME_SIZES, (api, n) => families.shuffle.build(api, n)),
  ...sized("regime.reverse", REGIME_SIZES, (api, n) => families.reverse.build(api, n)),
  ...sized("layout.control", LAYOUT_SIZES, (api, n) => layoutShuffle(api, n)),
  ...sized("layout.scattered", LAYOUT_SIZES, (api, n) => layoutShuffle(api, n, { pad: 2 })),
  ...sized("layout.scavenged", LAYOUT_SIZES, (api, n) => layoutShuffle(api, n, { churn: 4 })),
  ...Object.entries(decompose).flatMap(([phase, build]) => sized(`decompose.${phase}`, DECOMPOSE_SIZES, build)),
  ...Object.entries(leaf).map(([stage, build]) => ({ id: `leaf.${stage}`, ops: OPS, setup: (api) => build(api) })),
  ...["reverse", "shuffle", "insert-one"].flatMap((f) => sized(`lb.${f}`, LOWER_SIZES, (api, n) => families[f].build(api, n))),
];
