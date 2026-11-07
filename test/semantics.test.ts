// Level 1: observable semantics through the public API.
import { describe, expect, it } from "vitest";
import { batch, computed, dispose, effect as watch, get, peek, set, signal, untracked, type Computed, type Effect } from "../src/index";
import { idle } from "../src/kernel";
import type { Node } from "../src/model";
import { checkGraph } from "./support/graph";
import { dev } from "./support/mode";
import { foundRepeat, prefixRepeat } from "./support/p5";

/** An effect plus its disposer, the shape these tests were written in. */
const effect = (fn: () => void | (() => void)): (() => void) => {
  const e = watch(fn);
  return () => dispose(e);
};

describe("propagation", () => {
  it("diamond: one execution per node, no glitch", () => {
    const a = signal(1);
    let runs = { b: 0, c: 0, d: 0 };
    const b = computed(() => (runs.b++, get(a) * 2));
    const c = computed(() => (runs.c++, get(a) * 3));
    const d = computed(() => (runs.d++, `${get(b)}+${get(c)}`));
    const seen: string[] = [];
    effect(() => void seen.push(get(d)));
    runs = { b: 0, c: 0, d: 0 };
    set(a, 2);
    expect(seen).toEqual(["2+3", "4+6"]);
    expect(runs).toEqual({ b: 1, c: 1, d: 1 });
  });

  it("layered diamond 8x8: each node executes once per write", () => {
    const src = signal(0);
    let count = 0;
    let layer = Array.from({ length: 8 }, (_, i) => computed(() => (count++, get(src) + i)));
    for (let l = 1; l < 8; l++) {
      const prev = layer;
      layer = prev.map((_, i) => computed(() => (count++, get(prev[i]!) + get(prev[(i + 1) % 8]!))));
    }
    const sink = computed(() => layer.reduce((s, n) => s + get(n), 0));
    get(sink);
    count = 0;
    set(src, 1);
    get(sink);
    expect(count).toBe(64);
  });

  it("cutoff: an unchanged computed stops propagation", () => {
    const a = signal(1);
    let below = 0;
    const parity = computed(() => get(a) % 2);
    const after = computed(() => (below++, get(parity) * 10));
    get(after);
    below = 0;
    set(a, 3);
    expect(get(after)).toBe(10);
    expect(below).toBe(0);
  });

  it("fan-out: one write reaches every effect once", () => {
    const a = signal(0);
    const hits = new Array(100).fill(0);
    hits.forEach((_, i) => effect(() => void (get(a), hits[i]++)));
    set(a, 1);
    expect(hits.every((h) => h === 2)).toBe(true);
  });

  it("fan-in: a write to any of many sources updates the sink", () => {
    const ps = Array.from({ length: 100 }, (_, i) => signal(i));
    const sum = computed(() => ps.reduce((s, p) => s + get(p), 0));
    expect(get(sum)).toBe(4950);
    set(ps[57]!, 0);
    expect(get(sum)).toBe(4950 - 57);
  });

  it("direct ABA re-runs the effect (versions, not values)", () => {
    const a = signal(0);
    let runs = 0;
    effect(() => void (get(a), runs++));
    batch(() => {
      set(a, 1);
      set(a, 0);
    });
    expect(runs).toBe(2);
  });
});

describe("batching", () => {
  it("defers effects to the outermost batch end", () => {
    const a = signal(1);
    const b = signal(2);
    const seen: number[] = [];
    effect(() => void seen.push(get(a) + get(b)));
    batch(() => {
      set(a, 10);
      batch(() => set(b, 20));
      expect(seen).toEqual([3]);
    });
    expect(seen).toEqual([3, 30]);
  });

  it("reads inside a batch see committed values", () => {
    const a = signal(1);
    const d = computed(() => get(a) * 2);
    batch(() => {
      set(a, 5);
      expect(get(d)).toBe(10);
    });
  });
});

