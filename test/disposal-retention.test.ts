// Structural resource witnesses: follow graph pointers from a retained
// handle through every node and edge graph field.
import { describe, expect, it } from "vitest";
import {
  batch,
  computed,
  dispose,
  effect,
  get,
  set,
  signal,
  type Computed,
  type Effect,
} from "../src/index";
import type { Edge, Node } from "../src/graph";
import { idle } from "../src/kernel";
import { checkGraph, indexAfter } from "./support/graph";

const n = (handle: object) => handle as Node;

/** Graph fields only; the fixtures use primitive cached values. */
function graphReachable(root: Node): number {
  const seen = new Set<Node | Edge>();
  const pending: (Node | Edge | null)[] = [root];
  while (pending.length !== 0) {
    const item = pending.pop()!;
    if (item === null || seen.has(item)) continue;
    seen.add(item);
    if ("from" in item)
      pending.push(
        item.from,
        item.to,
        item.prev,
        item.next,
        item.prevSub,
        item.nextSub,
      );
    else pending.push(item.deps, item.slot, item.subs, item.lastSub);
  }
  return seen.size;
}

function released(handle: object): void {
  const c = n(handle);
  expect(c.fn === null).toBe(true);
  expect(c.deps === null).toBe(true);
  expect(c.slot === null).toBe(true);
}

