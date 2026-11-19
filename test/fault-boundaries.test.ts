import { describe, expect, it } from "vitest";
import { CounterLimit } from "../src/graph";
import type { Node } from "../src/graph";
import {
  batch,
  computed,
  dispose,
  effect,
  get,
  set,
  signal,
} from "../src/index";
import { idle } from "../src/kernel";
import { ContractSpecRuntime } from "./support/contract-spec";

describe("established execution in the contract model", () => {
  it.each([false, true])(
    "retains exactly the execution obligation established before validation failed (F4, change first %s)",
    (changeFirst) => {
      const model = new ContractSpecRuntime();
      const direct = model.createProducer(0);
      const source = model.createProducer(false);
      const injected = new Error("computed");
      const computed = model.createComputed(() => {
        if (model.readProducer(source)) throw injected;
        return 0;
      });
      let runs = 0;
      const watcher = model.createWatcher(() => {
        runs++;
        if (changeFirst) model.readProducer(direct);
        model.readComputed(computed);
      });
      model.runWatcher(watcher);
      model.writeProducer(direct, 1);
      model.writeProducer(source, true);
      expect(() => model.runWatcher(watcher)).toThrow(injected);
      expect(watcher.executionPending).toBe(changeFirst);
      expect(runs).toBe(1);
    },
  );
});

