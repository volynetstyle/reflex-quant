import { Flag, KEEP, TRIM } from "../src/graph";
// Level 1, complexity class: structural work bounds that are not semantics.
// Each assertion pins an optimization (O1, O2) or an asymptotic property;
// removing the mechanism keeps every value correct and fails here.
import { beforeEach, describe, expect, it } from "vitest";
import { idle, createNode, read, stackHighWater, stackLength, stats, write } from "../src/kernel";
import type { Node } from "../src/graph";
import { checkGraph, edgeCount, resetStats } from "./support/graph";
import { queueLength, run } from "../src/host";
import { batch as publicBatch, dispose as publicDispose, effect as publicEffect, get as publicGet, set as publicSet, signal as publicSignal } from "../src/index";
import { foundRepeat, prefixRepeat } from "./support/p5";

const signal = (v: unknown) => createNode(null, v, 0);
const computed = (fn: (prev: unknown) => unknown) => createNode(fn, undefined, Flag.Dirty);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function reader(ps: Node[], orders: number[][], tick: Node) {
  return computed(() => {
    const order = orders[(read(tick) as number) % orders.length]!;
    let s = 0;
    for (const i of order) s += read(ps[i]!) as number;
    return s;
  });
}

beforeEach(resetStats);

describe("structural bounds", () => {
  it("stable graph: no allocation and no lookup per read after warm-up", () => {
    const ps = range(64).map(signal);
    const c = computed(() => ps.reduce((s, p) => s + (read(p) as number), 0));
    read(c);
    resetStats();
    for (let i = 0; i < 100; i++) {
      write(ps[i % 64]!, -i - 1);
      read(c);
    }
    expect(stats.reads).toBe(6400);
    expect(stats.hits).toBe(6400);
    expect([stats.links, stats.lookups, stats.indexed, stats.unlinks]).toEqual([0, 0, 0, 0]);
  });

  it("O2: a direct write executes the computed without a validation walk", () => {
    const ps = range(256).map(signal);
    const c = computed(() => ps.reduce((s, p) => s + (read(p) as number), 0));
    read(c);
    resetStats();
    write(ps[200]!, -1);
    read(c);
    expect(stats.checks).toBe(0);
    expect(stats.runs).toBe(1);
  });

  it("WOKEN: a signal write runs its watcher without the universal validation", () => {
    const ps = range(512).map(signal);
    let runs = 0;
    const w = createNode(() => {
      runs++;
      for (const p of ps) read(p);
    }, undefined, 16 | 1 | Flag.Dirty);
    run(w);
    resetStats();
    write(ps[300]!, -1);
    run(w);
    expect(runs).toBe(2);
    expect(stats.checks).toBe(0);
  });

  it("O1: rotation and adjacent swaps are resolved without indexing", () => {
    const n = 256;
    const ps = range(n).map(signal);
    range(10).forEach(() => read(computed(() => ps.reduce((s, p) => s + (read(p) as number), 0)))); // wide fan-out
    const tick = signal(0);
    const rotate = reader(ps, range(n).map((r) => range(n).map((k) => (k + r) % n)), tick);
    const swapped = [...range(n)];
    [swapped[100], swapped[101]] = [swapped[101]!, swapped[100]!];
    const swap = reader(ps, [range(n), swapped], tick);
    read(rotate);
    read(swap);
    resetStats();
    for (let t = 1; t < 50; t++) {
      write(tick, t);
      read(rotate);
      read(swap);
    }
    expect(stats.indexes).toBe(0);
    expect(stats.links).toBe(0);
    expect(edgeCount([rotate, swap])).toBe(2 * (n + 1));
  });

  it("O1: new private sources are proven absent without indexing", () => {
    const cond = signal(true);
    const a = range(100).map(signal);
    const b = range(100).map(signal);
    const cs = range(100).map((k) => computed(() => (read(cond) ? read(a[k]!) : read(b[k]!))));
    cs.forEach(read);
    resetStats();
    for (let t = 0; t < 20; t++) {
      write(cond, t % 2 === 1);
      cs.forEach(read);
    }
    expect(stats.indexes).toBe(0);
    expect(stats.links).toBe(20 * 100);
    expect(stats.unlinks).toBe(20 * 100);
  });

  it("O1: sources with a few other subscribers are proven absent without indexing", () => {
    const cond = signal(true);
    const a = range(50).map(signal);
    const b = range(50).map(signal);
    [...a, ...b].forEach((p) => read(computed(() => read(p)))); // one other subscriber each
    const tail = range(20).map(signal); // a long list, so neither scan is complete
    const cs = range(50).map((k) =>
      computed(() => {
        let s = (read(cond) ? read(a[k]!) : read(b[k]!)) as number;
        for (const t of tail) s += read(t) as number;
        return s;
      }),
    );
    cs.forEach(read);
    resetStats();
    for (let t = 0; t < 10; t++) {
      write(cond, t % 2 === 1);
      cs.forEach(read);
    }
    expect(stats.indexes).toBe(0);
    expect(stats.links).toBe(10 * 50);
  });

  it("LOG 22: a source nobody reads is linked without a scan's proof or a lookup", () => {
    // The reader's list is longer than the scan budget on both sides of the
    // fresh read, so only `subs === null` proves absence at once.
    const n = 24;
    const ps = range(n).map(signal);
    const fresh = signal(-1);
    const tick = signal(0);
    const plain = range(n);
    const edited = [...range(n / 2), n, ...range(n / 2).map((k) => k + n / 2)];
    const c = reader([...ps, fresh], [plain, edited], tick);
    read(c);
    resetStats();
    write(tick, 1);
    read(c);
    expect(stats.links).toBe(1);
    expect(stats.lookups).toBe(0);
  });

  it("LOG 28: a single reader's random reorder marks its pass, with no slot index", () => {
    const n = 128;
    const ps = range(n).map(signal);
    const orders = range(8).map((k) => {
      const o = range(n);
      let s = 7 + k;
      for (let i = n - 1; i > 0; i--) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const j = s % (i + 1);
        [o[i], o[j]] = [o[j]!, o[i]!];
      }
      return o;
    });
    const tick = signal(0);
    const c = reader(ps, orders, tick);
    read(c);
    resetStats();
    for (let t = 1; t <= 40; t++) {
      write(tick, t);
      read(c);
    }
    expect(stats.links).toBe(0);
    expect(stats.sweeps).toBe(40);
    expect(stats.indexes).toBe(0);
  });

  it("a fresh source needs no lookup after the pass has marked its unread suffix", () => {
    const width = 64;
    const ps = range(width).map(signal);
    const fresh = signal(1000);
    const tick = signal(0);
    // The middle source first: no bounded scan of the reader's list finds
    // it, so the pass marks at once; the first source last, so no read before
    // it meets the cursor.
    const half = width / 2;
    const scattered = [half, ...range(width - half - 1).map((i) => width - 1 - i), ...range(half).map((i) => half - 1 - i)];
    const c = computed(() => {
      const reorder = read(tick) !== 0;
      let sum = 0;
      for (let i = 0; i < width; i++) {
        sum += read(ps[reorder ? scattered[i]! : i]!) as number;
        if (reorder && i === half) sum += read(fresh) as number;
      }
      return sum;
    });
    read(c);
    write(tick, 1);
    resetStats();
    expect(read(c)).toBe(width * (width - 1) / 2 + 1000);
    // Only the reordered old relations need pair lookups. The fresh read is
    // proven absent from its already loaded subscriber head, even mid-sweep.
    expect(stats.lookups).toBe(width - 1);
    expect([stats.links, stats.sweeps, stats.indexes]).toEqual([1, 1, 0]);
    expect(edgeCount([c])).toBe(width + 2);
    checkGraph([c]);
    expect(idle()).toBe(true);
  });

  it("LOG 29: over shared sources, the first reader marks its pass and deeper readers index", () => {
    const n = 64;
    const ps = range(n).map(signal);
    const orders = range(8).map((k) => {
      const o = range(n);
      let s = 31 + k;
      for (let i = n - 1; i > 0; i--) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const j = s % (i + 1);
        [o[i], o[j]] = [o[j]!, o[i]!];
      }
      return o;
    });
    const tick = signal(0);
    // Three readers subscribed in order: the first is every source's first subscriber.
    const cs = range(3).map(() => reader(ps, orders, tick));
    cs.forEach(read);
    resetStats();
    for (let t = 1; t <= 20; t++) {
      write(tick, t);
      cs.forEach(read);
    }
    expect(stats.links).toBe(0);
    expect(stats.sweeps).toBe(20);
    expect(stats.indexes).toBe(20 * 2);
  });

  it("P5 witnesses reach the prefix-scan, subscriber and slot repeat paths", () => {
    // The semantic test (semantics.test.ts, P5) relies on these programs
    // exercising each path that recognises a repeated read.
    const c = prefixRepeat();
    resetStats();
    publicGet(c);
    expect([stats.dups, stats.sweeps, stats.indexes]).toEqual([1, 0, 0]);
    for (const indexed of [false, true]) {
      const w = foundRepeat(indexed);
      publicGet(w.c);
      publicSet(w.tick, 1);
      resetStats();
      publicGet(w.c);
      expect([stats.dups, stats.sweeps, stats.indexes]).toEqual(indexed ? [1, 0, 1] : [1, 1, 0]);
    }
  });

  it.each([false, true])("reverse retries keep mixed committed and tentative relations linear (shared: %s)", (shared) => {
    for (const width of [64, 128, 256]) {
      const committed = range(width).map(signal);
      const tentative = range(width).map((i) => signal(width + i));
      if (shared) read(computed(() => [...committed, ...tentative].forEach(read)));
      const tick = signal(0);
      const c = computed(() => {
        const phase = read(tick);
        const sources = phase === 0 ? committed
          : phase === 1 ? tentative
          : phase === 2 ? [...committed, ...tentative].reverse()
          : [...committed].reverse();
        let sum = 0;
        for (const s of sources) sum += read(s) as number;
        if (phase === 1 || phase === 2) throw new Error("retry");
        return sum;
      });
      expect(read(c)).toBe(width * (width - 1) / 2);
      write(tick, 1);
      expect(() => read(c)).toThrow("retry");
      expect(edgeCount([c])).toBe(2 * width + 1);
      write(tick, 2);
      resetStats();
      expect(() => read(c)).toThrow("retry");
      expect(stats.links).toBe(0);
      expect(stats.sweeps + stats.indexes).toBe(1);
      expect(stats.indexed).toBeLessThanOrEqual(2 * width + 1);
      expect(stats.lookups).toBeLessThanOrEqual(2 * (2 * width + 1));
      checkGraph([c]);
      write(tick, 3);
      expect(read(c)).toBe(width * (width - 1) / 2);
      expect(edgeCount([c])).toBe(width + 1);
      expect(tentative.every((s) => {
        for (let e = s.firstSub; e !== null; e = e.nextSub) if (e.to === c) return false;
        return true;
      })).toBe(true);
      checkGraph([c]);
      expect(idle()).toBe(true);
    }
  });

  it("O1: a completely scanned reader list proves absence where the subscribers cannot", () => {
    // Each source has more subscribers than the scan budget, so only the new
    // reader's own short list proves that its first reads are new relations.
    const ps = range(4).map(signal);
    range(10).forEach(() => read(computed(() => ps.reduce((s, p) => s + (read(p) as number), 0))));
    resetStats();
    read(computed(() => ps.reduce((s, p) => s + (read(p) as number), 0)));
    expect(stats.links).toBe(4);
    expect(stats.indexes).toBe(0);
  });

  it("random reorder of wide sources: one linear index walk per pass, no allocation", () => {
    const n = 128;
    const ps = range(n).map(signal);
    range(10).forEach(() => read(computed(() => ps.reduce((s, p) => s + (read(p) as number), 0))));
    const orders = range(8).map((k) => {
      const o = range(n);
      let s = 99 + k;
      for (let i = n - 1; i > 0; i--) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const j = s % (i + 1);
        [o[i], o[j]] = [o[j]!, o[i]!];
      }
      return o;
    });
    const tick = signal(0);
    const c = reader(ps, orders, tick);
    read(c);
    resetStats();
    for (let t = 1; t <= 40; t++) {
      write(tick, t);
      read(c);
    }
    expect(stats.links).toBe(0);
    expect(stats.indexes).toBe(40);
    expect(stats.indexed).toBe(40 * (n + 1));
  });
});

