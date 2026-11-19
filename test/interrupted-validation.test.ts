import { describe, expect, it } from "vitest";
import { Flag } from "../src/graph";
import type { Node } from "../src/graph";
import { computed, dispose, effect, get, set, signal } from "../src/index";
import { idle } from "../src/kernel";

function interruptedChain() {
  const source = signal(0);
  const direct = signal(0);
  const failure = new RangeError("leaf");
  let broken = true;
  let leafRuns = 0;
  let rootRuns = 0;
  const leaf = computed(() => {
    leafRuns++;
    if (get(source) === 1 && broken) throw failure;
    return 0;
  });
  const root = computed(() => {
    rootRuns++;
    return get(leaf) + get(direct);
  });
  get(root);
  set(source, 1);
  expect(() => get(root)).toThrow(failure);
  return {
    source,
    direct,
    root,
    node: root as unknown as Node,
    failure,
    repair: () => {
      broken = false;
    },
    counts: () => [leafRuns, rootRuns],
  };
}

it("retries an interrupted validation on demand and preserves cutoff (D8)", () => {
  const chain = interruptedChain();
  expect(() => get(chain.root)).toThrow(chain.failure);
  expect(chain.counts()).toEqual([3, 1]);

  chain.repair();
  expect(get(chain.root)).toBe(0);
  expect(chain.counts()).toEqual([4, 1]);
});

it("delivers again through the interrupted path after a causal write (D8)", () => {
  const source = signal(0);
  const failure = new Error("leaf");
  const leaf = computed(() => {
    const value = get(source);
    if (value === 1) throw failure;
    return value;
  });
  const middle = computed(() => get(leaf));
  const root = computed(() => get(middle));
  const seen: number[] = [];
  const watcher = effect(() => {
    seen.push(get(root));
  });
  expect(() => set(source, 1)).toThrow(failure);
  expect(seen).toEqual([0]);
  set(source, 2);
  expect(seen).toEqual([0, 2]);
  dispose(watcher);
});

it("validates a 100,000-deep warm chain after a failed leaf body (D8, S7)", () => {
  const depth = 100_000;
  const source = signal(0);
  const failure = new Error("leaf");
  let root = computed(() => {
    const value = get(source);
    if (value === 1) throw failure;
    return value;
  });
  get(root);
  for (let i = 1; i < depth; i++) {
    const child = root;
    root = computed(() => get(child) + 1);
    get(root);
  }
  set(source, 1);
  expect(() => get(root)).toThrow(failure);
  expect(idle()).toBe(true);
  set(source, 2);
  expect(get(root)).toBe(depth + 1);
  expect(idle()).toBe(true);
});

describe("Interrupted validation representation", () => {
  it.each([false, true])(
    "consumes overlapping pending flags after a causal push (direct %s)",
    (direct) => {
      const chain = interruptedChain();
      expect(chain.node.flags).toBe(Flag.Unverified);
      expect(() => get(chain.root)).toThrow(chain.failure);
      expect(chain.node.flags).toBe(Flag.Unverified);
      chain.repair();
      if (direct) set(chain.direct, 1);
      else set(chain.source, 2);

      const validation = Flag.Unverified | Flag.Stale;
      expect(chain.node.flags).toBe(
        direct ? validation | Flag.Dirty : validation,
      );
      expect(get(chain.root)).toBe(direct ? 1 : 0);
      expect(chain.counts()).toEqual([4, direct ? 2 : 1]);
      expect(chain.node.flags).toBe(0);
    },
  );

  it("clears interrupted validation on disposal", () => {
    const chain = interruptedChain();
    expect(chain.node.flags).toBe(Flag.Unverified);
    dispose(chain.root);
    set(chain.source, 2);
    expect(get(chain.root)).toBe(0);
    expect(chain.counts()).toEqual([2, 1]);
    expect(chain.node.flags).toBe(0);
  });

  it("keeps DIRTY from a write during the interrupted validation", () => {
    const direct = signal(0);
    const source = signal(false);
    const failure = new Error("leaf");
    const leaf = computed(() => {
      if (get(source)) {
        set(direct, 1);
        throw failure;
      }
      return 0;
    });
    const root = computed(() => get(direct) + get(leaf));
    expect(get(root)).toBe(0);
    set(source, true);
    expect(() => get(root)).toThrow(failure);
    expect((root as unknown as Node).flags).toBe(Flag.Dirty);
    set(source, false);
    expect(get(root)).toBe(1);
  });
});
