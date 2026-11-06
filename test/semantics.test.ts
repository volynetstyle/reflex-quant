// Level 1: observable semantics through the public API.
import { describe, expect, it } from "vitest";
import { batch, computed, dispose, effect as watch, get, peek, set, signal, untracked, type Computed } from "../src/index";
import { idle } from "../src/kernel";
import type { Node } from "../src/model";
import { checkGraph } from "./support/graph";
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