describe("effects", () => {
  it("cleanup runs before the rerun and on dispose, untracked", () => {
    const a = signal(0);
    const b = signal(0);
    const log: string[] = [];
    const stop = effect(() => {
      const v = get(a);
      log.push(`run ${v}`);
      return () => log.push(`cleanup ${v} b=${get(b)}`);
    });
    set(a, 1);
    set(b, 1); // read only by the cleanup: not a dependency
    stop();
    expect(log).toEqual(["run 0", "cleanup 0 b=0", "run 1", "cleanup 1 b=1"]);
    set(a, 2);
    expect(log.length).toBe(4);
  });

  it("an effect writing a source it read converges", () => {
    const a = signal(0);
    const seen: number[] = [];
    effect(() => {
      const v = get(a);
      seen.push(v);
      if (v < 3) set(a, v + 1);
    });
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(get(a)).toBe(3);
  });

  it("a write to a not-yet-read source during the run adds no rerun", () => {
    const a = signal(0);
    const b = signal(0);
    let runs = 0;
    effect(() => {
      runs++;
      if (get(a) === 1) set(b, 5); // b is read after this write
      get(b);
    });
    set(a, 1);
    expect(runs).toBe(2);
  });

  it("failing effect does not stop the others; the error reaches the writer", () => {
    const a = signal(0);
    const log: string[] = [];
    effect(() => {
      if (get(a) === 1) throw new Error("bad");
      log.push("first");
    });
    effect(() => void (get(a), log.push("second")));
    expect(() => set(a, 1)).toThrow("bad");
    expect(log).toEqual(["first", "second", "second"]);
    set(a, 2);
    expect(log).toEqual(["first", "second", "second", "first", "second"]);
    expect(idle()).toBe(true);
  });

  it("after a failed validation the effect is re-delivered when its cause changes", () => {
    const gate = signal(false);
    const base = signal(1);
    const deep = computed(() => {
      if (get(gate)) throw new Error("deep");
      return get(base);
    });
    const mid = computed(() => get(deep) + 1);
    const seen: number[] = [];
    effect(() => void seen.push(get(mid)));
    expect(() => set(gate, true)).toThrow("deep");
    // Repair to the same value: validated again, not executed (exact cutoff).
    set(gate, false);
    expect(seen).toEqual([2]);
    expect(() => set(gate, true)).toThrow("deep");
    // Repair to a new value: the push passes the failed computeds (DIRTY,
    // not STALE) and reaches the effect, which now executes.
    batch(() => {
      set(base, 10);
      set(gate, false);
    });
    expect(seen).toEqual([2, 11]);
  });

  it("effects created inside a batch or another effect run after it", () => {
    const log: string[] = [];
    batch(() => {
      effect(() => void log.push("inner"));
      log.push("batch body");
    });
    effect(() => {
      log.push("outer");
      effect(() => void log.push("child"));
      log.push("outer end");
    });
    expect(log).toEqual(["batch body", "inner", "outer", "outer end", "child"]);
  });

  it("an effect failing after its first run keeps the obligation (R2)", () => {
    const d = signal(0);
    const u = signal(0);
    const c = computed(() => get(u) > 5);
    let runs = 0;
    effect(() => {
      runs++;
      get(c);
      if (get(d) > 0) throw new Error("w");
    });
    expect(() => set(d, 1)).toThrow("w");
    // c recomputes to the same value; the failed run still owes an execution.
    expect(() => set(u, 1)).toThrow("w");
    expect(runs).toBe(3);
  });

  it("dispose inside the callback: no relations, returned cleanup dropped", () => {
    const a = signal(0);
    const log: string[] = [];
    let stop: () => void = () => {};
    stop = effect(() => {
      const v = get(a);
      if (v === 1) stop();
      return () => log.push(`cleanup ${v}`);
    });
    set(a, 1);
    set(a, 2);
    expect(log).toEqual(["cleanup 0"]);
    expect(idle()).toBe(true);
  });

  it("dispose inside the callback, then more reads: no ghost relation", () => {
    const sources = Array.from({ length: 6 }, (_, i) => signal(i));
    const flip = signal(false);
    const fresh = signal(0);
    let stop: () => void = () => {};
    let runs = 0;
    stop = effect(() => {
      runs++;
      const order = get(flip) ? [5, 3, 1, 0, 2, 4] : [0, 1, 2, 3, 4, 5];
      for (const [k, i] of order.entries()) {
        get(sources[i]!);
        if (get(flip) && k === 1) stop(); // mid-pass, before reordered reads
      }
      if (get(flip)) get(fresh); // a source never read before
    });
    set(flip, true);
    for (const s of sources) set(s, 100);
    set(fresh, 1);
    expect(runs).toBe(2);
    expect(idle()).toBe(true);
    const nodes = [...sources, flip, fresh].map((s) => s as unknown as Node);
    checkGraph(nodes);
    expect(nodes.every((n) => n.subs === null)).toBe(true);
  });

  it("dispose inside the cleanup: the callback does not run again", () => {
    const a = signal(0);
    const other = signal(0);
    const log: string[] = [];
    let otherRuns = 0;
    effect(() => void (get(a), get(other), otherRuns++)); // unrelated subscriber
    let stop: () => void = () => {};
    stop = effect(() => {
      log.push(`run ${get(a)}`);
      return () => {
        log.push("cleanup");
        stop();
      };
    });
    set(a, 1);
    expect(log).toEqual(["run 0", "cleanup"]);
    set(a, 2);
    expect(log).toEqual(["run 0", "cleanup"]);
    set(other, 1);
    expect(otherRuns).toBe(4);
  });

  it("disposing a sibling sharing the sources during a run leaves the others intact", () => {
    const a = signal(0);
    const counts = [0, 0, 0];
    const stops: (() => void)[] = [];
    stops.push(effect(() => void (get(a), counts[0]++)));
    stops.push(effect(() => {
      get(a);
      counts[1]++;
      if (get(a) === 1) stops[0]!();
    }));
    stops.push(effect(() => void (get(a), counts[2]++)));
    set(a, 1);
    set(a, 2);
    expect(counts).toEqual([2, 3, 3]);
  });
});

