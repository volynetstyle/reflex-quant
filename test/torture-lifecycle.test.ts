// Torture round 2: the phases between validation and the callback, the host
// queue under failure and disposal, nested failure inside a computation, and
// failure across a full reorder.
import { describe, expect, it } from "vitest";
import { batch, computed, dispose, effect, get, peek, set, signal, type Computed } from "../src/index";
import { idle, stats } from "../src/kernel";
import type { Edge, Node } from "../src/model";
import { checkGraph, deps, resetStats } from "./support/graph";

const n = (x: object) => x as unknown as Node;

describe("torture: cleanup between validation and callback", () => {
  it("a throwing cleanup does not consume the owed execution (F4)", () => {
    const source = signal(0);
    let runs = 0;
    let cleanups = 0;
    const e = effect(() => {
      const value = get(source);
      runs++;
      return () => {
        cleanups++;
        if (value === 0) throw new Error("cleanup");
      };
    });
    expect(() => set(source, 1)).toThrow("cleanup");
    // Validated, cleanup consumed (W1), callback not started.
    expect([runs, cleanups]).toEqual([1, 1]);
    // The execution is still owed; the next delivery discharges it once.
    set(source, 2);
    expect([runs, cleanups]).toEqual([2, 1]);
    dispose(e);
    expect(cleanups).toBe(2);
    expect(idle()).toBe(true);
  });

  it("a cleanup that writes a source of its watcher and throws: no lost and no duplicated run", () => {
    const source = signal(0);
    const trigger = signal(0);
    const seen: number[] = [];
    const e = effect(() => {
      get(trigger);
      const value = get(source);
      seen.push(value);
      return () => {
        set(source, value + 1);
        throw new Error("cleanup");
      };
    });
    expect(seen).toEqual([0]);
    // The cleanup's write commits and delivers the watcher again (W2); the
    // owed run happens once in the same drain, with the new value; the
    // cleanup's error reaches the writer.
    expect(() => set(trigger, 1)).toThrow("cleanup");
    expect(seen).toEqual([0, 1]);
    expect(get(source)).toBe(1);
    // Each later delivery behaves the same way: one cleanup, one run.
    expect(() => set(trigger, 2)).toThrow("cleanup");
    expect(seen).toEqual([0, 1, 2]);
    expect(get(source)).toBe(2);
    // Disposal: teardown first, then the last cleanup (W3). Its write commits
    // but wakes nothing, and its error reaches the disposer.
    expect(() => dispose(e)).toThrow("cleanup");
    expect([seen, get(source)]).toEqual([[0, 1, 2], 3]);
    expect(n(source).subs).toBe(null);
    expect(idle()).toBe(true);
  });
});

describe("torture: host queue", () => {
  it("disposing a queued watcher makes its queued entry inert", () => {
    const source = signal(0);
    let runs = 0;
    const e = effect(() => {
      get(source);
      runs++;
    });
    batch(() => {
      set(source, 1);
      dispose(e);
    });
    expect(runs).toBe(1);
    set(source, 2);
    expect(runs).toBe(1);
    expect(n(source).subs).toBe(null);
  });

  it("a failed watcher does not stop later watchers from queueing more work", () => {
    const a = signal(0);
    const b = signal(0);
    const log: string[] = [];
    const stops = [
      effect(() => {
        if (get(a) === 1) {
          log.push("A:error");
          throw new Error("first");
        }
      }),
      effect(() => {
        if (get(a) === 1) {
          log.push("B");
          set(b, 1);
        }
      }),
      effect(() => {
        if (get(b) === 1) log.push("C");
      }),
    ];
    expect(() => set(a, 1)).toThrow("first");
    expect(log).toEqual(["A:error", "B", "C"]);
    stops.forEach(dispose);
  });
});