describe("work stack at rest", () => {
  /** s -> c0 -> c1 -> ... -> cN, each read as it is built (no recursion); with leaves, ci also feeds a computed born after c(i+1). */
  function chain(n: number, leaves: boolean) {
    const s = signal(0);
    const nodes = [computed(() => read(s))];
    read(nodes[0]!);
    for (let i = 0; i < n; i++) {
      const p = nodes[i]!;
      const c = computed(() => (read(p) as number) + 1);
      read(c);
      nodes.push(c);
      if (leaves) read(computed(() => read(p)));
    }
    return { s, end: nodes[n]! };
  }

  it("the end of a deep outermost validation cuts the stack back to KEEP", () => {
    const { s, end } = chain(2000, false);
    write(s, 1);
    expect(read(end)).toBe(2001);
    expect(stackLength()).toBe(KEEP);
    expect(stackHighWater()).toBeGreaterThan(TRIM);
    expect(idle()).toBe(true);
  });

  it("a stack a deep mark grew is cut before the write returns", () => {
    // Every ci has a pending sibling (its leaf) while mark descends to c(i+1).
    const { s, end } = chain(2000, true);
    write(s, 1);
    expect(stackLength()).toBe(KEEP);
    expect(read(end)).toBe(2001);
    expect(stackLength()).toBe(KEEP);
  });

  it("a validation no deeper than TRIM leaves the stack as it is", () => {
    const { s, end } = chain(400, false);
    write(s, 1);
    expect(read(end)).toBe(401);
    const length = stackLength();
    expect(length).toBeGreaterThan(KEEP);
    expect(length).toBeLessThanOrEqual(TRIM);
    write(s, 2);
    read(end);
    expect(stackLength()).toBe(length);
  });
});