describe("tracking boundaries", () => {
  it("untracked reads leave no dependency", () => {
    const a = signal(1);
    const b = signal(2);
    let runs = 0;
    const c = computed(() => (runs++, get(a) + untracked(() => get(b))));
    expect(get(c)).toBe(3);
    set(b, 5);
    expect(get(c)).toBe(3);
    expect(runs).toBe(1);
  });

  it("a computed that writes a source it already read converges on the next read (F1)", () => {
    const a = signal(0);
    const c = computed(() => {
      const v = get(a);
      if (v === 1) set(a, 2);
      return v;
    });
    expect(get(c)).toBe(0);
    set(a, 1);
    expect(get(c)).toBe(1); // computed before the write
    expect(get(c)).toBe(2); // and not left stale
  });

  it("cycles throw instead of overflowing", () => {
    const flag = signal(false);
    const holder: { c?: Computed<number> } = {};
    const c = computed((): number => (get(flag) ? get(holder.c!) : 0));
    holder.c = c;
    expect(get(c)).toBe(0);
    set(flag, true);
    expect(() => get(c)).toThrow("Cycle");
    expect(idle()).toBe(true);
  });

  it("disposing a computed detaches it and freezes its value", () => {
    const a = signal(1);
    const c = computed(() => get(a) * 2);
    expect(get(c)).toBe(2);
    dispose(c);
    set(a, 5);
    expect(get(c)).toBe(2);
  });
});

