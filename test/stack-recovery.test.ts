import { expect, it } from "vitest";
import { Flag } from "../src/graph";
import type { Node } from "../src/graph";
import { hold, wake } from "../src/host";
import { computed, dispose, effect, get, set, signal } from "../src/index";
import { idle, onWake } from "../src/kernel";

// Run successive attempts as the native stack unwinds. The boundary
// varies between engines and optimization tiers.
function sweepStack(attempt: (i: number) => void, count: number): void {
  let next = 0;
  let failures = 0;
  function descend(): void {
    try {
      descend();
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    if (next < count) {
      try {
        attempt(next++);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        failures++;
      }
    }
  }
  descend();
  expect(next).toBe(count);
  expect(failures).toBeGreaterThan(0);
}

it("recovers indexed activations after actual callback stack exhaustion (RQ6)", () => {
  const input = signal(0);
  const shared = Array.from({ length: 24 }, () => signal(0));
  const nodes = [computed(() => get(input))];
  get(nodes[0]!);
  for (let i = 1; i < 12_000; i++) {
    const child = nodes[i - 1]!;
    const parent = computed(() => {
      const value = get(input);
      if (value !== 0) get(shared[13]!);
      const result = get(child) + 1;
      for (const source of shared) get(source);
      return result;
    });
    get(parent);
    nodes.push(parent);
  }

  set(input, 1);
  expect(() => get(nodes.at(-1)!)).toThrow(RangeError);
  expect(idle()).toBe(true);
  for (const source of shared)
    expect((source as unknown as Node).slot).toBeNull();
  for (let i = 0; i < nodes.length; i++) expect(get(nodes[i]!)).toBe(i + 1);
});

it("restores hold when creating a watcher at the native stack limit (RQ6)", () => {
  sweepStack(() => {
    const watcher = effect(() => {});
    dispose(watcher);
  }, 96);
  expect(hold).toBe(0);

  const input = signal(0);
  const seen: number[] = [];
  const watcher = effect(() => {
    seen.push(get(input));
  });
  set(input, 1);
  expect(seen).toEqual([0, 1]);
  dispose(watcher);
});

it.each([false, true])(
  "later writes reach a watcher after stack exhaustion (RQ6, computed %s)",
  (through) => {
    const trials = Array.from({ length: 96 }, () => {
      const input = signal(0);
      const source = through ? computed(() => get(input) * 2) : input;
      let seen = -1;
      const watcher = effect(() => {
        seen = get(source);
      });
      return { input, watcher, seen: () => seen };
    });
    sweepStack((i) => set(trials[i]!.input, 1), trials.length);
    expect(hold).toBe(0);
    for (const trial of trials) {
      set(trial.input, 2);
      set(trial.input, 3);
      expect(trial.seen()).toBe(through ? 6 : 3);
      expect((trial.watcher as unknown as Node).flags & Flag.Queued).toBe(0);
      dispose(trial.watcher);
    }
  },
);

it("completes validation marking when wake fails (RQ6)", () => {
  const input = signal(0);
  const first = computed(() => get(input));
  const second = computed(() => get(first));
  const third = computed(() => get(second));
  const seen: number[] = [];
  const watcher = effect(() => {
    seen.push(get(third));
  });
  const later = computed(() => get(second) + 10);
  expect(get(later)).toBe(10);
  const error = new RangeError("wake");
  onWake(() => {
    throw error;
  });
  try {
    expect(() => set(input, 1)).toThrow(error);
    expect(idle()).toBe(true);
    for (const node of [first, second, third]) {
      expect((node as unknown as Node).flags & Flag.Validate).toBe(
        Flag.Unverified,
      );
    }
    expect(get(later)).toBe(11);
  } finally {
    onWake(wake);
  }
  set(input, 2);
  expect(seen).toEqual([0, 2]);
  dispose(watcher);
});
