import { expect, it } from "vitest";
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
import type { Effect } from "../src/index";

it.each(["changed", "unchanged", "owed", "cleanup throws", "pull throws"])(
  "ends a disposed watcher's validation after the current pull (Q1, %s)",
  (mode) => {
    const source = signal(0);
    const direct = signal(0);
    const failure = new Error(mode);
    const events: string[] = [];
    let watcher: Effect;
    const first = computed(() => {
      const value = get(source);
      if (value === 1) {
        dispose(watcher);
        if (mode === "pull throws") throw failure;
      }
      return mode === "unchanged" ? 0 : value;
    });
    const later = computed(() => {
      if (get(source) === 1) throw new Error("detached source");
      return 0;
    });
    watcher = effect(() => {
      events.push("body");
      get(first);
      get(later);
      get(direct);
      return () => {
        events.push("cleanup");
        if (mode === "cleanup throws") throw failure;
      };
    });

    const invalidate = () =>
      batch(() => {
        set(source, 1);
        if (mode === "owed") set(direct, 1);
      });
    if (mode.endsWith("throws")) expect(invalidate).toThrow(failure);
    else expect(invalidate).not.toThrow();

    // Terminal: no later write runs it, and teardown left no relation.
    set(source, 2);
    set(direct, 2);
    expect(events).toEqual(["body", "cleanup"]);
    expect((watcher as unknown as Node).firstDep).toBeNull();
  },
);

it("rechecks a committed source made stale by a later source before cleanup (RQ3, P4)", () => {
  const trigger = signal(0);
  const gate = signal(false);
  const error = new Error("earlier source");
  const first = computed(() => {
    if (get(gate)) throw error;
    return 0;
  });
  const second = computed(() => {
    const value = get(trigger);
    if (value === 1) set(gate, true);
    return value;
  });
  const events: string[] = [];
  const watcher = effect(() => {
    events.push("body");
    get(first);
    get(second);
    return () => {
      events.push("cleanup");
    };
  });

  expect(() => set(trigger, 1)).toThrow(error);
  expect(events).toEqual(["body"]);
  set(gate, false);
  expect(events).toEqual(["body", "cleanup", "body"]);
  dispose(watcher);
});

it("checks a pending source on demand after the first computed subscription (RQ1b)", () => {
  const input = signal(0);
  const source = computed(() => {
    const value = get(input);
    if (value === 0) set(input, 1);
    return value;
  });
  const reader = computed(() => get(source));

  expect(get(reader)).toBe(0);
  expect(get(reader)).toBe(1);
  set(input, 2);
  expect(get(reader)).toBe(2);
});

it("preserves cutoff when a newly linked pending source validates unchanged (RQ1b, P2)", () => {
  const input = signal(0);
  let checks = 0;
  const source = computed(() => {
    checks++;
    if (get(input) === 0) set(input, 1);
    return 0;
  });
  const observed: number[] = [];
  const watcher = effect(() => {
    observed.push(get(source));
  });
  expect(checks).toBe(2);
  expect(observed).toEqual([0]);
  dispose(watcher);
});

it("hands off pending validation for an edge added during indexed tracking (RQ1b)", () => {
  const reorder = signal(false);
  const inputs = Array.from({ length: 24 }, () => signal(0));
  const pivot = inputs[12]!;
  const firstReader = computed(() => get(pivot));
  get(firstReader);

  const input = signal(0);
  const source = computed(() => {
    const value = get(input);
    if (value === 0) set(input, 1);
    return value;
  });
  let indexedAttachment = false;
  const reader = computed(() => {
    let value = 0;
    if (get(reorder)) {
      get(pivot);
      indexedAttachment ||= (pivot as unknown as Node).slot !== null;
      value = get(source);
    }
    for (const input of inputs) get(input);
    return value;
  });

  expect(get(reader)).toBe(0);
  set(reorder, true);
  expect(get(reader)).toBe(0);
  expect(indexedAttachment).toBe(true);
  expect(get(reader)).toBe(1);
});

it.each(["execution", "validation"])(
  "delivers to a watcher linked while its source became pending (%s, RQ1b/c)",
  (phase) => {
    const input = signal(0);
    const trigger = signal(false);
    const later = computed(() => {
      if (get(trigger)) set(input, 1);
      return 0;
    });
    const source = computed(() => {
      const value = get(input);
      if (phase === "validation") get(later);
      else if (value === 0) set(input, 1);
      return value;
    });
    if (phase === "validation") {
      expect(get(source)).toBe(0);
      set(trigger, true);
    }
    const seen: number[] = [];
    const watcher = effect(() => {
      seen.push(get(source));
    });
    expect(seen).toEqual([0, 1]);
    set(input, 2);
    expect(seen).toEqual([0, 1, 2]);
    dispose(watcher);
  },
);