describe("P5 in-pass invalidation", () => {
  // Once a computation has observed a source in an execution, a later change
  // to that source leaves it owing another execution; rereading the source in
  // the same execution does not discharge the obligation.

  it("read, changing write, reread: the next demand executes again (3, 4, 4)", () => {
    const a = signal(1);
    let wrote = false;
    let runs = 0;
    const c = computed(() => {
      runs++;
      const x = get(a);
      if (!wrote) {
        wrote = true;
        set(a, 2);
      }
      return x + get(a);
    });
    expect([get(c), get(c), get(c)]).toEqual([3, 4, 4]);
    expect(runs).toBe(2);
  });

  it("a same-value write is no change (P1): nothing is owed", () => {
    const a = signal(1);
    let runs = 0;
    const c = computed(() => {
      runs++;
      const x = get(a);
      set(a, 1);
      return x + get(a);
    });
    expect([get(c), get(c)]).toEqual([2, 2]);
    expect(runs).toBe(1);
  });

  it("a change before the pass's first observation owes nothing", () => {
    const a = signal(1);
    const t = signal(0);
    let runs = 0;
    const c = computed(() => {
      runs++;
      // peek is not an observation: the write lands before a is observed.
      if (get(t) === 1 && peek(a) === 1) set(a, 2);
      return get(a) + get(a);
    });
    expect(get(c)).toBe(2);
    set(t, 1);
    expect([get(c), get(c)]).toEqual([4, 4]);
    expect(runs).toBe(2);
  });

  it("A→B→A after the first observation is a change (P1): the next demand executes again", () => {
    const a = signal(1);
    let wrote = false;
    let runs = 0;
    const c = computed(() => {
      runs++;
      const x = get(a);
      if (!wrote) {
        wrote = true;
        set(a, 2);
        set(a, 1);
      }
      return x + get(a);
    });
    expect([get(c), get(c)]).toEqual([2, 2]);
    expect(runs).toBe(2);
  });

  it("one rule on every path that recognises a repeated read", () => {
    // The same program owes the same execution whether its repeat is found
    // by the prefix scan, through the subscribers or through a slot
    // (test/support/p5.ts; structure.test.ts pins which path each reaches).
    const c = prefixRepeat();
    expect([get(c), get(c), get(c)]).toEqual([13, 14, 14]);
    for (const indexed of [false, true]) {
      const w = foundRepeat(indexed);
      expect(get(w.c)).toBe(66);
      set(w.tick, 1);
      expect([get(w.c), get(w.c), get(w.c)]).toEqual([166, 255, 255]);
      expect(w.runs()).toBe(3);
    }
    expect(idle()).toBe(true);
  });
});

describe("W5 construction atomicity", () => {
  // A watcher is established when effect() returns its handle. A call that
  // throws returns none, so it must leave nothing live behind.
  const n = (x: object) => x as unknown as Node;

  it("a failed first run leaves no live watcher and no relation", () => {
    const source = signal(0);
    let runs = 0;
    expect(() =>
      watch(() => {
        runs++;
        get(source);
        throw new Error("setup");
      }),
    ).toThrow("setup");
    expect(n(source).subs).toBe(null);
    set(source, 1);
    expect(runs).toBe(1);
    expect(idle()).toBe(true);
  });

  it("a sibling's failure in the drain the call opened rolls the new watcher back", () => {
    const out = signal(0);
    const tick = signal(0);
    let runs = 0;
    let cleanups = 0;
    const failing = watch(() => {
      if (get(out) === 1) throw new Error("sibling");
    });
    expect(() =>
      watch(() => {
        runs++;
        get(tick);
        set(out, 1);
        return () => void cleanups++;
      }),
    ).toThrow("sibling");
    // Its own run succeeded: the write stays, the cleanup is consumed, and
    // the unreachable watcher never runs again.
    expect([get(out), runs, cleanups]).toEqual([1, 1, 1]);
    expect(n(tick).subs).toBe(null);
    set(tick, 1);
    expect([runs, cleanups]).toEqual([1, 1]);
    dispose(failing);
  });

  it("a first run deferred by a batch is established: its failure is F3", () => {
    const source = signal(0);
    let runs = 0;
    let handle: Effect | undefined;
    expect(() =>
      batch(() => {
        handle = watch(() => {
          runs++;
          get(source);
          throw new Error("deferred");
        });
      }),
    ).toThrow("deferred");
    expect(handle).toBeDefined();
    // Cold, and woken by what its failed run read.
    expect(() => set(source, 1)).toThrow("deferred");
    expect(runs).toBe(2);
    dispose(handle!);
    set(source, 2);
    expect(runs).toBe(2);
  });
});

