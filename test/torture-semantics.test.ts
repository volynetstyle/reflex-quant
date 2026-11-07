import { describe, expect, it } from "vitest";
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
import { dev } from "./support/mode";

describe("torture: failure and recovery", () => {
  it("failed computed retries on the next demand even when nothing changed", () => {
    let calls = 0;

    const c = computed(() => {
      if (++calls === 1) {
        throw new Error("first");
      }
      return 42;
    });

    expect(() => get(c)).toThrow("first");
    expect(get(c)).toBe(42);
    expect(calls).toBe(2);
    expect(idle()).toBe(true);
  });

  it("failed computed retries after A → B → A", () => {
    const source = signal("a");
    let calls = 0;

    const c = computed(() => {
      const value = get(source);

      if (++calls === 1) {
        throw new Error("boom");
      }
      return value;
    });

    expect(() => get(c)).toThrow("boom");

    batch(() => {
      set(source, "b");
      set(source, "a");
    });

    expect(get(c)).toBe("a");
    expect(calls).toBe(2);
  });

  it("a failed run does not commit prev", () => {
    const mode = signal(0);
    const previous: number[] = [];

    const c = computed((prev: number) => {
      previous.push(prev);

      if (get(mode) === 1) {
        throw new Error("boom");
      }

      return prev + 1;
    }, 0);

    expect(get(c)).toBe(1);

    set(mode, 1);
    expect(() => get(c)).toThrow("boom");

    set(mode, 2);
    expect(get(c)).toBe(2);

    // The failed run saw prev=1 but did not replace it.
    expect(previous).toEqual([0, 1, 1]);
  });

  it("a computed that fails after success never exposes the stale committed value", () => {
    const source = signal(1);

    const c = computed(() => {
      const value = get(source);

      if (value === 0) {
        throw new Error("pending");
      }

      return value * 10;
    });

    expect(get(c)).toBe(10);

    set(source, 0);

    expect(() => get(c)).toThrow("pending");
    expect(() => get(c)).toThrow("pending");

    set(source, 2);
    expect(get(c)).toBe(20);
  });

  it("a failed inner read is not an observation of the outer computation", () => {
    const gate = signal(true);
    const innerSource = signal(1);
    const anchor = signal(10);

    let innerRuns = 0;
    let outerRuns = 0;

    const inner = computed(() => {
      innerRuns++;

      const value = get(innerSource);

      if (get(gate)) {
        throw new Error("inner");
      }

      return value * 2;
    });

    const outer = computed(() => {
      outerRuns++;

      let value = -1;

      try {
        value = get(inner);
      } catch {
        // Failed read must not become a committed observation.
      }

      return get(anchor) + value;
    });

    expect(get(outer)).toBe(9);
    expect(outerRuns).toBe(1);

    // innerSource wakes the failed inner, but outer must not depend on inner.
    set(innerSource, 2);

    expect(get(outer)).toBe(9);
    expect(outerRuns).toBe(1);

    // Even recovery of inner must not magically attach outer.
    set(gate, false);

    expect(get(outer)).toBe(9);
    expect(outerRuns).toBe(1);

    // Now force outer to execute. Its read succeeds and only now becomes
    // an observation.
    set(anchor, 11);

    expect(get(outer)).toBe(15);
    expect(outerRuns).toBe(2);
    expect(innerRuns).toBeGreaterThanOrEqual(2);
  });
});

describe("torture: failed watchers", () => {
  it("last-attempt reads wake a failed watcher, then disappear after recovery", () => {
    const mode = signal(0);
    const stable = signal(0);
    const tentative = signal(0);

    let runs = 0;

    const e = effect(() => {
      runs++;

      if (get(mode) === 0) {
        get(stable);
        return;
      }

      get(tentative);
      throw new Error("failed");
    });

    expect(runs).toBe(1);

    expect(() => set(mode, 1)).toThrow("failed");
    expect(runs).toBe(2);

    // tentative was read only by the failed attempt, but F3 says it must wake.
    expect(() => set(tentative, 1)).toThrow("failed");
    expect(runs).toBe(3);

    // Successful recovery commits the old branch again.
    set(mode, 0);
    expect(runs).toBe(4);

    // tentative must have disappeared from the wake frontier.
    set(tentative, 2);
    expect(runs).toBe(4);

    dispose(e);
  });

  it("a failed watcher may write, throw, and still not eat sibling work", () => {
    const trigger = signal(0);
    const retry = signal(0);
    const output = signal(0);

    let failingRuns = 0;
    let siblingRuns = 0;

    const failing = effect(() => {
      failingRuns++;

      if (get(trigger) === 1) {
        set(output, 1);
        get(retry);
        throw new Error("A");
      }
    });

    const sibling = effect(() => {
      get(output);
      siblingRuns++;
    });

    expect(failingRuns).toBe(1);
    expect(siblingRuns).toBe(1);

    // The error is delayed until the drain has delivered sibling work.
    expect(() => set(trigger, 1)).toThrow("A");

    expect(get(output)).toBe(1);
    expect(failingRuns).toBe(2);
    expect(siblingRuns).toBe(2);

    // retry was only a last-attempt read, but it must wake the failed watcher.
    expect(() => set(retry, 1)).toThrow("A");
    expect(failingRuns).toBe(3);

    dispose(failing);
    dispose(sibling);
  });

  it("validation failure happens before cleanup even if another source already proved dirty", () => {
    const direct = signal(0);
    const gate = signal(false);

    const deep = computed(() => {
      if (get(gate)) {
        throw new Error("deep");
      }

      return 1;
    });

    let runs = 0;
    let cleanups = 0;

    const e = effect(() => {
      runs++;

      // Important: direct comes first in the committed frontier.
      get(direct);
      get(deep);

      return () => {
        cleanups++;
      };
    });

    expect(runs).toBe(1);
    expect(cleanups).toBe(0);

    // direct already proves the watcher owes an execution.
    // Nevertheless P4/D1 requires validation of the later committed source.
    expect(() =>
      batch(() => {
        set(direct, 1);
        set(gate, true);
      }),
    ).toThrow("deep");

    // Irreversible lifecycle must not have started.
    expect(runs).toBe(1);
    expect(cleanups).toBe(0);

    // Repair deep. The already owed execution can now happen.
    set(gate, false);

    expect(runs).toBe(2);
    expect(cleanups).toBe(1);

    dispose(e);
  });
});

