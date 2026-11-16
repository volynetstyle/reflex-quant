import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  expr as e,
  op,
  type Op,
} from "../reference/reflex/test/differential/api";
import {
  createHistoryQuantWorld,
  describeHistoryFailure,
  runHistoryCase,
  type HistoryCase,
  type QuantWorld,
} from "./support/history-erasure";
import {
  historyCase,
  historyRules,
  symmetricHistoryCaseArbitrary,
} from "./support/history-erasure-generator";
import {
  continuationAlphabet,
  continuationClasses,
  continuationDeclarations,
  searchHistoryContinuations,
} from "./support/history-continuations";

const tiny = (): HistoryCase => {
  const base = [
    op.signal("x", 0),
    op.signal("failure", 0),
    op.computed("c", e.when(e.read("failure"), e.fail("attempt"), e.read("x"))),
    op.watcher("w", e.read("c"), { cleanup: e.read("x") }),
    op.read("c"),
    op.flush(),
  ];
  return {
    id: "two-churned-histories",
    rule: "settled-aba + disposed-neighbor",
    histories: { a: ["settled-aba"], b: ["disposed-neighbor"] },
    handles: ["x", "failure", "c", "w"],
    prefixA: [
      ...base,
      op.set("x", 1),
      op.read("c"),
      op.flush(),
      op.set("x", 0),
      op.read("c"),
      op.flush(),
    ],
    prefixB: [
      ...base,
      op.watcher("private", e.read("c")),
      op.flush(),
      op.dispose("private"),
    ],
    suffix: [],
  };
};

const delayedFault =
  (shared = false, stateOnly = false) =>
  async (): Promise<QuantWorld> => {
    const world = await createHistoryQuantWorld();
    let scar = shared;
    let noops = 0;
    return {
      ...world,
      execute(operation) {
        const observation = world.execute(operation);
        if (operation.type === "dispose" && operation.id === "private")
          scar = true;
        if (
          operation.type === "set" &&
          operation.id === "x" &&
          operation.value === 0
        )
          noops++;
        // H1 has one historical zero write; H2 has none, and only H2 has the scar.
        if (
          scar &&
          operation.type === "read" &&
          operation.id === "x" &&
          (shared || stateOnly || noops >= 2)
        ) {
          if (stateOnly) world.nodes.get("x")!.node.value = 99;
          else return { ...observation, value: 99 };
        }
        return observation;
      },
    };
  };