// C1 is a precondition: the development build diagnoses a demand that
// reaches a node whose execution or validation is in progress, so that
// node's committed value never stands in for it. The production build
// compiles the diagnosis away and gives such a program no defined result.
describe.runIf(dev)("C1 evaluation in progress (development build)", () => {
  const nodes = (...xs: object[]) => xs as unknown as Node[];

  /** a = cyclic ? b + 1 : 0, b = poke + a + 1: a two-node cycle behind a gate. */
  const pair = () => {
    const cyclic = signal(false);
    const poke = signal(0);
    const h: { b?: Computed<number> } = {};
    const a = computed((): number => (get(cyclic) ? get(h.b!) + 1 : 0));
    const b = (h.b = computed((): number => get(poke) + get(a) + 1));
    expect(get(b)).toBe(1);
    return { cyclic, poke, a, b };
  };

  it("a read of a node under validation is a cycle, not its previous value", () => {
    const { cyclic, a, b } = pair();
    set(cyclic, true);
    // verify(b) runs a; a reads b, whose validation is in progress.
    expect(() => get(b)).toThrow("Cycle");
    checkGraph(nodes(a, b));
    set(cyclic, false);
    expect([get(a), get(b)]).toEqual([0, 1]);
    expect(idle()).toBe(true);
  });

  it("the answer does not depend on how the cycle's nodes were invalidated", () => {
    for (const direct of [false, true]) {
      const { cyclic, poke, a, b } = pair();
      set(cyclic, true);
      // b STALE through a, or DIRTY through its own signal.
      if (direct) set(poke, 0.5);
      expect(() => get(b)).toThrow("Cycle");
      checkGraph(nodes(a, b));
    }
  });

  it("validation reaching an executing node is a cycle and leaves no clean node behind", () => {
    const { cyclic, a, b } = pair();
    set(cyclic, true);
    // a runs and reads b; b's validation reaches a, whose run is on the stack.
    // Taken as clean, b would keep 1 at rest while a holds 2.
    expect(() => get(a)).toThrow("Cycle");
    checkGraph(nodes(a, b));
    set(cyclic, false);
    expect([get(a), get(b)]).toEqual([0, 1]);
  });

  it("every cycle up to length 4 fails whichever node is demanded, directly or from above", () => {
    // From above, the cycle closes on a node the walk descended into rather
    // than on the node it started from.
    for (let k = 1; k <= 4; k++)
      for (let gate = 0; gate < k; gate++)
        for (let demand = 0; demand < k; demand++)
          for (const above of [false, true]) {
            const cyclic = signal(false);
            const ring: Computed<number>[] = [];
            for (let i = 0; i < k; i++)
              ring.push(computed((): number => (i === gate && !get(cyclic) ? 0 : get(ring[(i + 1) % k]!) + 1)));
            const top = computed(() => get(ring[demand]!));
            const target = above ? top : ring[demand]!;
            const at = (i: number) => (gate - i + k) % k;
            expect([get(top), ...ring.map((c) => get(c))]).toEqual([at(demand), ...ring.map((_, i) => at(i))]);
            set(cyclic, true);
            const label = `k=${k} gate=${gate} demand=${demand} above=${above}`;
            expect(() => get(target), label).toThrow("Cycle");
            checkGraph(nodes(top, ...ring), label);
            set(cyclic, false);
            expect([get(top), ...ring.map((c) => get(c))], label).toEqual([at(demand), ...ring.map((_, i) => at(i))]);
            checkGraph(nodes(top, ...ring), label);
            expect(idle(), label).toBe(true);
          }
  });

  it("a reentrant demand without a data cycle fails as a direct read does", () => {
    // No cycle in the graph: a writes x, and the drain that write opens runs
    // an effect that reads a's consumer b (or a itself) while a is running.
    for (const readsB of [true, false]) {
      const trig = signal(0);
      const x = signal(0);
      const a = computed(() => {
        const t = get(trig);
        if (t === 1) set(x, 1);
        return t * 10;
      });
      const b = computed(() => get(a) + 1);
      const seen: number[] = [];
      const stop = effect(() => {
        if (get(x) === 1) seen.push(readsB ? get(b) : get(a));
      });
      // Read once, so the next demand validates b rather than running it.
      expect(get(b)).toBe(1);
      set(trig, 1);
      expect(() => (readsB ? get(b) : get(a))).toThrow("Cycle");
      // Never the value b held before a's run.
      expect(seen).toEqual([]);
      checkGraph(nodes(a, b));
      expect(get(b)).toBe(11);
      stop();
    }
  });

  it("a watcher's validation reaching a computed under validation fails before its cleanup (P4)", () => {
    const trig = signal(0);
    const x = signal(0);
    const s = signal(0);
    // Not reactive: strands the watcher STALE without another push.
    let broken = false;
    const g = computed(() => {
      get(s);
      if (broken) throw new Error("g");
      return 0;
    });
    const a = computed(() => {
      const t = get(trig);
      if (t === 1) set(x, 1);
      return t * 10;
    });
    const b = computed(() => get(a) + 1);
    let runs = 0;
    let cleanups = 0;
    const stop = effect(() => {
      runs++;
      get(g);
      get(b);
      get(x);
      return () => void cleanups++;
    });
    // The watcher's validation fails at g, before it reaches b: b stays STALE.
    expect(() =>
      batch(() => {
        broken = true;
        set(s, 1);
        set(trig, 1);
      }),
    ).toThrow("g");
    broken = false;
    // b's validation runs a; a's write delivers the watcher, whose validation
    // reaches b. Taken as clean, b would let the cleanup run first.
    expect(() => get(b)).toThrow("Cycle");
    expect([runs, cleanups]).toEqual([1, 0]);
    // The next push re-delivers it.
    set(x, 2);
    expect([runs, cleanups]).toEqual([2, 1]);
    stop();
  });
});

