// Capacity is a representation/resource bound. Trimming must cover every
// producer and every exit, and must never truncate suspended stack entries.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Flag, KEEP, TRIM } from "../src/graph";
import type { Node } from "../src/graph";
import {
  dispose,
  idle,
  node,
  read,
  stackHighWater,
  stackLength,
  untracked,
  write,
} from "../src/kernel";
import { run, stop, watcher } from "../src/host";
import { checkGraph, indexAfter } from "./support/graph";

const signal = (value: number) => node(null, value, 0);
const computed = (fn: () => unknown) => node(fn, undefined, Flag.Dirty);

function indexed(
  width: number,
  exit: "return" | "throw" | "dispose" | "dispose-throw" = "return",
) {
  const sources = Array.from({ length: width }, (_, i) => signal(i));
  let armed = true;
  const inner: Node = computed(() => {
    let value = 0;
    for (const s of sources) value += read(s) as number;
    indexAfter(inner, sources[width - 1]!);
    if (armed) {
      if (exit.startsWith("dispose")) dispose(outer);
      if (exit.endsWith("throw")) throw new Error("indexed");
    }
    return value;
  });
  const outer: Node = computed(() => {
    let value = 0;
    for (const s of sources) value += read(s) as number;
    indexAfter(outer, sources[width - 1]!);
    return value + (read(inner) as number) + (read(sources[0]!) as number);
  });
  return {
    outer,
    inner,
    sources,
    recover: () => {
      armed = false;
    },
  };
}

function chain(depth: number, branches = false, body?: (s: Node) => unknown) {
  const s = signal(0);
  const nodes = [computed(() => (body ? body(s) : read(s)))];
  read(nodes[0]!);
  for (let i = 0; i < depth; i++) {
    const below = nodes[i]!;
    const c = computed(() => (read(below) as number) + 1);
    read(c);
    nodes.push(c);
    if (branches) read(computed(() => read(below)));
  }
  return { s, end: nodes[depth]!, nodes };
}

