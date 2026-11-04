// Level 1: observable semantics through the public API.
import { describe, expect, it } from "vitest";
import { batch, computed, effect, signal, untracked } from "../src/index";
import { atRest, type Node } from "../src/kernel";
import { checkGraph } from "./support/graph";

describe("propagation", () => {
  it("diamond: one execution per node, no glitch", () => {
    const a = signal(1);
    let runs = { b: 0, c: 0, d: 0 };
    const b = computed(() => (runs.b++, a.get() * 2));
    const c = computed(() => (runs.c++, a.get() * 3));
    const d = computed(() => (runs.d++, `${b.get()}+${c.get()}`));
    const seen: string[] = [];
    effect(() => void seen.push(d.get()));
    runs = { b: 0, c: 0, d: 0 };
    a.set(2);
    expect(seen).toEqual(["2+3", "4+6"]);
    expect(runs).toEqual({ b: 1, c: 1, d: 1 });
  });

  it("layered diamond 8x8: each node executes once per write", () => {
    const src = signal(0);
    let count = 0;
    let layer = Array.from({ length: 8 }, (_, i) => computed(() => (count++, src.get() + i)));
    for (let l = 1; l < 8; l++) {
      const prev = layer;
      layer = prev.map((_, i) => computed(() => (count++, prev[i]!.get() + prev[(i + 1) % 8]!.get())));
    }
    const sink = computed(() => layer.reduce((s, n) => s + n.get(), 0));
    sink.get();
    count = 0;
    src.set(1);
    sink.get();
    expect(count).toBe(64);
  });

  it("cutoff: an unchanged computed stops propagation", () => {
    const a = signal(1);
    let below = 0;
    const parity = computed(() => a.get() % 2);
    const after = computed(() => (below++, parity.get() * 10));
    after.get();
    below = 0;
    a.set(3);
    expect(after.get()).toBe(10);
    expect(below).toBe(0);
  });

  it("fan-out: one write reaches every effect once", () => {
    const a = signal(0);
    const hits = new Array(100).fill(0);
    hits.forEach((_, i) => effect(() => void (a.get(), hits[i]++)));
    a.set(1);
    expect(hits.every((h) => h === 2)).toBe(true);
  });

  it("fan-in: a write to any of many sources updates the sink", () => {
    const ps = Array.from({ length: 100 }, (_, i) => signal(i));
    const sum = computed(() => ps.reduce((s, p) => s + p.get(), 0));
    expect(sum.get()).toBe(4950);
    ps[57]!.set(0);
    expect(sum.get()).toBe(4950 - 57);
  });

  it("direct ABA re-runs the effect (versions, not values)", () => {
    const a = signal(0);
    let runs = 0;
    effect(() => void (a.get(), runs++));
    batch(() => {
      a.set(1);
      a.set(0);
    });
    expect(runs).toBe(2);
  });
});

describe("batching", () => {
  it("defers effects to the outermost batch end", () => {
    const a = signal(1);
    const b = signal(2);
    const seen: number[] = [];
    effect(() => void seen.push(a.get() + b.get()));
    batch(() => {
      a.set(10);
      batch(() => b.set(20));
      expect(seen).toEqual([3]);
    });
    expect(seen).toEqual([3, 30]);
  });

  it("reads inside a batch see committed values", () => {
    const a = signal(1);
    const d = computed(() => a.get() * 2);
    batch(() => {
      a.set(5);
      expect(d.get()).toBe(10);
    });
  });
});

