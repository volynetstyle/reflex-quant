import { describe, expect, it } from "vitest";
import { Flag } from "../src/graph";
import type { Node } from "../src/graph";
import { compute, computed, dispose, effect, read, set, signal } from "../src/index";
import { idle } from "../src/kernel";

function interruptedChain() {
  const source = signal(0);
  const direct = signal(0);
  const failure = new RangeError("Maximum call stack size exceeded");
  let broken = true;
  let leafRuns = 0;
  let rootRuns = 0;
  const leaf = computed(() => {
    leafRuns++;
    if (read(source) === 1 && broken) throw failure;
    return 0;
  });
  const root = computed(() => {
    rootRuns++;
    return compute(leaf) + read(direct);
  });
  compute(root);
  set(source, 1);
  expect(() => compute(root)).toThrow(failure);
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
  expect(() => compute(chain.root)).toThrow(chain.failure);
  expect(chain.counts()).toEqual([3, 1]);

  chain.repair();
  expect(compute(chain.root)).toBe(0);
  expect(chain.counts()).toEqual([4, 1]);
});

it("delivers again through the interrupted path after a causal write (D8)", () => {
  const source = signal(0);
  const failure = new Error("leaf");
  const leaf = computed(() => {
    const value = read(source);
    if (value === 1) throw failure;
    return value;
  });
  const middle = computed(() => compute(leaf));
  const root = computed(() => compute(middle));
  const seen: number[] = [];
  const watcher = effect(() => {
    seen.push(compute(root));
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
    const value = read(source);
    if (value === 1) throw failure;
    return value;
  });
  compute(root);
  for (let i = 1; i < depth; i++) {
    const child = root;
    root = computed(() => compute(child) + 1);
    compute(root);
  }
  set(source, 1);
  expect(() => compute(root)).toThrow(failure);
  expect(idle()).toBe(true);
  set(source, 2);
  expect(compute(root)).toBe(depth + 1);
  expect(idle()).toBe(true);
});

describe("Interrupted validation representation", () => {
  it.each([false, true])(
    "consumes overlapping pending flags after a causal push (direct %s)",
    (direct) => {
      const chain = interruptedChain();
      expect(chain.node.flags).toBe(Flag.Unverified);
      expect(() => compute(chain.root)).toThrow(chain.failure);
      expect(chain.node.flags).toBe(Flag.Unverified);
      chain.repair();
      if (direct) set(chain.direct, 1);
      else set(chain.source, 2);

      const validation = Flag.Unverified | Flag.Stale;
      expect(chain.node.flags).toBe(
        direct ? validation | Flag.Dirty : validation,
      );
      expect(compute(chain.root)).toBe(direct ? 1 : 0);
      expect(chain.counts()).toEqual([4, direct ? 2 : 1]);
      expect(chain.node.flags).toBe(0);
    },
  );

  it("clears interrupted validation on disposal", () => {
    const chain = interruptedChain();
    expect(chain.node.flags).toBe(Flag.Unverified);
    dispose(chain.root);
    set(chain.source, 2);
    expect(compute(chain.root)).toBe(0);
    expect(chain.counts()).toEqual([2, 1]);
    expect(chain.node.flags).toBe(0);
  });

  it("keeps DIRTY from a write during the interrupted validation", () => {
    const direct = signal(0);
    const source = signal(false);
    const failure = new Error("leaf");
    const leaf = computed(() => {
      if (read(source)) {
        set(direct, 1);
        throw failure;
      }
      return 0;
    });
    const root = computed(() => read(direct) + compute(leaf));
    expect(compute(root)).toBe(0);
    set(source, true);
    expect(() => compute(root)).toThrow(failure);
    expect((root as unknown as Node).flags).toBe(Flag.Dirty);
    set(source, false);
    expect(compute(root)).toBe(1);
  });
});