describe("S8 host queue capacity", () => {
  // The ring doubles only when full, so it holds max(KEEP, 2W) slots at most
  // with W the watchers queued at once; a delivery takes no slot of its own
  // (LOG 45, LOG 48).
  const bound = (w: number) => Math.max(KEEP, 2 * w);

  it("a long drain holds O(queued watchers) slots, not O(deliveries)", () => {
    // One watcher invalidates itself N times in one drain (W2): one watcher
    // is queued at any time, but every delivery used to take a fresh slot.
    const N = 100_000;
    const s = publicSignal(0);
    let peakLength = 0;
    publicEffect(() => {
      const v = publicGet(s);
      const length = queueLength();
      if (length > peakLength) peakLength = length;
      if (v < N) publicSet(s, v + 1);
    });
    expect(publicGet(s)).toBe(N);
    expect(peakLength).toBeLessThanOrEqual(bound(1));
    expect(queueLength()).toBeLessThanOrEqual(KEEP);
  });

  it("many watchers invalidating themselves stay within max(KEEP, 2W)", () => {
    const W = 4 * TRIM;
    const rounds = 40;
    const sources = range(W).map(() => publicSignal(0));
    let peakLength = 0;
    const effects = publicBatch(() =>
      sources.map((s) =>
        publicEffect(() => {
          const v = publicGet(s);
          const length = queueLength();
          if (length > peakLength) peakLength = length;
          if (v < rounds) publicSet(s, v + 1);
        }),
      ),
    );
    for (const s of sources) expect(publicGet(s)).toBe(rounds);
    expect(peakLength).toBeGreaterThanOrEqual(W);
    expect(peakLength).toBeLessThanOrEqual(bound(W));
    expect(queueLength()).toBeLessThanOrEqual(bound(W));
    for (const e of effects) publicDispose(e);
  });

  it("a steady wave keeps its ring; a burst is given back by the next small drain", () => {
    const s = publicSignal(0);
    const small = publicSignal(0);
    publicEffect(() => void publicGet(small));
    const effects = publicBatch(() => range(4 * TRIM).map(() => publicEffect(() => void publicGet(s))));
    const ring = queueLength();
    expect(ring).toBeGreaterThanOrEqual(4 * TRIM);
    expect(ring).toBeLessThanOrEqual(bound(4 * TRIM));
    for (let i = 1; i <= 3; i++) {
      publicSet(s, i);
      expect(queueLength()).toBe(ring);
    }
    publicSet(small, 1);
    expect(queueLength()).toBeLessThanOrEqual(KEEP);
    for (const e of effects) publicDispose(e);
  });
});