describe("failure recovery boundaries", () => {
  it.each([false, true])(
    "coalesces an unvisited branch until a later delivery retries validation (D7, cutoff %s)",
    (cutoff) => {
      const broken = signal(false);
      const b = signal(0);
      const unrelated = signal(0);
      const injected = new Error("left");
      let leftChecks = 0;
      let rightChecks = 0;
      let cleanups = 0;
      const left = computed(() => {
        leftChecks++;
        if (get(broken)) throw injected;
        return 0;
      });
      const leaf = computed(() => {
        rightChecks++;
        const value = get(b);
        return cutoff ? 0 : value;
      });
      const right = computed(() => get(leaf));
      const seen: [number, number][] = [];
      const watcher = effect(() => {
        seen.push([get(left), get(right)]);
        return () => {
          cleanups++;
        };
      });

      try {
        expect(() =>
          batch(() => {
            set(broken, true);
            set(b, 1);
          }),
        ).toThrow(injected);
        // The failed check reaches neither the second branch nor lifecycle.
        expect([leftChecks, rightChecks, cleanups]).toEqual([2, 1, 0]);
        expect(() => set(unrelated, 1)).not.toThrow();
        expect(() => set(b, 2)).not.toThrow();
        expect(() => set(b, 3)).not.toThrow();
        expect([leftChecks, rightChecks, cleanups]).toEqual([2, 1, 0]);
        expect(seen).toEqual([[0, 0]]);

        // The failed source's own cause delivers a new validation. It
        // returns the old value; the sibling supplies its latest state.
        set(broken, false);
        expect([leftChecks, rightChecks]).toEqual([3, 2]);
        expect(seen).toEqual(
          cutoff
            ? [[0, 0]]
            : [
                [0, 0],
                [0, 3],
              ],
        );
        expect(cleanups).toBe(cutoff ? 0 : 1);
      } finally {
        dispose(watcher);
      }
    },
  );

  it("retains an established obligation through a validation barrier and unchanged recovery (F4)", () => {
    const source = signal(0);
    const broken = signal(false);
    const bodyError = new Error("body");
    const checkError = new Error("left");
    const left = computed(() => {
      if (get(broken)) throw checkError;
      return 1;
    });
    const right = computed(() => get(source) & 1);
    const attempts: [number, number][] = [];
    let failBody = false;
    let cleanups = 0;
    const watcher = effect(() => {
      attempts.push([get(left), get(right)]);
      if (failBody) throw bodyError;
      return () => {
        cleanups++;
      };
    });

    try {
      failBody = true;
      expect(() => set(source, 1)).toThrow(bodyError);
      expect(attempts).toEqual([
        [1, 0],
        [1, 1],
      ]);
      expect(cleanups).toBe(1);
      expect(() =>
        batch(() => {
          set(broken, true);
          set(source, 3);
        }),
      ).toThrow(checkError);
      expect(() => set(source, 5)).not.toThrow();
      expect(attempts).toHaveLength(2);
      expect(cleanups).toBe(1);

      failBody = false;
      set(broken, false);
      // Both computeds keep their last successful versions. The failed
      // body still owes execution even though the new check finds no change.
      expect(attempts).toEqual([
        [1, 0],
        [1, 1],
        [1, 1],
      ]);
      expect(cleanups).toBe(1);
    } finally {
      dispose(watcher);
    }
    expect(cleanups).toBe(2);
  });

  it("executes a failed computed on explicit demand after a sibling write coalesces (F1, D7)", () => {
    const a = signal(0);
    const b = signal(0);
    const injected = new Error("once");
    let once = true;
    let leftChecks = 0;
    const left = computed(() => {
      const value = get(a);
      leftChecks++;
      if (value === 1 && once) {
        once = false;
        throw injected;
      }
      return value;
    });
    const right = computed(() => get(b));
    const seen: [number, number][] = [];
    const watcher = effect(() => {
      seen.push([get(left), get(right)]);
    });

    try {
      expect(() =>
        batch(() => {
          set(a, 1);
          set(b, 1);
        }),
      ).toThrow(injected);
      set(b, 2);
      expect(leftChecks).toBe(2);
      expect(seen).toEqual([[0, 0]]);
      expect(get(left)).toBe(1);
      expect(leftChecks).toBe(3);
      set(a, 2);
      expect(seen).toEqual([
        [0, 0],
        [2, 2],
      ]);
    } finally {
      dispose(watcher);
    }
  });

  it("rechecks an interrupted validation without running ancestors when the value cuts off", () => {
    const source = signal(false);
    const injected = new Error("leaf");
    let attempts = 0;
    const leaf = computed(() => {
      if (get(source) && ++attempts === 1) throw injected;
      return 0;
    });
    let runs = 0;
    const root = computed(() => {
      runs++;
      return get(leaf);
    });

    expect(get(root)).toBe(0);
    set(source, true);
    expect(() => get(root)).toThrow(injected);
    expect(get(root)).toBe(0);
    expect(attempts).toBe(2);
    expect(runs).toBe(1);
  });

  it("retries a 100,000-deep warm validation after a leaf failure (S7)", () => {
    const depth = 100_000;
    const source = signal(0);
    const injected = new Error("leaf");
    let armed = true;
    let root = computed(() => {
      const value = get(source);
      if (value === 1 && armed) {
        armed = false;
        throw injected;
      }
      return value;
    });
    get(root);
    for (let i = 1; i < depth; i++) {
      const child = root;
      root = computed(() => get(child) + 1);
      get(root);
    }

    set(source, 1);
    expect(() => get(root)).toThrow(injected);
    expect(idle()).toBe(true);
    expect(get(root)).toBe(depth);
    expect(idle()).toBe(true);
  });

  it("releases active runs when nested callbacks exhaust the JS stack", () => {
    const depth = 20_000;
    const source = signal(0);
    const shared = Array.from({ length: 24 }, (_, value) => signal(value));
    const chain = [computed(() => get(source))];
    get(chain[0]!);
    for (let i = 1; i < depth; i++) {
      const child = chain[i - 1]!;
      const parent = computed(() => {
        const value = get(source);
        // Move a distant source before the child on the rerun. Many
        // consumers share it, so nested readers displace index slots.
        if (value !== 0) get(shared[13]!);
        const result = get(child) + 1;
        for (const input of shared) get(input);
        return result;
      });
      get(parent);
      chain.push(parent);
    }
    const root = chain[depth - 1]!;

    set(source, 1);
    try {
      expect(get(root)).toBe(depth);
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
    }
    expect(idle()).toBe(true);
    for (const input of shared)
      expect((input as unknown as Node).slot).toBeNull();
    for (const node of chain) get(node);
    expect(get(root)).toBe(depth);
  });
});

describe("version rollover", () => {
  it("preserves an in-pass obligation even when a signal version repeats after a rollover (P5)", () => {
    const source = signal(0);
    const other = signal(null);
    const node = source as unknown as Node;
    node.ver = 1;
    const seen: number[] = [];
    const watcher = effect(() => {
      const value = get(source);
      get(other);
      seen.push(value);
      if (value === 0) {
        // Fast-forward the producer, preserving the existing observation.
        node.ver = CounterLimit.Mask;
        set(source, 1);
        expect(get(source)).toBe(1);
        set(source, 2);
      }
    });

    expect(node.ver).toBe(1);
    expect(seen).toEqual([0, 2]);
    dispose(watcher);
  });

  it("expires a retained observation of a computed across rollover (P1)", () => {
    const source = signal(0);
    const producer = computed(() => get(source));
    const consumer = computed(() => get(producer));
    const node = producer as unknown as Node;
    expect(get(consumer)).toBe(0);
    expect(node.ver).toBe(1);

    node.ver = CounterLimit.Mask;
    set(source, 1);
    expect(get(producer)).toBe(1);
    set(source, 2);
    expect(get(producer)).toBe(2);
    expect(node.ver).toBe(1);
    expect(get(consumer)).toBe(2);
  });
});
