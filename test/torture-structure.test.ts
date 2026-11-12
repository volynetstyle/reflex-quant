import { beforeEach, describe, expect, it } from "vitest";
import {
  computed,
  dispose,
  effect,
  get,
  set,
  signal,
} from "../src/index";
import {
  idle,
  stats,
} from "../src/kernel";
import type { Node } from "../src/graph";
import {
  checkGraph,
  edgeCount,
  resetStats,
} from "./support/graph";

const range = (n: number) =>
  Array.from({ length: n }, (_, i) => i);

beforeEach(resetStats);

describe("torture: repeated failed frontiers", () => {
  it("a failed computed retains only the current attempt frontier", () => {
    const choices = range(64).map(i => signal(i));
    const pick = signal(0);
    const failing = signal(false);

    let runs = 0;

    const c = computed(() => {
      runs++;

      const i = get(pick);
      const value = get(choices[i]!);

      if (get(failing)) {
        throw new Error("boom");
      }

      return value;
    });

    expect(get(c)).toBe(0);

    set(failing, true);

    const node = c as unknown as Node;

    for (let i = 1; i < 64; i++) {
      set(pick, i);

      expect(() => get(c)).toThrow("boom");

      // committed:
      //   pick
      //   choices[0]
      //   failing
      //
      // current failed attempt may additionally retain choices[i].
      expect(edgeCount([node])).toBeLessThanOrEqual(4);

      checkGraph(
        [node, pick, failing, ...choices] as unknown as Node[],
        `failure ${i}`,
      );
    }

    set(failing, false);

    expect(get(c)).toBe(63);

    // Successful recovery commits exactly the new branch.
    expect(edgeCount([node])).toBe(3);

    const runsAfterRecovery = runs;

    // Old committed branch must finally be gone.
    set(choices[0]!, 1000);

    expect(get(c)).toBe(63);
    expect(runs).toBe(runsAfterRecovery);
    expect(idle()).toBe(true);
  });
});

describe("torture: tracking index under failure", () => {
  it("random reorder + failure reuses every existing relation", () => {
    const n = 64;
    const sources = range(n).map(signal);

    // Put the real reader deeper than SCAN in every subscriber list.
    const fillers = range(10).map(() =>
      computed(() =>
        sources.reduce((sum, source) => sum + get(source), 0),
      ),
    );

    fillers.forEach(get);

    const tick = signal(0);
    const failing = signal(false);

    const normal = range(n);
    const reverse = [...normal].reverse();

    const c = computed(() => {
      const order = get(tick) & 1 ? reverse : normal;

      let sum = 0;

      for (const i of order) {
        sum += get(sources[i]!);
      }

      if (get(failing)) {
        throw new Error("boom");
      }

      return sum;
    });

    get(c);

    const node = c as unknown as Node;
    const expectedEdges = n + 2; // tick + failing + sources

    expect(edgeCount([node])).toBe(expectedEdges);

    set(failing, true);
    resetStats();

    for (let pass = 1; pass <= 50; pass++) {
      set(tick, pass);

      expect(() => get(c)).toThrow("boom");

      expect(edgeCount([node])).toBe(expectedEdges);
      expect(stats.links).toBe(0);

      checkGraph(
        [node, tick, failing, ...sources] as unknown as Node[],
        `reorder failure ${pass}`,
      );
    }

    // This workload should actually visit the difficult lookup path.
    expect(stats.indexes).toBeGreaterThan(0);
    expect(idle()).toBe(true);
  });
});

it("dispose during an indexed reordered pass restores every slot", () => {
  const n = 64;
  const sources = range(n).map(signal);

  const fillers = range(10).map(() =>
    computed(() =>
      sources.reduce((sum, source) => sum + get(source), 0),
    ),
  );

  fillers.forEach(get);

  const flip = signal(false);
  let runs = 0;

  let e!: ReturnType<typeof effect>;

  e = effect(() => {
    runs++;

    const order = get(flip)
      ? [...range(n)].reverse()
      : range(n);

    for (let k = 0; k < order.length; k++) {
      get(sources[order[k]!]!);

      if (get(flip) && k === 20) {
        dispose(e);
      }
    }
  });

  expect(runs).toBe(1);

  resetStats();
  set(flip, true);

  expect(runs).toBe(2);
  expect(stats.indexes).toBeGreaterThan(0);

  const node = e as unknown as Node;

  expect(node.firstDep).toBeNull();

  for (const source of sources as unknown as Node[]) {
    expect(source.slot).toBeNull();
  }

  checkGraph(
    [flip, ...sources] as unknown as Node[],
    "disposed indexed pass",
  );

  for (const source of sources) {
    set(source, 999);
  }

  expect(runs).toBe(2);
  expect(idle()).toBe(true);
});

it("nested indexed failure restores the enclosing reader's slot state", () => {
  const n = 64;
  const sources = range(n).map(signal);

  // Ensure both real readers are deep subscribers.
  const fillers = range(10).map(() =>
    computed(() =>
      sources.reduce((sum, source) => sum + get(source), 0),
    ),
  );
  fillers.forEach(get);

  const innerTick = signal(0);
  const outerTick = signal(0);
  const failInner = signal(false);

  const normal = range(n);
  const reverse = [...normal].reverse();

  let innerSawOuterIndex = false;
  let innerFailures = 0;
  const inner = computed(() => {
    const order = get(innerTick) ? reverse : normal;

    if ((sources[0] as unknown as Node).slot !== null) {
      innerSawOuterIndex = true;
    }
    let sum = 0;

    for (const i of order) {
      sum += get(sources[i]!);
    }

    if (get(failInner)) {
      innerFailures++;
      throw new Error("inner");
    }

    return sum;
  });

  let outerRuns = 0;

  const outer = computed(() => {
    outerRuns++;

    const order = get(outerTick) ? reverse : normal;
    let sum = 0;

    // Force the outer pass into its own nontrivial reorder first.
    for (let k = 0; k < 24; k++) {
      sum += get(sources[order[k]!]!);
    }

    try {
      sum += get(inner);
    } catch {
      // F2: failed read is not an observation.
    }

    for (let k = 24; k < n; k++) {
      sum += get(sources[order[k]!]!);
    }

    return sum;
  });

  get(outer);

  set(failInner, true);
  set(innerTick, 1);
  set(outerTick, 1);

  innerSawOuterIndex = false;
  resetStats();

  // Outer catches inner failure and itself commits successfully.
  expect(() => get(outer)).not.toThrow();

  expect(outerRuns).toBe(2);
  expect(innerFailures).toBe(1);
  expect(innerSawOuterIndex).toBe(true);

  // Ideally both readers exercised their hard lookup/index path.
  expect(stats.indexes).toBeGreaterThanOrEqual(2);

  for (const source of sources as unknown as Node[]) {
    expect(source.slot).toBeNull();
  }

  checkGraph(
    [
      outer,
      inner,
      innerTick,
      outerTick,
      failInner,
      ...sources,
    ] as unknown as Node[],
    "nested indexed failure",
  );

  expect(idle()).toBe(true);
});
