// Level 1, complexity class: structural work bounds that are not semantics.
// Each assertion pins an optimization (O1, O2) or an asymptotic property;
// removing the mechanism keeps every value correct and fails here.
import { beforeEach, describe, expect, it } from "vitest";
import { DIRTY, node, read, stats, write, type Node } from "../src/kernel";
import { edgeCount, resetStats } from "./support/graph";
import { run } from "../src/host";

const signal = (v: unknown) => node(null, v, 0);
const computed = (fn: (prev: unknown) => unknown) => node(fn, undefined, DIRTY);
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
    expect([stats.allocations, stats.lookups, stats.indexed, stats.removals]).toEqual([0, 0, 0, 0]);
  });

  it("O2: a direct write executes the computed without a validation walk", () => {
    const ps = range(256).map(signal);
    const c = computed(() => ps.reduce((s, p) => s + (read(p) as number), 0));
    read(c);
    resetStats();
    write(ps[200]!, -1);
    read(c);
    expect(stats.validations).toBe(0);
    expect(stats.executions).toBe(1);
  });

  it("WOKEN: a signal write runs its watcher without the universal validation", () => {
    const ps = range(512).map(signal);
    let runs = 0;
    const w = node(() => {
      runs++;
      for (const p of ps) read(p);
    }, undefined, 16 | 1 | DIRTY);
    run(w);
    resetStats();
    write(ps[300]!, -1);
    run(w);
    expect(runs).toBe(2);
    expect(stats.validations).toBe(0);
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
    expect(stats.indexings).toBe(0);
    expect(stats.allocations).toBe(0);
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
    expect(stats.indexings).toBe(0);
    expect(stats.allocations).toBe(20 * 100);
    expect(stats.removals).toBe(20 * 100);
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
    expect(stats.indexings).toBe(0);
    expect(stats.allocations).toBe(10 * 50);
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
    expect(stats.allocations).toBe(0);
    expect(stats.indexings).toBe(40);
    expect(stats.indexed).toBe(40 * (n + 1));
  });
});
