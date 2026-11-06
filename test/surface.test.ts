// Surface API: operations that expose existing kernel and host semantics
// (SPEC, change class "surface API"). Each test states which existing fact
// the operation exposes; none of them relies on new state.
import { describe, expect, it } from "vitest";
import { batch, computed, effect, get, peek, set, signal, untracked, update, type Computed } from "../src/index";
import { idle } from "../src/kernel";
import type { Node } from "../src/model";
import { checkGraph } from "./support/graph";

const asNode = (handle: unknown): Node => handle as Node;
const sources = (handle: unknown): Node[] => {
  const out: Node[] = [];
  for (let e = asNode(handle).deps; e !== null; e = e.next) out.push(e.from);
  return out;
};

describe("seeded computed: prev is the last committed value", () => {
  it("prev is `initial` before the first commit, then the last committed value", () => {
    const a = signal(1);
    const seen: number[] = [];
    const total = computed((prev) => (seen.push(prev), prev + get(a)), 10);
    expect(get(total)).toBe(11);
    set(a, 2);
    expect(get(total)).toBe(13);
    expect(seen).toEqual([10, 11]);
  });

  it("without `initial`, prev is undefined before the first commit", () => {
    const seen: unknown[] = [];
    const c = computed((prev: number | undefined) => (seen.push(prev), 1));
    expect(get(c)).toBe(1);
    expect(seen).toEqual([undefined]);
  });

  it("a failed run commits nothing (F1): the next run sees the same prev", () => {
    const a = signal(1);
    const seen: number[] = [];
    const c = computed((prev) => {
      seen.push(prev);
      const v = get(a);
      if (v < 0) throw new Error("negative");
      return prev + v;
    }, 0);
    expect(get(c)).toBe(1);
    set(a, -1);
    expect(() => get(c)).toThrow("negative");
    set(a, 2);
    expect(get(c)).toBe(3);
    expect(seen).toEqual([0, 1, 1]);
    expect(idle()).toBe(true);
  });

  it("returning prev is a cutoff (P2): equality without a comparator", () => {
    const items = signal([1, 2]);
    const sorted = computed<number[]>((prev) => {
      const next = [...get(items)].sort((x, y) => x - y);
      return next.length === prev.length && next.every((v, i) => v === prev[i]) ? prev : next;
    }, []);
    let runs = 0;
    effect(() => void (get(sorted), runs++));
    expect(runs).toBe(1);
    set(items, [2, 1]); // same content once sorted: the old array is kept
    expect(runs).toBe(1);
    set(items, [3, 1]);
    expect(runs).toBe(2);
    expect(get(sorted)).toEqual([1, 3]);
  });

  it("the seed is a value like any other: a run that returns it is no change", () => {
    const a = signal(0);
    let runs = 0;
    const c = computed(() => get(a) & 0, 0);
    effect(() => void (get(c), runs++));
    set(a, 1);
    set(a, 2);
    expect(runs).toBe(1);
  });
});

describe("peek: read without observation", () => {
  it("brings a stale computed up to date without recording a relation", () => {
    const a = signal(1);
    const b = signal(1);
    let doubledRuns = 0;
    const doubled = computed(() => (doubledRuns++, get(a) * 2));
    let runs = 0;
    const c = computed(() => (runs++, get(b) + peek(doubled)));
    expect(get(c)).toBe(3);
    expect(sources(c)).toEqual([asNode(b)]);
    set(a, 5);
    expect(peek(doubled)).toBe(10); // refreshed on demand
    expect(get(c)).toBe(3); // c does not depend on doubled
    expect(runs).toBe(1);
    set(b, 2);
    expect(get(c)).toBe(12);
    expect(runs).toBe(2);
    expect(doubledRuns).toBe(2);
    checkGraph([asNode(a), asNode(b), asNode(doubled), asNode(c)]);
  });

  it("answers exactly what untracked(() => get(x)) answers", () => {
    const a = signal(1);
    const c = computed(() => get(a) + 1);
    expect(peek(a)).toBe(untracked(() => get(a)));
    set(a, 7);
    expect(peek(c)).toBe(8);
    expect(untracked(() => get(c))).toBe(8);
  });

  it("an effect that peeks a source is not woken by it", () => {
    const a = signal(1);
    const b = signal(1);
    const seen: number[] = [];
    effect(() => void seen.push(get(a) * 10 + peek(b)));
    set(b, 2);
    expect(seen).toEqual([11]);
    set(a, 2);
    expect(seen).toEqual([11, 22]);
  });

  it("peeking a computed inside its own run is a cycle, as for get", () => {
    const flag = signal(false);
    const holder: { c?: Computed<number> } = {};
    const c = computed((): number => (get(flag) ? peek(holder.c!) : 0));
    holder.c = c;
    expect(get(c)).toBe(0);
    set(flag, true);
    expect(() => get(c)).toThrow("Cycle");
    expect(idle()).toBe(true);
  });
});

describe("update: a write computed from the current value", () => {
  it("writes fn(current) and propagates like set", () => {
    const count = signal(1);
    const seen: number[] = [];
    effect(() => void seen.push(get(count)));
    update(count, (v) => v + 1);
    update(count, (v) => v * 10);
    expect(seen).toEqual([1, 2, 20]);
  });

  it("is a write, not an observation: neither the source nor fn's reads become dependencies", () => {
    const count = signal(1);
    const step = signal(10);
    const trigger = signal(0);
    let runs = 0;
    const e = effect(() => {
      get(trigger);
      runs++;
      update(count, (v) => v + get(step));
    });
    expect(peek(count)).toBe(11);
    expect(sources(e)).toEqual([asNode(trigger)]);
    set(step, 20);
    set(count, 0);
    expect(runs).toBe(1);
    set(trigger, 1);
    expect(runs).toBe(2);
    expect(peek(count)).toBe(20);
  });

  it("writes nothing when fn throws, and leaves the context intact", () => {
    const s = signal(1);
    let runs = 0;
    effect(() => void (get(s), runs++));
    expect(() =>
      update(s, () => {
        throw new Error("no");
      }),
    ).toThrow("no");
    expect(peek(s)).toBe(1);
    expect(runs).toBe(1);
    expect(idle()).toBe(true);
  });

  it("an update to the current value is no change (P1, Object.is)", () => {
    const s = signal({ n: 1 });
    let runs = 0;
    effect(() => void (get(s), runs++));
    update(s, (v) => v);
    expect(runs).toBe(1);
  });

  it("inside a batch, each update sees the previous one; the effect runs once (W4)", () => {
    const s = signal(0);
    const seen: number[] = [];
    effect(() => void seen.push(get(s)));
    batch(() => {
      update(s, (v) => v + 1);
      update(s, (v) => v + 1);
      update(s, (v) => v + 1);
    });
    expect(seen).toEqual([0, 3]);
  });
});