describe("bounded history continuations", () => {
  it("exhausts a public-node alphabet through depth 3, including declarations and failures", async () => {
    const test = tiny();
    const alphabet = continuationAlphabet(
      test,
      [0, 1],
      continuationDeclarations("x"),
    );
    const result = await searchHistoryContinuations(test, {
      maxDepth: 3,
      alphabet,
    });
    expect(
      result.status,
      result.witness === undefined
        ? ""
        : describeHistoryFailure(result.witness.test, result.witness.result),
    ).toBe("equivalent");
    expect(result.completedDepth).toBe(3);
    expect(result.transitions).toBe(11 + 121 + 1331);
    expect(result.rejected).toBe(2 * (1 + 11 + 121));
    for (const row of Object.values(result.coverage))
      for (const kind of continuationClasses)
        expect(row[kind], kind).toBeGreaterThan(0);
    expect(result.repeatedSpecStates).toBeGreaterThan(0);
  });

  it("checks all words through depth 5 without using equal spec states to prune", async () => {
    const result = await searchHistoryContinuations(tiny(), {
      maxDepth: 5,
      alphabet: [op.set("x", 0), op.read("x")],
    });
    expect(result.status).toBe("equivalent");
    expect(result.completedDepth).toBe(5);
    expect(result.transitions).toBe(2 + 4 + 8 + 16 + 32);
    expect(result.distinctSpecStates).toBe(1);
    expect(result.repeatedSpecStates).toBe(result.transitions);
  });

  it("finds the shortest distinguishing continuation after two spec-state collisions", async () => {
    const result = await searchHistoryContinuations(
      tiny(),
      { maxDepth: 4, alphabet: [op.set("x", 0), op.read("x")] },
      delayedFault(),
    );
    expect(result.status).toBe("counterexample");
    expect(result.completedDepth).toBe(2);
    expect(result.witness?.depth).toBe(3);
    expect(result.witness?.test.suffix).toEqual([
      op.set("x", 0),
      op.set("x", 0),
      op.read("x"),
    ]);
    expect(result.witness?.result.kind).toBe("history-leak");
    expect(result.witness?.result.difference?.phase).toBe("suffix");
  });

  it("keeps the vertical oracle for shared wrong outputs", async () => {
    const result = await searchHistoryContinuations(
      tiny(),
      { maxDepth: 2, alphabet: [op.read("x")] },
      delayedFault(true),
    );
    expect(result.witness?.depth).toBe(1);
    expect(result.witness?.result.kind).toBe("implementation");
  });

  it("checks next states after each step, even when outputs agree", async () => {
    const result = await searchHistoryContinuations(
      tiny(),
      { maxDepth: 2, alphabet: [op.read("x")] },
      delayedFault(false, true),
    );
    expect(result.witness?.depth).toBe(1);
    expect(result.witness?.result.kind).toBe("history-leak");
    expect(result.witness?.result.difference?.phase).toBe("next");
  });

  it("reports the completed horizon when a budget cuts through a BFS level", async () => {
    const result = await searchHistoryContinuations(tiny(), {
      maxDepth: 4,
      maxTransitions: 3,
      alphabet: [op.set("x", 0), op.read("x")],
    });
    expect(result.status).toBe("incomplete");
    expect(result.completedDepth).toBe(1);
    expect(result.transitions).toBe(3);
    expect(result.levels).toEqual([
      { depth: 1, transitions: 2 },
      { depth: 2, transitions: 1 },
    ]);
  });

  it("uses syntactic admissibility for declarations and checks duplicate alphabet entries once", async () => {
    const result = await searchHistoryContinuations(tiny(), {
      maxDepth: 3,
      alphabet: [
        op.computed("later", e.read("x")),
        op.read("later"),
        op.read("later"),
      ],
    });
    expect(result.status).toBe("equivalent");
    expect(result.alphabet).toHaveLength(2);
    expect(result.transitions).toBe(3);
    expect(result.rejected).toBe(3);
  });

  it("retains pending versions and failure gates at open endpoints", async () => {
    const test = tiny();
    const pending = await runHistoryCase(
      { ...test, suffix: [op.set("x", 1)] },
      undefined,
      { endpoint: "open" },
    );
    expect(pending.kind).toBe("pass");
    expect(
      pending.continuation?.computations.find((node) => node.id === "c")?.deps,
    ).toContainEqual({ id: "x", current: false });
    const failed = await runHistoryCase(
      { ...test, suffix: [op.set("failure", 1), op.read("c")] },
      undefined,
      { endpoint: "open" },
    );
    expect(failed.kind).toBe("pass");
    expect(failed.lastObservation?.error?.message).toBe("attempt");
    expect(
      failed.continuation?.computations.find((node) => node.id === "c")?.failed,
    ).toBe(true);
    expect(
      failed.continuation?.computations.find((node) => node.id === "c")?.retry,
    ).not.toBeNull();
    const fresh = await runHistoryCase(
      { ...test, suffix: [op.computed("later", e.read("x"))] },
      undefined,
      { endpoint: "open" },
    );
    expect(fresh.kind).toBe("pass");
    expect(
      fresh.continuation?.computations.find((node) => node.id === "later")
        ?.initialized,
    ).toBe(false);
  });

  it("does not mistake redundant watcher validation flags for execution debt after cutoff", async () => {
    const test = {
      ...tiny(),
      suffix: [op.set("x", 1), op.set("x", 0), op.read("c")],
    };
    expect(
      (await runHistoryCase(test, undefined, { endpoint: "open" })).kind,
    ).toBe("pass");
    expect((await runHistoryCase(test)).kind).toBe("pass");
  });

  it("rejects an uncertified root and invalid search bounds", async () => {
    const test = tiny();
    const bad = { ...test, prefixB: [...test.prefixB, op.set("x", 1)] };
    const result = await searchHistoryContinuations(bad, {
      maxDepth: 3,
      alphabet: [op.read("x")],
    });
    expect(result.status).toBe("ineligible");
    expect(result.completedDepth).toBe(-1);
    expect(result.transitions).toBe(0);
    await expect(
      searchHistoryContinuations(test, { maxDepth: -1, alphabet: [] }),
    ).rejects.toThrow("maxDepth");
    await expect(
      searchHistoryContinuations(test, {
        maxDepth: 1,
        maxTransitions: -1,
        alphabet: [],
      }),
    ).rejects.toThrow("maxTransitions");
  });

  it("does not reuse envelopes from a different suffix", async () => {
    const test = { ...tiny(), bounds: [{ at: 50, max: { runs: 0 } }] };
    const result = await searchHistoryContinuations(test, {
      maxDepth: 1,
      alphabet: [op.read("x")],
    });
    expect(result.status).toBe("equivalent");
    const failure = await searchHistoryContinuations(tiny(), {
      maxDepth: 2,
      alphabet: [op.set("x", 1), op.read("c")],
      envelopes: (suffix) =>
        suffix.length === 2 ? [{ at: 1, max: { runs: 0 } }] : [],
    });
    expect(failure.witness?.result.kind).toBe("structure");
  });
});

describe("symmetric history classes", () => {
  it("compares every pair of different erasure rules without a fresh side", async () => {
    for (const a of historyRules)
      for (const b of historyRules)
        if (a !== b) {
          const test = historyCase({
            width: 8,
            depth: 1,
            watchers: 2,
            historyA: [a],
            history: [b],
          });
          const result = await runHistoryCase(test);
          expect(result.kind, `${a}/${b}: ${result.message}`).toBe("pass");
        }
  });

  it("checks continuation classes separately for each residue through depth 3", async () => {
    for (const rule of historyRules) {
      const test = historyCase({
        width: 1,
        depth: 0,
        watchers: 1,
        history: [rule],
        historyA: ["settled-aba"],
      });
      const alphabet: Op[] = [
        op.set("failure", 1),
        op.set("failure", 0),
        op.set("failure", 2),
        op.read("c"),
        op.flush(),
        op.dispose("w0"),
        op.computed("continuation", e.read("c")),
        op.read("continuation"),
      ];
      const result = await searchHistoryContinuations(test, {
        maxDepth: 3,
        alphabet,
      });
      expect(result.status, `${rule}: ${result.witness?.result.message}`).toBe(
        "equivalent",
      );
      expect(result.transitions).toBe(7 + 49 + 343);
      for (const kind of continuationClasses)
        expect(result.coverage[rule]![kind], `${rule}/${kind}`).toBeGreaterThan(
          0,
        );
    }
  });

  it("samples independently churned prefixes before a shared recovery/disposal suffix", async () => {
    await fc.assert(
      fc.asyncProperty(symmetricHistoryCaseArbitrary, async (test) => {
        const result = await runHistoryCase(test);
        expect(result.kind, `${test.id}: ${result.message}`).toBe("pass");
        expect(test.histories!.a.length).toBeGreaterThan(0);
        expect(test.histories!.b.length).toBeGreaterThan(0);
      }),
      { seed: 0x52b15, numRuns: 80, endOnFailure: true },
    );
  });
});