describe("effects", () => {
  it("cleanup runs before the rerun and on dispose, untracked", () => {
    const a = signal(0);
    const b = signal(0);
    const log: string[] = [];
    const stop = effect(() => {
      const v = a.get();
      log.push(`run ${v}`);
      return () => log.push(`cleanup ${v} b=${b.get()}`);
    });
    a.set(1);
    b.set(1); // read only by the cleanup: not a dependency
    stop();
    expect(log).toEqual(["run 0", "cleanup 0 b=0", "run 1", "cleanup 1 b=1"]);
    a.set(2);
    expect(log.length).toBe(4);
  });

  it("an effect writing a source it read converges", () => {
    const a = signal(0);
    const seen: number[] = [];
    effect(() => {
      const v = a.get();
      seen.push(v);
      if (v < 3) a.set(v + 1);
    });
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(a.get()).toBe(3);
  });

  it("a write to a not-yet-read source during the run adds no rerun", () => {
    const a = signal(0);
    const b = signal(0);
    let runs = 0;
    effect(() => {
      runs++;
      if (a.get() === 1) b.set(5); // b is read after this write
      b.get();
    });
    a.set(1);
    expect(runs).toBe(2);
  });

  it("failing effect does not stop the others; the error reaches the writer", () => {
    const a = signal(0);
    const log: string[] = [];
    effect(() => {
      if (a.get() === 1) throw new Error("bad");
      log.push("first");
    });
    effect(() => void (a.get(), log.push("second")));
    expect(() => a.set(1)).toThrow("bad");
    expect(log).toEqual(["first", "second", "second"]);
    a.set(2);
    expect(log).toEqual(["first", "second", "second", "first", "second"]);
    expect(atRest()).toBe(true);
  });

  it("after a failed validation the effect is re-delivered when its cause changes", () => {
    const gate = signal(false);
    const base = signal(1);
    const deep = computed(() => {
      if (gate.get()) throw new Error("deep");
      return base.get();
    });
    const mid = computed(() => deep.get() + 1);
    const seen: number[] = [];
    effect(() => void seen.push(mid.get()));
    expect(() => gate.set(true)).toThrow("deep");
    // Repair to the same value: validated again, not executed (exact cutoff).
    gate.set(false);
    expect(seen).toEqual([2]);
    expect(() => gate.set(true)).toThrow("deep");
    // Repair to a new value: the push passes the failed computeds (DIRTY,
    // not STALE) and reaches the effect, which now executes.
    batch(() => {
      base.set(10);
      gate.set(false);
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
    const c = computed(() => u.get() > 5);
    let runs = 0;
    effect(() => {
      runs++;
      c.get();
      if (d.get() > 0) throw new Error("w");
    });
    expect(() => d.set(1)).toThrow("w");
    // c recomputes to the same value; the failed run still owes an execution.
    expect(() => u.set(1)).toThrow("w");
    expect(runs).toBe(3);
  });

  it("dispose inside the callback: no relations, returned cleanup dropped", () => {
    const a = signal(0);
    const log: string[] = [];
    let stop: () => void = () => {};
    stop = effect(() => {
      const v = a.get();
      if (v === 1) stop();
      return () => log.push(`cleanup ${v}`);
    });
    a.set(1);
    a.set(2);
    expect(log).toEqual(["cleanup 0"]);
    expect(atRest()).toBe(true);
  });

  it("dispose inside the callback, then more reads: no ghost relation", () => {
    const sources = Array.from({ length: 6 }, (_, i) => signal(i));
    const flip = signal(false);
    const fresh = signal(0);
    let stop: () => void = () => {};
    let runs = 0;
    stop = effect(() => {
      runs++;
      const order = flip.get() ? [5, 3, 1, 0, 2, 4] : [0, 1, 2, 3, 4, 5];
      for (const [k, i] of order.entries()) {
        sources[i]!.get();
        if (flip.get() && k === 1) stop(); // mid-pass, before reordered reads
      }
      if (flip.get()) fresh.get(); // a source never read before
    });
    flip.set(true);
    for (const s of sources) s.set(100);
    fresh.set(1);
    expect(runs).toBe(2);
    expect(atRest()).toBe(true);
    const nodes = [...sources, flip, fresh].map((s) => (s as unknown as { n: Node }).n);
    checkGraph(nodes);
    expect(nodes.every((n) => n.subs === null)).toBe(true);
  });

  it("dispose inside the cleanup: the callback does not run again", () => {
    const a = signal(0);
    const other = signal(0);
    const log: string[] = [];
    let otherRuns = 0;
    effect(() => void (a.get(), other.get(), otherRuns++)); // unrelated subscriber
    let stop: () => void = () => {};
    stop = effect(() => {
      log.push(`run ${a.get()}`);
      return () => {
        log.push("cleanup");
        stop();
      };
    });
    a.set(1);
    expect(log).toEqual(["run 0", "cleanup"]);
    a.set(2);
    expect(log).toEqual(["run 0", "cleanup"]);
    other.set(1);
    expect(otherRuns).toBe(4);
  });

  it("disposing a sibling sharing the sources during a run leaves the others intact", () => {
    const a = signal(0);
    const counts = [0, 0, 0];
    const stops: (() => void)[] = [];
    stops.push(effect(() => void (a.get(), counts[0]++)));
    stops.push(effect(() => {
      a.get();
      counts[1]++;
      if (a.get() === 1) stops[0]!();
    }));
    stops.push(effect(() => void (a.get(), counts[2]++)));
    a.set(1);
    a.set(2);
    expect(counts).toEqual([2, 3, 3]);
  });
});

describe("tracking boundaries", () => {
  it("untracked reads leave no dependency", () => {
    const a = signal(1);
    const b = signal(2);
    let runs = 0;
    const c = computed(() => (runs++, a.get() + untracked(() => b.get())));
    expect(c.get()).toBe(3);
    b.set(5);
    expect(c.get()).toBe(3);
    expect(runs).toBe(1);
  });

  it("a computed that writes a source it already read converges on the next read (F1)", () => {
    const a = signal(0);
    const c = computed(() => {
      const v = a.get();
      if (v === 1) a.set(2);
      return v;
    });
    expect(c.get()).toBe(0);
    a.set(1);
    expect(c.get()).toBe(1); // computed before the write
    expect(c.get()).toBe(2); // and not left stale
  });

  it("cycles throw instead of overflowing", () => {
    const flag = signal(false);
    const holder: { c?: ReturnType<typeof computed<number>> } = {};
    const c = computed((): number => (flag.get() ? holder.c!.get() : 0));
    holder.c = c;
    expect(c.get()).toBe(0);
    flag.set(true);
    expect(() => c.get()).toThrow("Cycle");
    expect(atRest()).toBe(true);
  });

  it("disposing a computed detaches it and freezes its value", () => {
    const a = signal(1);
    const c = computed(() => a.get() * 2);
    expect(c.get()).toBe(2);
    c.dispose();
    a.set(5);
    expect(c.get()).toBe(2);
  });
});
