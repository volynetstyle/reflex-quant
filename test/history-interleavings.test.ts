import { describe, expect, it } from "vitest";
import { expr as e, op } from "../reference/reflex/test/differential/api";
import {
  certifyHistoryPrefix,
  createHistoryQuantWorld,
  describeHistoryFailure,
  runHistoryCase,
  type QuantWorld,
} from "./support/history-erasure";
import {
  historyCase,
  historyRules,
  historyScenario,
  type HistoryRule,
  type HistoryScenario,
} from "./support/history-erasure-generator";
import {
  interleavingCase,
  partitionHistoryShuffles,
  scenarioShuffles,
} from "./support/history-interleavings";
import { searchHistoryContinuations } from "./support/history-continuations";

function fixture(
  a: HistoryRule,
  b: HistoryRule,
  width = 1,
  depth = 0,
  hardOrder = false,
) {
  let base = historyCase({
    width,
    depth,
    watchers: 1,
    history: [],
    historyA: [],
    ...(hardOrder
      ? {
          permutation: Array.from(
            { length: width },
            (_, i) => (i * 17) % width,
          ),
        }
      : {}),
  });
  const context = {
    outer: depth === 0 ? "c" : `c${depth - 1}`,
    sources: Array.from({ length: width }, (_, i) => `a${i}`),
  };
  if (hardOrder) {
    const at = base.prefixA.findIndex(
      (operation) => operation.type === "computed" && operation.id === "c",
    );
    const expression = context.sources.reduce(
      (sum, id) => e.add(sum, e.read(id)),
      e.value(0),
    );
    // An older shared reader removes the first-subscriber shortcut. Its watcher
    // keeps this public reader validated when the overlapping ABA changes data.
    const prefix = [
      ...base.prefixA.slice(0, at),
      op.computed("filler", expression),
      op.watcher("fillerWatcher", e.read("filler")),
      op.read("filler"),
      ...base.prefixA.slice(at),
    ];
    base = {
      ...base,
      handles: [...base.handles, "filler", "fillerWatcher"],
      prefixA: prefix,
      prefixB: prefix,
    };
  }
  const left = historyScenario(a, { ...context, privateId: "privateA" });
  const right = historyScenario(b, { ...context, privateId: "privateB" });
  return { base, left, right };
}

