import { expect, it } from "vitest";
import { computed, dispose, effect, get, set, signal } from "../src/index";

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