describe("disposed dependency retention", () => {
  it.each([0, 1, 8, 64, 512])(
    "a retained handle releases a %i-source dependency graph",
    (width) => {
      const sources = Array.from({ length: width }, (_, i) => signal(i + 1));
      let runs = 0;
      const c = computed(() => {
        runs++;
        return sources.reduce((sum, s) => sum + get(s), 0);
      });
      const value = (width * (width + 1)) / 2;
      expect(get(c)).toBe(value);
      dispose(c);
      // Subscriptions and all graph paths disappear while the handle is retained.
      expect(n(c).deps === null).toBe(true);
      expect(sources.every((s) => n(s).subs === null)).toBe(true);
      expect(graphReachable(n(c))).toBe(1);
      released(c);
      dispose(c);
      for (const s of sources) set(s, 99);
      expect(get(c)).toBe(value);
      expect(runs).toBe(1);
      checkGraph([n(c), ...sources.map(n)]);
      expect(idle()).toBe(true);
    },
  );

  it.each([false, true])(
    "releases the last failed attempt (established: %s)",
    (established) => {
      const old = Array.from({ length: 12 }, (_, i) => signal(i));
      const fresh = Array.from({ length: 12 }, (_, i) => signal(i + 100));
      const mode = signal(established ? 0 : 1);
      const c = computed(() => {
        const m = get(mode);
        const sources = m === 0 ? old : fresh.slice(m);
        const sum = sources.reduce((value, s) => value + get(s), 0);
        if (m !== 0) throw new Error("attempt");
        return sum;
      });
      if (established) expect(get(c)).toBe(66);
      for (const m of [1, 2, 3]) {
        set(mode, m);
        expect(() => get(c)).toThrow("attempt");
        checkGraph([n(c)]);
      }
      dispose(c);
      expect(graphReachable(n(c))).toBe(1);
      released(c);
      expect(get(c)).toBe(established ? 66 : undefined);
      checkGraph([n(c), ...old.map(n), ...fresh.map(n), n(mode)]);
      expect(idle()).toBe(true);
    },
  );

  it.each([false, true])(
    "keeps an indexed cursor until self-disposal finishes (throw: %s)",
    (throws) => {
      const tick = signal(0);
      const sources = Array.from({ length: 24 }, (_, i) => signal(i));
      const fresh = signal(100);
      let armed = false;
      const c: Computed<number> = computed(() => {
        get(tick);
        const sum = (armed ? [...sources].reverse() : sources).reduce(
          (value, s) => value + get(s),
          0,
        );
        if (armed) {
          const cn = n(c);
          const edge = indexAfter(cn, n(sources[0]!));
          dispose(c);
          expect(edge.from.slot === edge && cn.deps !== null).toBe(true);
          get(fresh);
          get(sources[0]!);
          expect(edge.from.slot === edge).toBe(true);
          if (throws) throw new Error("self-dispose");
        }
        return sum;
      });
      expect(get(c)).toBe(276);
      armed = true;
      set(tick, 1);
      if (throws) expect(() => get(c)).toThrow("self-dispose");
      else expect(get(c)).toBe(276);
      released(c);
      expect(graphReachable(n(c))).toBe(1);
      expect(get(c)).toBe(276);
      checkGraph([n(c), n(tick), n(fresh), ...sources.map(n)]);
      expect(idle()).toBe(true);
    },
  );

  it.each([false, true])(
    "releases a watcher disposed inside its own run (throw: %s)",
    (throws) => {
      const source = signal(0);
      const fresh = signal(1);
      let runs = 0;
      let cleanups = 0;
      let e!: Effect;
      e = effect(() => {
        runs++;
        if (get(source) === 1) {
          dispose(e);
          expect(n(e).deps !== null).toBe(true);
          get(fresh);
          get(source);
          if (throws) throw new Error("watcher self-dispose");
        }
        return () => {
          cleanups++;
        };
      });
      if (throws) expect(() => set(source, 1)).toThrow("watcher self-dispose");
      else set(source, 1);
      released(e);
      expect(graphReachable(n(e))).toBe(1);
      set(source, 2);
      set(fresh, 2);
      expect([runs, cleanups]).toEqual([2, 1]);
      checkGraph([e, source, fresh].map(n));
      expect(idle()).toBe(true);
    },
  );

  it.each([false, true])(
    "releases dependencies before disposal cleanup (throw: %s)",
    (throws) => {
      const source = signal(0);
      const untracked = signal(0);
      let runs = 0;
      let cleanups = 0;
      const survivor = effect(() => {
        get(source);
        runs++;
      });
      const e = effect(() => {
        get(source);
        return () => {
          cleanups++;
          released(e);
          get(untracked);
          set(source, 1);
          if (throws) throw new Error("cleanup");
        };
      });
      if (throws) expect(() => dispose(e)).toThrow("cleanup");
      else dispose(e);
      released(e);
      expect(graphReachable(n(e))).toBe(1);
      expect([runs, cleanups]).toEqual([2, 1]);
      expect(n(untracked).subs === null).toBe(true);
      dispose(e);
      dispose(survivor);
      checkGraph([n(e), n(survivor), n(source), n(untracked)]);
      expect(idle()).toBe(true);
    },
  );

  it("releases a watcher while it is queued without delivering it again", () => {
    const source = signal(0);
    let runs = 0;
    const e = effect(() => {
      get(source);
      runs++;
    });
    batch(() => {
      set(source, 1);
      dispose(e);
      released(e);
    });
    expect(runs).toBe(1);
    checkGraph([n(e), n(source)]);
    expect(idle()).toBe(true);
  });

  for (const through of [false, true])
    it.each([false, true])(
      `releases dependencies during ${through ? "indirect" : "direct"} validation (later throw: %s)`,
      (throws) => {
        const source = signal(0);
        const fault = signal(false);
        let b!: Computed<number>;
        const a = computed(() => {
          if (get(source) === 1) dispose(b);
          return 0;
        });
        const m = computed(() => get(a));
        const tail = computed(() => {
          if (get(fault)) throw new Error("validation");
          return 1;
        });
        b = computed(() => (through ? get(m) : get(a)) + get(tail));
        expect(get(b)).toBe(1);
        set(source, 1);
        set(fault, throws);
        if (throws) expect(() => get(b)).toThrow("validation");
        else expect(get(b)).toBe(1);
        released(b);
        expect(graphReachable(n(b))).toBe(1);
        expect(get(b)).toBe(1);
        checkGraph([b, a, m, tail, source, fault].map(n));
        expect(idle()).toBe(true);
      },
    );

  it("preserves frozen values and downstream subscriptions", () => {
    const source = signal(2);
    const c = computed(() => get(source) * 2);
    const d = computed(() => get(c) + 1);
    expect(get(d)).toBe(5);
    dispose(c);
    released(c);
    expect(n(c).subs !== null).toBe(true);
    set(source, 9);
    expect(get(d)).toBe(5);
    checkGraph([source, c, d].map(n));
    dispose(d);
  });

  it("keeps an object cached as the computed value", () => {
    const source = signal(1);
    const c = computed(() => {
      get(source);
      return source;
    });
    expect(get(c) === source).toBe(true);
    dispose(c);
    released(c);
    expect(get(c) === source).toBe(true);
    checkGraph([n(c), n(source)]);
  });

  it("disposes a never-demanded computed without running it", () => {
    const c = computed(() => {
      throw new Error("unreachable");
    }, 7);
    dispose(c);
    released(c);
    expect(get(c)).toBe(7);
    expect(idle()).toBe(true);
  });
});
