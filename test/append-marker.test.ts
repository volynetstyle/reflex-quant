import { Flag } from "../src/graph";
// The append marker (AT_END in the kernel): a pass whose last accepted read
// appended keeps the relation "cursor is lastDep" instead of the edge. These
// witnesses pin that the relation answers exactly what the edge would:
// repeats (A, B, B, C), nesting, failure and recovery during a first build,
// and a first build that switches to the slot index.
import { beforeEach, describe, expect, it } from "vitest";
import { idle, createNode, read, stats, write } from "../src/kernel";
import type { Node } from "../src/graph";
import { checkGraph, deps, resetStats } from "./support/graph";

const signal = (v: unknown) => createNode(null, v, 0);
const computed = (fn: (prev: unknown) => unknown) => createNode(fn, undefined, Flag.Dirty);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

beforeEach(resetStats);

describe("append marker", () => {
  it("A, B, B, C: a repeat of the appended source is a repeat, not a relation", () => {
    const [a, b, cc] = [signal(1), signal(10), signal(100)];
    const c = computed(() => (read(a) as number) + (read(b) as number) + (read(b) as number) + (read(cc) as number));
    expect(read(c)).toBe(121);
    expect(deps(c)).toEqual([a, b, cc]);
    // The repeat kept the first observation; a change of b reruns once.
    write(b, 20);
    expect(read(c)).toBe(141);
    expect(deps(c)).toEqual([a, b, cc]);
    checkGraph([c]);
    expect(idle()).toBe(true);
  });

  it("A, B, A, C: a repeat behind the appended edge is found in the prefix", () => {
    const [a, b, cc] = [signal(1), signal(10), signal(100)];
    const c = computed(() => (read(a) as number) + (read(b) as number) + (read(a) as number) + (read(cc) as number));
    expect(read(c)).toBe(112);
    expect(deps(c)).toEqual([a, b, cc]);
    checkGraph([c]);
  });

  it("a nested first build keeps the enclosing pass's appended cursor", () => {
    const [a, b, x] = [signal(1), signal(2), signal(40)];
    const d = computed(() => (read(x) as number) + (read(x) as number));
    // a appended, then d builds its own list, then b and a repeat of a.
    const c = computed(() => (read(a) as number) + (read(d) as number) + (read(b) as number) + (read(b) as number) + (read(a) as number));
    expect(read(c)).toBe(1 + 80 + 2 + 2 + 1);
    expect(deps(c)).toEqual([a, d, b]);
    expect(deps(d)).toEqual([x]);
    write(x, 41);
    expect(read(c)).toBe(1 + 82 + 2 + 2 + 1);
    checkGraph([c]);
    expect(idle()).toBe(true);
  });

  it("a first build that throws keeps its reads as the wake set and recovers exactly", () => {
    const [a, b, z] = [signal(1), signal(2), signal(3)];
    let fail = true;
    const c = computed(() => {
      let sum = (read(a) as number) + (read(b) as number) + (read(b) as number);
      if (fail) throw new Error("first build");
      sum += read(z) as number;
      return sum;
    });
    expect(() => read(c)).toThrow("first build");
    expect(deps(c)).toEqual([a, b]);
    expect(idle()).toBe(true);
    fail = false;
    write(b, 5);
    expect(read(c)).toBe(1 + 5 + 5 + 3);
    expect(deps(c)).toEqual([a, b, z]);
    checkGraph([c]);
  });

  it("a throw inside a nested first build leaves both passes exact", () => {
    const [a, b, x] = [signal(1), signal(2), signal(3)];
    let fail = true;
    const d = computed(() => {
      const v = read(x) as number;
      if (fail) throw new Error("inner");
      return v * 10;
    });
    const c = computed(() => {
      let sum = read(a) as number;
      try {
        sum += read(d) as number;
      } catch {
        sum += 1000;
      }
      return sum + (read(b) as number) + (read(a) as number);
    });
    // A read that throws in its pull records no relation: c caught it.
    expect(read(c)).toBe(1 + 1000 + 2 + 1);
    expect(deps(c)).toEqual([a, b]);
    expect(deps(d)).toEqual([x]);
    fail = false;
    write(x, 4);
    expect(read(c)).toBe(1004);
    write(a, 2);
    expect(read(c)).toBe(2 + 40 + 2 + 2);
    expect(deps(c)).toEqual([a, d, b]);
    checkGraph([c]);
    expect(idle()).toBe(true);
  });

  it("a first build that indexes claims the appended edges and repeats exactly", () => {
    // Shared sources: each has more subscribers than the lookup budget, so a
    // repeat read far behind the cursor indexes the pass, and every later
    // append is claimed through the marker.
    const ps = range(24).map((i) => signal(i));
    const others = range(12).map(() => computed(() => ps.reduce((t, p) => t + (read(p) as number), 0)));
    for (const o of others) read(o);
    const c = computed(() => {
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += read(ps[i]!) as number;
      sum += read(ps[0]!) as number; // repeat far behind the cursor
      for (let i = 12; i < 24; i++) sum += read(ps[i]!) as number;
      sum += read(ps[23]!) as number; // repeat of the appended source
      sum += read(ps[5]!) as number; // repeat in the indexed prefix
      return sum;
    });
    const total = range(24).reduce((t, i) => t + i, 0);
    expect(read(c)).toBe(total + 0 + 23 + 5);
    expect(stats.indexes).toBeGreaterThan(0);
    expect(deps(c)).toEqual(ps);
    write(ps[23]!, 100);
    expect(read(c)).toBe(total - 23 + 100 + 0 + 100 + 5);
    expect(deps(c)).toEqual(ps);
    checkGraph([c, ...others] as Node[]);
    expect(idle()).toBe(true);
  });
});
