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

describe("failure recovery boundaries", () => {
  // Open F4 witness. The watcher consumed the notification for a path the
  // validator never entered. Keep the target behavior visible while testing
  // alternatives to walking backwards from the failed watcher.
  it.fails("re-delivers through an unvisited branch on each new push after a failed check (F4)", () => {
    const a = signal(0);
    const b = signal(0);
    const unrelated = signal(0);
    const injected = new Error("left");
    let broken = true;
    let leftChecks = 0;
    const left = computed(() => {
      const value = get(a);
      leftChecks++;
      if (broken && value === 1) throw injected;
      return value;
    });
    const leaf = computed(() => get(b));
    const right = computed(() => get(leaf));
    const seen: [number, number][] = [];
    const watcher = effect(() => {
      seen.push([get(left), get(right)]);
    });

    expect(() =>
      batch(() => {
        set(a, 1);
        set(b, 1);
      }),
    ).toThrow(injected);
    set(unrelated, 1);
    expect(leftChecks).toBe(2);
    // B bypasses the failed source. Its two pending computeds must let a
    // new push reach the watcher, including after another failed delivery.
    expect(() => set(b, 2)).toThrow(injected);
    expect(() => set(b, 3)).toThrow(injected);
    expect(seen).toEqual([[0, 0]]);
    broken = false;
    set(b, 4);
    expect(seen).toEqual([
      [0, 0],
      [1, 4],
    ]);
    dispose(watcher);
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
    for (const input of shared) expect((input as unknown as Node).slot).toBeNull();
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
