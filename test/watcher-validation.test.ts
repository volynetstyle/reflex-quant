import { describe, expect, it } from "vitest";
import { Flag } from "../src/graph";
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

// Representation assertions cover the concrete check boundary as well as
// the public lifecycle tests below. Each row is valid in DEV and PROD.
describe("watcher validation flag boundary", () => {
  it.each([
    { before: false, confirmedDuringCheck: false, after: false },
    { before: true, confirmedDuringCheck: false, after: true },
    { before: false, confirmedDuringCheck: true, after: true },
  ])(
    "preserves established DIRTY through a thrown check (%j)",
    ({ before, confirmedDuringCheck, after }) => {
      const direct = signal(0);
      const first = signal(0);
      const broken = signal(false);
      const injected = new Error("validation");
      const changed = computed(() => get(first));
      const throwing = computed(() => {
        if (get(broken)) throw injected;
        return 0;
      });
      let runs = 0;
      let cleanups = 0;
      const watcher = effect(() => {
        runs++;
        get(direct);
        get(changed);
        get(throwing);
        return () => {
          cleanups++;
        };
      });
      const node = watcher as unknown as Node;
      try {
        expect(() =>
          batch(() => {
            if (before) set(direct, 1);
            if (confirmedDuringCheck) set(first, 1);
            set(broken, true);
            expect((node.flags & Flag.Dirty) !== 0).toBe(before);
          }),
        ).toThrow(injected);
        expect((node.flags & Flag.Dirty) !== 0).toBe(after);
        expect([runs, cleanups]).toEqual([1, 0]);
        set(broken, false);
        expect([runs, cleanups]).toEqual(after ? [2, 1] : [1, 0]);
      } finally {
        dispose(watcher);
      }
    },
  );
});

describe("watcher validation barrier", () => {
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
});
