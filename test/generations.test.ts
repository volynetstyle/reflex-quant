// Finite generations. A node's generation counts its successful runs and
// wraps at MASK + 1; an edge keeps the generation of its birth, and an edge
// born since the last success (gen === node.gen + 1) is tentative. These
// white-box witnesses forge only a node's counter, as if 2^30 - 1 earlier
// runs had passed; the wrap itself happens in a real run. Without SETTLE, an
// edge from the first run reads as tentative once the counter wraps.
import { describe, expect, it } from "vitest";
import { compute, batch, computed, dispose, effect, read, set, signal } from "../src/index";
import { CounterLimit, SETTLE } from "../src/graph";
import type { Node } from "../src/graph";
import { checkGraph, deps } from "./support/graph";

const n = (x: object) => x as unknown as Node;
const MASK = CounterLimit.Mask;
const gens = (x: object) => {
  const out: number[] = [];
  for (let e = n(x).firstDep; e !== null; e = e.nextDep) out.push(e.gen);
  return out;
};

describe("generation wraparound", () => {
  it("a watcher whose generation wrapped still validates its committed computed (no failure)", () => {
    const s = signal(1);
    const c = computed(() => read(s) * 2);
    const seen: number[] = [];
    const e = effect(() => void seen.push(compute(c)));
    n(e).gen = MASK;
    set(s, 2); // a successful run: the generation wraps to 0
    expect([seen, n(e).gen]).toEqual([[2, 4], 0]);
    // Taken as tentative, c would not be pulled, and the watcher would never
    // run again: its generation stays where it is.
    set(s, 3);
    set(s, 4);
    expect(seen).toEqual([2, 4, 6, 8]);
    dispose(e);
  });

  it("a failed watcher keeps a committed edge its failed run did not read (F3)", () => {
    const mode = signal(0);
    const stable = signal(0);
    const tick = signal(0);
    let runs = 0;
    const e = effect(() => {
      runs++;
      read(tick);
      if (read(mode) === 1) throw new Error("w");
      read(stable);
    });
    n(e).gen = MASK;
    set(tick, 1);
    expect([runs, n(e).gen]).toEqual([2, 0]);
    expect(() => set(mode, 1)).toThrow("w");
    // Committed sources still wake it.
    expect(() => set(stable, 1)).toThrow("w");
    expect(runs).toBe(4);
    dispose(e);
  });

  it("a failed computed keeps its committed frontier (F1)", () => {
    const fail = signal(false);
    const stable = signal(1);
    const tick = signal(0);
    const c = computed(() => {
      read(tick);
      if (read(fail)) throw new Error("boom");
      return read(stable);
    });
    expect(compute(c)).toBe(1);
    n(c).gen = MASK;
    set(tick, 1);
    expect([compute(c), n(c).gen]).toEqual([1, 0]);
    set(fail, true);
    expect(() => compute(c)).toThrow("boom");
    expect(deps(n(c))).toContain(n(stable));
    checkGraph([n(c), n(fail), n(stable), n(tick)]);
  });

  it("an owed watcher validates every committed source before its cleanup (P4)", () => {
    const direct = signal(0);
    const gate = signal(false);
    const deep = computed(() => {
      if (read(gate)) throw new Error("deep");
      return 1;
    });
    let runs = 0;
    let cleanups = 0;
    const e = effect(() => {
      runs++;
      read(direct);
      compute(deep);
      return () => void cleanups++;
    });
    n(e).gen = MASK;
    set(direct, 1);
    expect([runs, cleanups, n(e).gen]).toEqual([2, 1, 0]);
    expect(() =>
      batch(() => {
        set(direct, 2);
        set(gate, true);
      }),
    ).toThrow("deep");
    expect([runs, cleanups]).toEqual([2, 1]);
    dispose(e);
  });

  it("a commit at either half of the cycle restamps every edge with the node's generation", () => {
    // Twice a cycle: once a cycle would leave an edge 2^30 - 1 behind just
    // before the next restamp.
    const a = signal(0);
    const b = signal(0);
    const c = computed(() => read(a) + read(b));
    compute(c);
    expect(gens(c)).toEqual([1, 1]);
    let k = 0;
    for (const [before, after] of [
      [SETTLE, SETTLE + 1],
      [MASK, 0],
    ] as const) {
      n(c).gen = before;
      set(a, ++k);
      compute(c);
      expect(n(c).gen).toBe(after);
      expect(gens(c)).toEqual([after, after]);
    }
    // Between restamps an edge keeps its birth generation.
    set(a, ++k);
    compute(c);
    expect(gens(c)).toEqual([0, 0]);
  });
});
