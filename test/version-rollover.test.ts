import { expect, it } from "vitest";
import { CounterLimit } from "../src/graph";
import type { Node } from "../src/graph";
import { computed, dispose, effect, get, set, signal } from "../src/index";

it("retains an in-pass obligation across a signal version wrap (RQ5, P5)", () => {
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
      // Advance the producer clock without changing the recorded observation.
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

it("expires an unvalidated computed observation when its source wraps (RQ5, P1)", () => {
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
