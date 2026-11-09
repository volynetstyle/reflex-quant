// Representation tests: exercise indexed runs directly so scan heuristics
// cannot make a supposed slot-restoration witness skip the index entirely.
import { describe, expect, it } from "vitest";
import { Flag } from "../src/graph";
import type { Node } from "../src/graph";
import {
  dispose,
  idle,
  index,
  node,
  onWake,
  read,
  stackLength,
  write,
} from "../src/kernel";
import { checkGraph, deps } from "./support/graph";

const signal = (value: number) => node(null, value, 0);
const computed = (fn: () => unknown) => node(fn, undefined, Flag.Dirty);

describe("displaced slot cells", () => {
  it("uses one stack slot per displaced edge at three increasing widths", () => {
    for (const width of [300, 400, 500]) {
      const sources = Array.from({ length: width }, (_, i) => signal(i));
      let child: Node | null = null;
      for (let level = 0; level < 3; level++) {
        const below = child;
        const c: Node = computed(() => {
          let sum = 0;
          for (const s of sources) sum += read(s) as number;
          index(c, null);
          if (below !== null) sum += read(below) as number;
          else expect(stackLength()).toBe(2 * width);
          return sum;
        });
        child = c;
      }
      expect(read(child!)).toBe((3 * width * (width - 1)) / 2);
      expect(idle()).toBe(true);
      checkGraph([child!]);
    }
  });

  for (const validation of [false, true]) {
    it.each([
      "success",
      "throw",
      "caught",
      "dispose-self",
      "dispose-self-throw",
      "dispose-outer",
      "dispose-outer-throw",
    ])(
      `restores the enclosing cells on %s${validation ? " above suspended validation frames" : ""}`,
      (outcome) => {
        const tick = signal(0);
        const sources = Array.from({ length: 24 }, (_, i) => signal(i + 1));
        const shared = [tick, ...sources];
        const readers: Node[] = [];
        let armed = false;
        let restored = 0;
        let caught = 0;

        for (let level = 0; level < 4; level++) {
          const below = readers[level - 1];
          const c: Node = computed(() => {
            const t = read(tick) as number;
            let sum = 0;
            for (const s of t & 1 ? [...sources].reverse() : sources)
              sum += read(s) as number;
            if ((c.flags & Flag.Indexed) === 0) index(c, c.last!.next);
            const cells = shared.map((s) => s.slot);
            expect(
              cells.every(
                (e, i) => e !== null && e.from === shared[i] && e.to === c,
              ),
            ).toBe(true);

            if (below !== undefined) {
              try {
                sum += read(below) as number;
              } catch (error) {
                if (outcome !== "caught" || level !== 1) throw error;
                caught++;
              } finally {
                expect(shared.every((s, i) => s.slot === cells[i])).toBe(true);
                restored++;
              }
            } else if (armed) {
              if (outcome.startsWith("dispose-self")) dispose(c);
              if (outcome.startsWith("dispose-outer")) dispose(readers[3]!);
              if (
                outcome === "throw" ||
                outcome === "caught" ||
                outcome.endsWith("-throw")
              )
                throw new Error("slot failure");
            }
            return sum + (read(sources[0]!) as number);
          });
          readers.push(c);
        }

        const outer = readers[3]!;
        let demand = outer;
        if (validation) {
          for (let i = 0; i < 20; i++) {
            const below = demand;
            demand = computed(() => read(below));
          }
        }
        expect(read(demand)).toBe(1204);
        armed = true;
        restored = 0;
        write(tick, 1);
        if (outcome === "throw" || outcome.endsWith("-throw"))
          expect(() => read(demand)).toThrow("slot failure");
        else read(demand);
        expect(restored).toBe(3);
        expect(caught).toBe(outcome === "caught" ? 1 : 0);
        expect(idle()).toBe(true);
        checkGraph([demand, ...readers]);

        if (outcome.startsWith("dispose")) {
          const disposed = outcome.startsWith("dispose-self")
            ? readers[0]!
            : outer;
          expect(disposed.fn).toBeNull();
          expect(deps(disposed).length).toBe(0);
        } else {
          armed = false;
          write(tick, 2);
          expect(read(demand)).toBe(1204);
          checkGraph([demand, ...readers]);
          expect(idle()).toBe(true);
        }
      },
    );
  }

  it("keeps pending mark siblings below a nested indexed run", () => {
    const tick = signal(0);
    const sources = Array.from({ length: 24 }, (_, i) => signal(i));
    const inner: Node = computed(() => {
      read(tick);
      for (const s of sources) read(s);
      index(inner, null);
      return read(sources[0]!);
    });
    const outer: Node = computed(() => {
      read(tick);
      for (const s of sources) read(s);
      index(outer, outer.last!.next);
      const cells = sources.map((s) => s.slot);
      read(inner);
      expect(sources.every((s, i) => s.slot === cells[i])).toBe(true);
      return read(sources[0]!);
    });
    read(outer);
    write(tick, 1);

    const trigger = signal(0);
    const trunk = computed(() => read(trigger));
    const branch = computed(() => read(trunk));
    const sibling = computed(() => read(trunk));
    const watcher = node(
      () => read(branch),
      undefined,
      Flag.Dirty | Flag.Watch,
    );
    read(watcher);
    read(sibling);
    let wakes = 0;
    onWake(() => {
      wakes++;
      expect(read(outer)).toBe(0);
    });
    try {
      write(trigger, 1);
    } finally {
      onWake(() => {});
    }
    expect(wakes).toBe(1);
    expect((sibling.flags & Flag.Stale) !== 0).toBe(true);
    expect(read(sibling)).toBe(1);
    expect(read(watcher)).toBe(1);
    expect(idle()).toBe(true);
    checkGraph([outer, watcher, sibling]);
  });
});