describe("open history interleavings", () => {
  it("enumerates all 924 labelled six-by-six shuffles without violating either order", () => {
    const { left, right } = fixture("watcher-recovery", "reorder-inverse");
    const shuffles = [...scenarioShuffles(left, right)];
    expect(shuffles).toHaveLength(924);
    expect(new Set(shuffles.map((shuffle) => shuffle.word)).size).toBe(924);
    expect(shuffles.filter((shuffle) => shuffle.interleaved)).toHaveLength(922);
    for (const shuffle of shuffles)
      for (const side of ["A", "B"] as const)
        expect(
          shuffle.steps
            .filter((step) => step.side === side)
            .map((step) => step.index),
        ).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("certifies and checks every small shuffle from all 15 pairs of distinct rules", async () => {
    let generated = 0,
      certified = 0,
      open = 0,
      classes = 0,
      checked = 0,
      interleaved = 0;
    for (let i = 0; i < historyRules.length; i++)
      for (let j = i + 1; j < historyRules.length; j++) {
        const { base, left, right } = fixture(
          historyRules[i]!,
          historyRules[j]!,
        );
        const partition = partitionHistoryShuffles(base, left, right);
        expect(partition.complete).toBe(true);
        expect(partition.generated).toBe(Number(partition.totalPossible));
        expect(
          partition.rejections.filter(
            (rejection) => rejection.kind === "invalid",
          ),
        ).toHaveLength(0);
        expect(partition.certified).toBeGreaterThanOrEqual(2);
        expect(
          partition.classes.reduce(
            (sum, group) => sum + group.members.length,
            0,
          ),
        ).toBe(partition.certified);
        generated += partition.generated;
        certified += partition.certified;
        classes += partition.classes.length;
        interleaved += partition.interleaved;
        open += partition.rejections.length;
        for (const group of partition.classes)
          for (const member of group.members) {
            const test = interleavingCase(partition, group, member);
            const result = await runHistoryCase(test);
            expect(result.kind, describeHistoryFailure(test, result)).toBe(
              "pass",
            );
            checked++;
          }
      }
    expect(generated).toBe(6755);
    expect(interleaved).toBe(6725);
    expect(checked).toBe(certified);
    expect({ certified, open, classes }).toEqual({
      certified: 6755,
      open: 0,
      classes: 15,
    });
    console.info("small interleavings", {
      generated,
      certified,
      open,
      classes,
      checked,
      interleaved,
    });
  });

  it("exhausts two-step wake probes for every shuffle of failure and reordering", async () => {
    const { base, left, right } = fixture(
      "watcher-recovery",
      "reorder-inverse",
    );
    const partition = partitionHistoryShuffles(base, left, right);
    let checked = 0,
      transitions = 0;
    for (const group of partition.classes)
      for (const member of group.members) {
        const test = interleavingCase(partition, group, member);
        const result = await searchHistoryContinuations(test, {
          maxDepth: 2,
          alphabet: [op.set("b0", 99), op.flush()],
        });
        expect(
          result.status,
          result.witness === undefined
            ? test.id
            : describeHistoryFailure(
                result.witness.test,
                result.witness.result,
              ),
        ).toBe("equivalent");
        expect(result.completedDepth).toBe(2);
        expect(result.transitions).toBe(6);
        checked++;
        transitions += result.transitions;
      }
    expect(checked).toBe(partition.certified);
    expect(checked).toBe(924);
    expect(transitions).toBe(5544);
  });

  it("checks high-alternation wide witnesses and their serial controls", async () => {
    const pairs: readonly (readonly [HistoryRule, HistoryRule])[] = [
      ["watcher-recovery", "reorder-inverse"],
      ["computed-recovery", "branch-return"],
      ["computed-recovery", "watcher-recovery"],
      ["watcher-recovery", "disposed-neighbor"],
      ["computed-recovery", "settled-aba"],
      ["disposed-neighbor", "settled-aba"],
    ];
    let checked = 0,
      indexes = 0,
      prefixIndexes = 0,
      debtProbeIndexes = 0;
    const factoryFor = (
      aLength: number,
      bLength: number,
      probeAtB?: number,
    ) => {
      let side = 0;
      return async (): Promise<QuantWorld> => {
        const currentSide = side++;
        let remaining = currentSide === 0 ? aLength : bLength;
        let position = 0;
        const world = await createHistoryQuantWorld();
        return {
          ...world,
          execute(operation) {
            const before = world.counters().indexes;
            try {
              return world.execute(operation);
            } finally {
              const delta = world.counters().indexes - before;
              indexes += delta;
              if (remaining-- > 0) prefixIndexes += delta;
              if (currentSide === 1 && position === probeAtB)
                debtProbeIndexes += delta;
              position++;
            }
          },
        };
      };
    };
    for (const [a, b] of pairs) {
      const { base, left, right } = fixture(a, b, 40, 1, true);
      const partition = partitionHistoryShuffles(base, left, right);
      for (const group of partition.classes) {
        const serial = group.members.filter((member) => !member.interleaved);
        const alternated = [...group.members]
          .sort((a, b) => b.switches - a.switches)
          .slice(0, 6);
        const debtProbe =
          a === "watcher-recovery" && b === "reorder-inverse"
            ? group.members.filter((member) => member.word === "AAABBBBAABAB")
            : [];
        for (const member of new Set([
          ...serial,
          ...alternated,
          ...debtProbe,
        ])) {
          const test = interleavingCase(partition, group, member);
          const result = await runHistoryCase(
            test,
            factoryFor(
              test.prefixA.length,
              test.prefixB.length,
              debtProbe.includes(member) ? base.prefixA.length + 4 : undefined,
            ),
          );
          expect(result.kind, describeHistoryFailure(test, result)).toBe(
            "pass",
          );
          checked++;
        }
      }
    }
    expect(checked).toBe(49);
    // Representation coverage, not a contract obligation to build an index.
    expect(indexes).toBeGreaterThan(0);
    expect(prefixIndexes).toBeGreaterThan(0);
    expect(debtProbeIndexes).toBeGreaterThan(0);
    console.info("selected wide interleavings", {
      checked,
      indexes,
      prefixIndexes,
      debtProbeIndexes,
    });
  });

  it("records a live failed watcher debt while the other scenario reorders dependencies", () => {
    const { base, left, right } = fixture(
      "watcher-recovery",
      "reorder-inverse",
      40,
      1,
      true,
    );
    const shuffle = [...scenarioShuffles(left, right)].find(
      (shuffle) => shuffle.word === "AAABBBBAABAB",
    )!;
    const certificate = certifyHistoryPrefix(
      base,
      [...base.prefixA, ...shuffle.steps.map((step) => step.operation)],
      true,
    );
    expect(certificate.kind).toBe("certified");
    const at = (index: number) =>
      certificate.trace[base.prefixA.length + index]!;
    const failed = at(2).state.computations.find((node) => node.id === "w0")!;
    expect(at(2).observation.error?.message).toBe("watcher attempt");
    expect(failed.executionPending).toBe(true);
    expect(failed.retry).not.toBeNull();
    const reordered = at(4).state.computations.find((node) => node.id === "c")!;
    expect(
      reordered.deps
        .filter((source) => /^a\d+$/.test(source.id))
        .map((source) => source.id),
    ).toEqual(Array.from({ length: 40 }, (_, i) => `a${(i * 17) % 40}`));
    expect(
      at(4).state.computations.find((node) => node.id === "w0")!
        .executionPending,
    ).toBe(true);
  });

  it("filters unclosed endpoints without inserting a healing operation", () => {
    const { base } = fixture("computed-recovery", "reorder-inverse");
    const left: HistoryScenario = {
      rule: "unrecovered failure",
      phases: [
        { name: "fail", operations: [op.set("failure", 1), op.read("c")] },
      ],
    };
    const right: HistoryScenario = {
      rule: "flush",
      phases: [{ name: "flush", operations: [op.flush()] }],
    };
    const partition = partitionHistoryShuffles(base, left, right);
    expect(partition.complete).toBe(true);
    expect(partition.generated).toBe(3);
    expect(partition.certified).toBe(0);
    expect(partition.classes).toHaveLength(0);
    expect(
      partition.rejections.every((rejection) => rejection.kind === "open"),
    ).toBe(true);
  });

  it("partitions by final spec state instead of forcing every path back to the base", async () => {
    const { base } = fixture("computed-recovery", "reorder-inverse");
    const scenario = (value: number): HistoryScenario => ({
      rule: `write ${value}`,
      phases: [
        {
          name: "write",
          operations: [op.set("a0", value), op.read("c"), op.flush()],
        },
      ],
    });
    const partition = partitionHistoryShuffles(base, scenario(2), scenario(3));
    expect(partition.certified).toBe(20);
    expect(partition.classes).toHaveLength(2);
    for (const group of partition.classes) {
      expect([2, 3]).toContain(
        group.checkpoint.nodes.find((node) => node.id === "a0")!.value,
      );
      const test = interleavingCase(partition, group, group.members.at(-1)!);
      expect(
        (await runHistoryCase({ ...test, suffix: [op.read("c")], bounds: [] }))
          .kind,
      ).toBe("pass");
    }
  });

  it("separates malformed schedules and reports an incomplete enumeration budget", () => {
    const { base, left, right } = fixture(
      "watcher-recovery",
      "reorder-inverse",
    );
    const partial = partitionHistoryShuffles(base, left, right, 3);
    expect(partial.complete).toBe(false);
    expect(partial.generated).toBe(3);
    expect(partial.totalPossible).toBe("924");
    const duplicate: HistoryScenario = {
      rule: "duplicate",
      phases: [
        { name: "declare", operations: [op.signal("privateDuplicate", 0)] },
      ],
    };
    const invalid = partitionHistoryShuffles(base, duplicate, duplicate);
    expect(invalid.generated).toBe(2);
    expect(invalid.certified).toBe(0);
    expect(
      invalid.rejections.every((rejection) => rejection.kind === "invalid"),
    ).toBe(true);
    expect(() => partitionHistoryShuffles(base, left, right, -1)).toThrow(
      "maxHistories",
    );
    expect(() => historyCase({ width: 3, permutation: [0, 0, 2] })).toThrow(
      "bijection",
    );
  });

  it("finds an overlap-only token missed by the two closed compositions", async () => {
    const factory = async (): Promise<QuantWorld> => {
      const world = await createHistoryQuantWorld();
      let failed = false,
        scar = false;
      return {
        ...world,
        execute(operation) {
          const observation = world.execute(operation);
          if (operation.type === "flush") {
            if (observation.error?.message === "watcher attempt") failed = true;
            else if (
              observation.effects.some(
                (event) => event.effect === "w0" && event.phase === "run",
              )
            )
              failed = false;
          }
          if (
            operation.type === "set" &&
            operation.id === "order" &&
            operation.value === 1 &&
            failed
          )
            scar = true;
          if (operation.type === "read" && operation.id === "a0" && scar)
            return { ...observation, value: 999 };
          return observation;
        },
      };
    };
    const closed = historyCase({
      width: 1,
      depth: 0,
      watchers: 1,
      historyA: ["watcher-recovery", "reorder-inverse"],
      history: ["reorder-inverse", "watcher-recovery"],
    });
    expect(
      (
        await runHistoryCase(
          { ...closed, suffix: [op.read("a0")], bounds: [] },
          factory,
        )
      ).kind,
    ).toBe("pass");
    const { base, left, right } = fixture(
      "watcher-recovery",
      "reorder-inverse",
    );
    const partition = partitionHistoryShuffles(base, left, right);
    const group = partition.classes[0]!;
    const member = group.members.find(
      (member) => member.word === "AAABBBBAABAB",
    )!;
    const test = interleavingCase(partition, group, member);
    const result = await searchHistoryContinuations(
      test,
      { maxDepth: 1, alphabet: [op.read("a0")] },
      factory,
    );
    expect(result.witness?.result.kind).toBe("history-leak");
    expect(result.witness?.depth).toBe(1);
  });
});