describe("W3 disposal during validation", () => {
  /** `a` disposes `b` when s = 1, returning `change ? s : 0`; `b` reads `a` directly or through `m`, then `t`. */
  const program = (through: boolean, change: boolean) => {
    const s = signal(0);
    const fault = signal(false);
    const h: { b?: Computed<number> } = {};
    const a = computed(() => {
      const v = get(s);
      if (v === 1) dispose(h.b!);
      return change ? v : 0;
    });
    const m = computed(() => get(a));
    const t = computed(() => {
      if (get(fault)) throw new Error("t");
      return 0;
    });
    const b = (h.b = computed(() => (through ? get(m) : get(a)) + get(t) + 1));
    expect(get(b)).toBe(1);
    return { s, fault, a, m, t, b };
  };

  it("a computed disposed while it is validated is not run again; its value freezes", () => {
    // Directly: b's own source changed. Through m: m runs, then the climb
    // reaches b.
    for (const through of [false, true]) {
      const { s, a, m, t, b } = program(through, true);
      set(s, 1);
      expect(get(b)).toBe(1);
      set(s, 2);
      expect(get(b)).toBe(1);
      checkGraph(nodes(a, m, t, b));
      expect(n(b).deps).toBe(null);
      expect(idle()).toBe(true);
    }
  });

  it("a later source failing in the same walk does not leave the disposed computed owing a run", () => {
    // a disposes b and comes out unchanged, so the walk goes on to t, which
    // throws into the demand in progress; b is terminal from then on.
    const { s, fault, b } = program(false, false);
    batch(() => {
      set(fault, true);
      set(s, 1);
    });
    expect(() => get(b)).toThrow("t");
    expect(get(b)).toBe(1);
    set(fault, false);
    expect(get(b)).toBe(1);
    expect(idle()).toBe(true);
  });

  const n = (x: object) => x as unknown as Node;
  const nodes = (...xs: object[]) => xs as unknown as Node[];
});