describe("torture: nested failure", () => {
  it("a throwing peek restores the outer tracking context and records nothing", () => {
    const gate = signal(true);
    const after = signal(1);
    const inner = computed(() => {
      if (get(gate)) throw new Error("inner");
      return 10;
    });
    let outerRuns = 0;
    const outer = computed(() => {
      outerRuns++;
      try {
        peek(inner);
      } catch {
        // the failed peek is neither an observation nor a context leak
      }
      return get(after);
    });
    expect(get(outer)).toBe(1);
    set(after, 2);
    expect([get(outer), outerRuns]).toEqual([2, 2]);
    set(gate, false);
    expect([get(outer), outerRuns]).toEqual([2, 2]);
    expect(deps(n(outer))).toEqual([n(after)]);
    expect(idle()).toBe(true);
  });

  it("failures across a full reorder keep the committed frontier and only the last attempt's reads", () => {
    const phase = signal(0);
    const s = Array.from({ length: 8 }, (_, i) => signal(i));
    const A = [0, 1, 2, 3];
    // committed A, failed B, failed C, failed reverse(A), then A again
    const plan: [number[], boolean][] = [
      [A, false],
      [[4, 5], true],
      [[6, 7], true],
      [[3, 2, 1, 0], true],
      [A, false],
    ];
    const c: Computed<number> = computed(() => {
      const [reads, throws] = plan[get(phase)]!;
      let t = 0;
      for (const i of reads) t += get(s[i]!);
      if (throws) throw new Error("attempt");
      return t;
    });
    const nodes = [n(c), n(phase), ...s.map(n)];
    const edgeOf = (k: number) => {
      for (let e: Edge | null = n(c).deps; e !== null; e = e.next) if (e.from === n(s[k]!)) return e;
      return null;
    };
    const ids = (list: number[]) => list.map((i) => n(s[i]!));
    expect(get(c)).toBe(6);
    const committed = A.map(edgeOf);
    // B failed: its reads wake, the committed frontier stays.
    set(phase, 1);
    expect(() => get(c)).toThrow("attempt");
    expect(deps(n(c))).toEqual([n(phase), ...ids([4, 5]), ...ids(A)]);
    checkGraph(nodes);
    // C failed: B's tentative relations are gone.
    set(phase, 2);
    expect(() => get(c)).toThrow("attempt");
    expect(deps(n(c))).toEqual([n(phase), ...ids([6, 7]), ...ids(A)]);
    checkGraph(nodes);
    // reverse(A) failed: the committed relations are moved, not rebuilt; C's are gone.
    resetStats();
    set(phase, 3);
    expect(() => get(c)).toThrow("attempt");
    expect(deps(n(c))).toEqual([n(phase), ...ids([3, 2, 1, 0])]);
    expect(stats.links).toBe(0);
    checkGraph(nodes);
    // Recovery in the original order reuses the very same relations.
    resetStats();
    set(phase, 4);
    expect(get(c)).toBe(6);
    expect(deps(n(c))).toEqual([n(phase), ...ids(A)]);
    expect(A.map(edgeOf)).toEqual(committed);
    expect(stats.links).toBe(0);
    checkGraph(nodes);
    // Only the committed frontier wakes it now.
    for (const k of [4, 5, 6, 7]) expect(n(s[k]!).subs).toBe(null);
    expect(idle()).toBe(true);
  });
});

describe("contract characterization: who receives a computed's failure", () => {
  it("validation surfaces it to the writer, before the effect's own try/catch runs (P4)", () => {
    // Quant validates a watcher's committed sources before any lifecycle
    // step, so the failure is a failed validation: the writer receives it and
    // the effect neither runs nor sees it. A runtime that executes the effect
    // and lets its try/catch observe the error has a different contract.
    const shouldThrow = signal(false);
    const value = computed(() => {
      if (get(shouldThrow)) throw new Error("boom");
      return 1;
    });
    const seen: string[] = [];
    const e = effect(() => {
      try {
        seen.push(String(get(value)));
      } catch {
        seen.push("error");
      }
    });
    expect(() => set(shouldThrow, true)).toThrow("boom");
    expect(seen).toEqual(["1"]);
    // Repaired to the same value: no change, so the effect does not run.
    set(shouldThrow, false);
    expect(seen).toEqual(["1"]);
    dispose(e);
  });
});