describe("torture: surface safety", () => {
  it("a non-function effect return is not mistaken for cleanup", () => {
    const source = signal(1);
    let runs = 0;

    const e = effect((() => {
      runs++;
      return get(source);
    }) as unknown as () => void);

    expect(runs).toBe(1);

    expect(() => set(source, 2)).not.toThrow();
    expect(runs).toBe(2);

    dispose(e);
  });

  it("Object.is semantics: NaN is stable, +0 → -0 is a change", () => {
    const source = signal<number>(NaN);
    let runs = 0;

    const e = effect(() => {
      get(source);
      runs++;
    });

    expect(runs).toBe(1);

    set(source, NaN);
    expect(runs).toBe(1);

    set(source, +0);
    expect(runs).toBe(2);

    set(source, -0);
    expect(runs).toBe(3);

    dispose(e);
  });

  it("a throwing batch body still flushes already committed writes", () => {
    const source = signal(0);
    const seen: number[] = [];

    const e = effect(() => {
      seen.push(get(source));
    });

    expect(() =>
      batch(() => {
        set(source, 1);
        throw new Error("body");
      }),
    ).toThrow("body");

    expect(seen).toEqual([0, 1]);
    expect(idle()).toBe(true);

    dispose(e);
  });
});

describe("RED CANDIDATES", () => {
  it("failed initial effect construction leaves no unreachable live watcher", () => {
    const source = signal(0);
    let runs = 0;

    expect(() =>
      effect(() => {
        runs++;
        get(source);
        throw new Error("setup failed");
      }),
    ).toThrow("setup failed");

    expect(runs).toBe(1);

    // No Effect handle was returned to the caller.
    // Therefore nothing live should remain in the graph.
    expect(() => set(source, 1)).not.toThrow();
    expect(runs).toBe(1);
  });
});

// C1 is a precondition, diagnosed by the development build only.
it.runIf(dev)("a cycle introduced through a validating ancestor fails loudly", () => {
  const cyclic = signal(false);

  let a!: ReturnType<typeof computed<number>>;
  let b!: ReturnType<typeof computed<number>>;

  a = computed(() => {
    if (!get(cyclic)) {
      return 0;
    }

    return get(b) + 1;
  });

  b = computed(() => get(a) + 1);

  // Initially acyclic.
  expect(get(b)).toBe(1);

  set(cyclic, true);

  // The graph is now:
  //
  // a -> b
  // b -> a
  //
  // A strict cycle policy should reject this rather than consume an older
  // committed value from an ancestor currently being validated.
  expect(() => get(b)).toThrow(/Cycle/);

  set(cyclic, false);
  expect(get(b)).toBe(1);
});

it("D2 characterization: failed computed executes before validating its old frontier", () => {
  const deepGate = signal(false);

  const deep = computed(() => {
    if (get(deepGate)) {
      throw new Error("deep");
    }

    return 1;
  });

  const outerFailure = signal(false);
  let outerRuns = 0;

  const outer = computed(() => {
    outerRuns++;

    const value = get(deep);

    if (get(outerFailure)) {
      throw new Error("outer");
    }

    return value;
  });

  expect(get(outer)).toBe(1);
  expect(outerRuns).toBe(1);

  set(outerFailure, true);

  expect(() => get(outer)).toThrow("outer");
  expect(outerRuns).toBe(2);

  // The old committed frontier can now fail too.
  set(deepGate, true);

  expect(() => get(outer)).toThrow("deep");

  // Execute-first semantics:
  expect(outerRuns).toBe(3);

  // Validate-old-frontier-first semantics would leave this at 2.
});