describe("work stack reclamation", () => {
  it("wide nested runs agree with an independent sum model across change, failure and recovery", () => {
    fc.assert(
      fc.property(
        fc.record({
          width: fc.integer({ min: KEEP + 1, max: TRIM * 2 }),
          depth: fc.integer({ min: 2, max: 5 }),
          failure: fc.nat(),
          untrack: fc.boolean(),
        }),
        ({ width, depth, failure, untrack }) => {
          const sources = Array.from({ length: width }, (_, i) => signal(i));
          const tick = signal(0);
          const readers: Node[] = [];
          let broken = -1;
          for (let level = 0; level < depth; level++) {
            const below = readers[level - 1];
            const c: Node = computed(() => {
              const t = read(tick) as number;
              let value = 0;
              for (let i = 0; i < width; i++)
                value += read(sources[t & 1 ? width - i - 1 : i]!) as number;
              indexAfter(c, sources[t & 1 ? 0 : width - 1]!);
              if (below !== undefined)
                value += (
                  untrack ? untracked(() => read(below)) : read(below)
                ) as number;
              if (broken === level) throw new Error("model failure");
              return value;
            });
            readers.push(c);
          }
          const root = readers[depth - 1]!;
          const settled = () => {
            expect(stackLength()).toBeLessThanOrEqual(TRIM);
            expect(idle()).toBe(true);
            checkGraph(readers);
          };
          const initial = (width * (width - 1)) / 2;
          expect(read(root)).toBe(depth * initial);
          settled();
          write(sources[0]!, 1);
          expect(read(root)).toBe(depth * (initial + 1));
          settled();
          broken = failure % depth;
          write(tick, 1);
          expect(() => read(root)).toThrow("model failure");
          settled();
          broken = -1;
          write(tick, 2);
          expect(read(root)).toBe(depth * (initial + 1));
          settled();
        },
      ),
      {
        numRuns: Number(process.env.QUANT_TRIM_RUNS ?? 200),
        seed: Number(process.env.QUANT_SEED ?? 7),
      },
    );
  });

  it("keeps the hysteresis boundary: TRIM stays, TRIM + 1 shrinks", () => {
    read(indexed(TRIM + 1).outer);
    for (const width of [KEEP + 1, TRIM, TRIM + 1]) {
      const { outer } = indexed(width);
      expect(read(outer)).toBe(width * (width - 1));
      expect(stackLength()).toBe(width > TRIM ? KEEP : width);
      expect(idle()).toBe(true);
      checkGraph([outer]);
    }
  });

  it.each(["return", "throw", "dispose", "dispose-throw"] as const)(
    "reclaims a cold dirty execution after %s",
    (exit) => {
      const f = indexed(TRIM + 17, exit);
      if (exit.endsWith("throw"))
        expect(() => read(f.outer)).toThrow("indexed");
      else read(f.outer);
      expect(stackLength()).toBe(KEEP);
      expect(stackHighWater()).toBeGreaterThan(TRIM);
      expect(idle()).toBe(true);
      checkGraph([f.outer, f.inner, ...f.sources]);
      if (exit === "throw") {
        f.recover();
        expect(read(f.outer)).toBe(f.sources.length * (f.sources.length - 1));
        expect(stackLength()).toBe(KEEP);
        checkGraph([f.outer]);
      }
    },
  );

  it.each([false, true])("reclaims a deep validation (throw: %s)", (throws) => {
    const { s, end, nodes } = chain(1200, false, (source) => {
      const value = read(source) as number;
      if (throws && value === 1) throw new Error("validation");
      return value;
    });
    write(s, 1);
    if (throws) expect(() => read(end)).toThrow("validation");
    else expect(read(end)).toBe(1201);
    expect(stackLength()).toBe(KEEP);
    expect(idle()).toBe(true);
    checkGraph(nodes);
    write(s, 2);
    expect(read(end)).toBe(1202);
    expect(stackLength()).toBe(KEEP);
  });

  it("reclaims a deep mark without waiting for any later demand", () => {
    const { s, end } = chain(1200, true);
    write(s, 1);
    expect(stackLength()).toBe(KEEP);
    expect(stackHighWater()).toBeGreaterThan(TRIM);
    expect(idle()).toBe(true);
    expect(read(end)).toBe(1201);
    checkGraph([end]);
  });

  it.each([false, true])(
    "covers direct watcher execution outside pull (throw: %s)",
    (throws) => {
      const f = indexed(TRIM + 17, throws ? "throw" : "return");
      const w = watcher(() => read(f.outer), false);
      if (throws) expect(() => run(w)).toThrow("indexed");
      else run(w);
      expect(stackLength()).toBe(KEEP);
      expect(idle()).toBe(true);
      checkGraph([w, f.outer, f.inner, ...f.sources]);
      stop(w);
    },
  );

  it.each([false, true])(
    "preserves suspended validation entries across untracked (throw: %s)",
    (throws) => {
      const f = indexed(TRIM + 17, throws ? "throw" : "return");
      let observed = false;
      const { s, end, nodes } = chain(1200, false, (source) => {
        const value = read(source) as number;
        if (value !== 0) {
          untracked(() => {
            // active is null here, but the outer graph walk is suspended.
            if (throws) expect(() => read(f.outer)).toThrow("indexed");
            else read(f.outer);
            expect(stackLength()).toBeGreaterThan(TRIM);
            observed = true;
          });
        }
        return value;
      });
      write(s, 1);
      expect(read(end)).toBe(1201);
      expect(observed).toBe(true);
      expect(stackLength()).toBe(KEEP);
      expect(idle()).toBe(true);
      checkGraph([...nodes, f.outer, f.inner]);
    },
  );

  it("an empty stack may be reclaimed inside untracked while a user callback is suspended", () => {
    const f = indexed(TRIM + 17);
    const tail = signal(7);
    let observed = false;
    const outer = computed(() => {
      read(tail);
      untracked(() => {
        expect(idle()).toBe(true); // empty kernel registers, not an empty JS call stack
        read(f.outer);
        observed = true;
      });
      return read(tail);
    });
    expect(read(outer)).toBe(7);
    expect(observed).toBe(true);
    expect(stackLength()).toBe(KEEP);
    expect(idle()).toBe(true);
    checkGraph([outer, f.outer]);
  });
});
