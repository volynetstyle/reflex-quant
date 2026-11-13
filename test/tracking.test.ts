import { Flag } from "../src/graph";
// Level 1: adversarial dependency tracking on the kernel. Every case checks
// values, relation uniqueness, list integrity and the work counters.
import { beforeEach, describe, expect, it } from "vitest";
import { idle, createNode, dispose, read, stats, write } from "../src/kernel";
import type { Edge, Node } from "../src/graph";
import { checkGraph, deps, edgeCount, indices, resetStats, subs } from "./support/graph";

const signal = (v: unknown) => createNode(null, v, 0);
const computed = (fn: (prev: unknown) => unknown) => createNode(fn, undefined, Flag.Dirty);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function permutation(n: number, seed: number): number[] {
  const order = range(n);
  let s = seed >>> 0 || 1;
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** A consumer that reads `ps` in the order `order.get()` names; returns the sum. */
function scripted(ps: Node[], order: { get(): number[] }, tick: Node) {
  return computed(() => {
    read(tick);
    let sum = 0;
    for (const i of order.get()) sum += read(ps[i]!) as number;
    return sum;
  });
}

function edges(c: Node): Edge[] {
  const out: Edge[] = [];
  for (let e = c.firstDep; e !== null; e = e.nextDep) out.push(e);
  return out;
}

beforeEach(resetStats);

describe("tracking", () => {
  it("duplicate read A B A keeps one relation per pair", () => {
    const [a, b] = [signal(1), signal(2)];
    const c = computed(() => (read(a) as number) + (read(b) as number) + (read(a) as number));
    expect(read(c)).toBe(4);
    expect(indices(deps(c), [a, b])).toEqual([0, 1]);
    write(a, 10);
    expect(read(c)).toBe(22);
    expect(indices(deps(c), [a, b])).toEqual([0, 1]);
    expect(subs(a).length).toBe(1);
    checkGraph([c]);
    expect(idle()).toBe(true);
  });

  it("A A (immediate repeat) is recognised without indexing", () => {
    const a = signal(1);
    const c = computed(() => (read(a) as number) + (read(a) as number));
    read(c);
    resetStats();
    write(a, 2);
    expect(read(c)).toBe(4);
    expect(stats.repeats).toBe(1);
    expect(stats.indexes).toBe(0);
  });

  it("reorder A B C D E -> E A B C D reuses every relation, allocates none", () => {
    const ps = range(5).map(signal);
    const tick = signal(0);
    let order = [0, 1, 2, 3, 4];
    const c = scripted(ps, { get: () => order }, tick);
    read(c);
    const before = new Set(edges(c));
    resetStats();
    order = [4, 0, 1, 2, 3];
    write(tick, 1);
    expect(read(c)).toBe(10);
    expect(indices(deps(c), [tick, ...ps])).toEqual([0, 5, 1, 2, 3, 4]);
    expect(stats.links).toBe(0);
    expect(stats.unlinks).toBe(0);
    // E is the last edge: found from the end, moved once.
    expect([stats.tails, stats.scans, stats.moves]).toEqual([1, 0, 0]);
    expect(edges(c).every((e) => before.has(e))).toBe(true);
    checkGraph([c]);
  });

  it("a source's first subscriber points back at its last one through every link and unlink", () => {
    // firstSub.prevSub is the tail (link appends there); every other prevSub
    // is the predecessor. A backward walk that stops at firstSub visits each
    // subscriber once; one that waited for null would loop.
    const s = signal(0);
    const cs = range(6).map(() => computed(() => read(s)));
    const live: Node[] = [];
    const ring = () => {
      const forward: Edge[] = [];
      for (let e = s.firstSub; e !== null; e = e.nextSub) forward.push(e);
      expect(forward.map((e) => e.to)).toEqual(live);
      if (s.firstSub === null) return;
      expect(s.firstSub.prevSub).toBe(forward.at(-1));
      const backward: Edge[] = [];
      for (let e = s.firstSub.prevSub!; ; e = e.prevSub!) {
        backward.push(e);
        if (e === s.firstSub) break;
        expect(backward.length).toBeLessThanOrEqual(forward.length);
      }
      expect(backward.reverse()).toEqual(forward);
    };
    ring();
    for (const c of cs) {
      read(c);
      live.push(c);
      ring();
    }
    // A middle one, the first, the last, then the rest.
    for (const c of [cs[2]!, cs[0]!, cs[5]!, cs[1]!, cs[4]!, cs[3]!]) {
      dispose(c);
      live.splice(live.indexOf(c), 1);
      ring();
      for (let e = c.firstDep; e !== null; e = e.nextDep) expect(e.prevSub).toBe(null);
    }
    expect(s.firstSub).toBe(null);
    // Relinking after the list emptied starts a new ring of one.
    const again = computed(() => read(s));
    read(again);
    live.push(again);
    ring();
    expect(s.firstSub!.prevSub).toBe(s.firstSub);
    checkGraph([again]);
    expect(idle()).toBe(true);
  });

  // A skipped edge goes to the end of the list (`near`): a deletion or a
  // rotation leaves every later read on the cursor, and an edge read after
  // all is found from the end. Misses are hits' complement: reads - hits.
  it.each([
    ["rotation by one", range(256), range(256).map((i) => (i + 1) & 255), 1],
    ["one source dropped mid-list", range(256), range(256).filter((i) => i !== 128), 1],
    ["four adjacent sources dropped", range(256), range(256).filter((i) => i < 100 || i >= 104), 4],
    ["one source moved 200 places later", range(256), [...range(256).filter((i) => i !== 20).slice(0, 219), 20, ...range(256).filter((i) => i !== 20).slice(219)], 2],
    ["adjacent swap", range(256), [...range(100), 101, 100, ...range(154).map((i) => i + 102)], 2],
    ["reversal", range(64), range(64).reverse(), 63],
  ])("%s: misses bounded by the edit, not by the list", (_, from, to, misses) => {
    const n = (from as number[]).length;
    const ps = range(n).map(signal);
    const tick = signal(0);
    let order = from as number[];
    const c = scripted(ps, { get: () => order }, tick);
    read(c);
    order = to as number[];
    write(tick, 1);
    resetStats();
    read(c);
    expect(stats.reads - stats.hits).toBe(misses);
    expect([stats.lookups, stats.sweeps, stats.indexes, stats.links]).toEqual([0, 0, 0, 0]);
    expect(indices(deps(c), [tick, ...ps])).toEqual([0, ...(to as number[]).map((i) => i + 1)]);
    checkGraph([c]);
    expect(idle()).toBe(true);
  });

  it("random permutations of 64 shared sources: exact, no allocation, linear work", () => {
    const n = 64;
    const ps = range(n).map(signal);
    const tick = signal(0);
    let pass = 0;
    const orders = range(40).map((k) => permutation(n, 1000 + k));
    // Three consumers over the same sources, each its own permutation per pass.
    const cs = range(3).map((j) => scripted(ps, { get: () => orders[(pass + j) % orders.length]! }, tick));
    cs.forEach(read);
    const identity = cs.map((c) => new Set(edges(c)));
    resetStats();
    for (pass = 1; pass < 40; pass++) {
      write(tick, pass);
      for (const c of cs) {
        expect(read(c)).toBe((n * (n - 1)) / 2);
        expect(indices(deps(c), [tick, ...ps]).slice(1)).toEqual(orders[(pass + cs.indexOf(c)) % orders.length]!.map((i) => i + 1));
      }
    }
    expect(stats.links).toBe(0);
    expect(stats.unlinks).toBe(0);
    // Each pass marks or indexes once and walks at most its list once: O(d), not O(d^2).
    expect(stats.sweeps + stats.indexes).toBe(39 * 3);
    expect(stats.indexed).toBeLessThanOrEqual(39 * 3 * (n + 1));
    cs.forEach((c, j) => expect(edges(c).every((e) => identity[j]!.has(e))).toBe(true));
    for (const p of ps) expect(subs(p).length).toBe(3);
    checkGraph(cs);
    expect(idle()).toBe(true);
  });

  it("branch switch cond ? A : B neither leaks nor loses relations", () => {
    const [cond, a, b] = [signal(true), signal(1), signal(2)];
    const c = computed(() => (read(cond) ? read(a) : read(b)));
    for (let i = 0; i < 50; i++) {
      write(cond, i % 2 === 0);
      expect(read(c)).toBe(i % 2 === 0 ? 1 : 2);
      expect(indices(deps(c), [cond, a, b])).toEqual(i % 2 === 0 ? [0, 1] : [0, 2]);
      expect(subs(a).length + subs(b).length).toBe(1);
    }
    write(cond, true);
    read(c);
    write(b, 99);
    expect(c.flags & 1).toBe(0); // b is no longer a dependency: no invalidation
    checkGraph([c]);
  });

  it("prefix/suffix edits: insert in the middle, drop a prefix", () => {
    const names = ["A", "B", "C", "D", "E", "F", "X"];
    const ps = names.map(signal);
    const tick = signal(0);
    let order = [0, 1, 2, 3, 4, 5];
    const c = scripted(ps, { get: () => order }, tick);
    read(c);
    resetStats();
    order = [0, 1, 6, 2, 3, 4, 5]; // A B X C D E F
    write(tick, 1);
    read(c);
    expect(indices(deps(c), [tick, ...ps])).toEqual([0, 1, 2, 7, 3, 4, 5, 6]);
    expect(stats.links).toBe(1);
    expect(stats.unlinks).toBe(0);
    resetStats();
    order = [2, 3, 4, 5]; // C D E F
    write(tick, 2);
    read(c);
    expect(indices(deps(c), [tick, ...ps])).toEqual([0, 3, 4, 5, 6]);
    expect(stats.links).toBe(0);
    expect(stats.unlinks).toBe(3);
    checkGraph([c]);
  });

  it("duplicate after a long prefix: P0..P127 then P0..P127 P32", () => {
    const ps = range(128).map(signal);
    const tick = signal(0);
    let order = range(128);
    const c = scripted(ps, { get: () => order }, tick);
    read(c);
    order = [...range(128), 32];
    write(tick, 1);
    expect(read(c)).toBe((127 * 128) / 2 + 32);
    expect(edgeCount([c])).toBe(129);
    expect(subs(ps[32]!).length).toBe(1);
    checkGraph([c]);
  });

  it("old twin: a source re-read after nested passes subscribed to it stays unique", () => {
    // The consumer reads H, then a computed whose pass subscribes to H after
    // it, then H again; a "last subscriber" heuristic would miss the twin.
    const h = signal(1);
    const others = range(8).map(signal);
    const tick = signal(0);
    const inner = range(4).map(() => computed(() => (read(h) as number) + (read(others[0]!) as number)));
    const c = computed(() => {
      const t = read(tick) as number;
      let sum = read(h) as number;
      for (const k of inner) sum += read(k) as number;
      for (let i = 0; i < 8; i++) sum += read(others[(i + t) % 8]!) as number;
      return sum + (read(h) as number);
    });
    for (let t = 0; t < 10; t++) {
      write(tick, t);
      write(h, t + 2);
      read(c);
      expect(subs(h).length).toBe(1 + inner.length);
      expect(deps(c).filter((n) => n === h).length).toBe(1);
      checkGraph([c]);
    }
  });

  it("nested passes that index the same sources do not corrupt the outer index", () => {
    const n = 32;
    const ps = range(n).map(signal);
    const tick = signal(0);
    let pass = 0;
    const inner = computed(() => {
      read(tick);
      let s = 0;
      for (const i of permutation(n, 77 + pass)) s += read(ps[i]!) as number;
      return s;
    });
    const outer = computed(() => {
      read(tick);
      let s = 0;
      const order = permutation(n, 5 + pass);
      for (let k = 0; k < n; k++) {
        s += read(ps[order[k]!]!) as number;
        if (k === n >> 1) s += read(inner) as number; // nested indexed pass mid-way
        if (k === n >> 2) s += read(ps[order[0]!]!) as number; // duplicate across the nesting
      }
      return s;
    });
    for (pass = 0; pass < 20; pass++) {
      write(tick, pass);
      write(ps[pass % n]!, pass + 100);
      read(outer);
      expect(edgeCount([outer])).toBe(n + 2);
      expect(new Set(deps(outer)).size).toBe(n + 2);
      checkGraph([outer, inner]);
      expect(idle()).toBe(true);
    }
  });

  it("a nested indexed pass restores the outer pass's cells (re-read after nesting)", () => {
    // Wide sources (more subscribers than the absence scan's budget) force
    // both passes to index. The outer re-reads a source of its prefix after
    // the nested pass indexed and released the same source.
    const n = 12;
    const ps = range(n).map(signal);
    const others = range(10).map(() => computed(() => ps.reduce((s, p) => s + (read(p) as number), 0)));
    others.forEach(read);
    const tick = signal(0);
    const inner = computed(() => {
      const t = read(tick) as number;
      let s = 0;
      for (const i of permutation(n, 300 + t)) s += read(ps[i]!) as number;
      return s;
    });
    const outer = computed(() => {
      const t = read(tick) as number;
      const order = permutation(n, 900 + t);
      let s = 0;
      for (let k = 0; k < n; k++) s += read(ps[order[k]!]!) as number;
      s += read(inner) as number;
      return s + (read(ps[order[0]!]!) as number); // re-read across the nesting
    });
    read(outer);
    resetStats();
    for (let t = 1; t < 12; t++) {
      write(tick, t);
      read(outer);
      expect(edgeCount([outer])).toBe(n + 2);
      checkGraph([outer, inner, ...others]);
      expect(idle()).toBe(true);
    }
    expect(stats.indexes).toBeGreaterThan(0);
    expect(stats.links).toBe(0);
  });

  it("failure halfway: committed ∪ attempt reads survive, nothing accumulates", () => {
    const [a, b, cc, d, x, y, z] = range(7).map(signal);
    const mode = signal(0);
    const all = [a, b, cc, d, x, y, z, mode] as Node[];
    // mode 0: A B C D (ok); mode k>0: A X Y, then throw after k reads.
    const c = computed(() => {
      const m = read(mode) as number;
      if (m === 0) return [a, b, cc, d].reduce((s, p) => s + (read(p!) as number), 0);
      const attempt = m === 9 ? [a, z] : [a, x, y];
      let s = 0;
      attempt.forEach((p, i) => {
        if (i === Math.min(m, attempt.length) - 1) throw new Error("boom " + m);
        s += read(p!) as number;
      });
      read(attempt[attempt.length - 1]!);
      throw new Error("boom " + m);
    });
    read(c);
    const committed = indices(deps(c), all);
    for (const m of [1, 2, 3, 3, 3, 9, 2]) {
      write(mode, m);
      expect(() => read(c)).toThrow("boom " + m);
      // Wake set = committed ∪ this attempt's successful reads; one per pair.
      const now = new Set(indices(deps(c), all));
      for (const k of committed) expect(now.has(k)).toBe(true);
      expect(now.size).toBe(deps(c).length);
      expect(deps(c).length).toBeLessThanOrEqual(committed.length + 3);
      checkGraph([c]);
      expect(idle()).toBe(true);
    }
    // After the z attempt, x/y (read only by earlier failures) are gone or re-read.
    write(mode, 0);
    expect(read(c)).toBe(0 + 1 + 2 + 3);
    expect(indices(deps(c), all)).toEqual([7, 0, 1, 2, 3]);
    for (const p of [x, y, z]) expect(subs(p!).length).toBe(0);
    checkGraph([c]);
  });

  it("push and pull are not bounded by the call stack (20,000-deep chain)", () => {
    // Built bottom-up and read as it grows, so no first evaluation is deep;
    // only the later write must travel the whole chain both ways.
    const depth = 20_000;
    const s = signal(0);
    let tip: Node = s;
    for (let i = 0; i < depth; i++) {
      const below = tip;
      tip = computed(() => (read(below) as number) + 1);
      read(tip);
    }
    const leaf = tip;
    let seen = -1;
    const w = createNode(() => void (seen = read(leaf) as number), undefined, 16 | 1 | Flag.Dirty);
    write(s, 5);
    expect(read(leaf)).toBe(depth + 5);
    write(s, 6);
    // A watcher's universal validation refreshes the same chain.
    expect(seen).toBe(-1);
    expect(read(leaf)).toBe(depth + 6);
    expect(w.flags & 1).toBe(1);
    expect(idle()).toBe(true);
  });

  it("repeated identical failures do not grow the graph", () => {
    const ps = range(10).map(signal);
    const fail = signal(false);
    const c = computed(() => {
      let s = 0;
      for (let i = 0; i < 10; i++) {
        if (i === 5 && read(fail)) throw new Error("x");
        s += read(ps[i]!) as number;
      }
      return s;
    });
    read(c);
    write(fail, true);
    const counts: number[] = [];
    for (let i = 0; i < 20; i++) {
      write(ps[0]!, i + 100);
      expect(() => read(c)).toThrow("x");
      counts.push(edgeCount([c]));
    }
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBe(11);
  });
});
