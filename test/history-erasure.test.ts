import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  expr as e,
  op,
  type Observation,
} from "../reference/reflex/test/differential/api";
import {
  auditHistoryRoots,
  createHistoryQuantWorld,
  describeHistoryFailure,
  runHistoryCase,
  shrinkHistoryCase,
  type HistoryCase,
  type QuantWorld,
} from "./support/history-erasure";
import {
  historyCase,
  historyCaseArbitrary,
  historyRules,
} from "./support/history-erasure-generator";

const check = async (test: HistoryCase) => {
  const result = await runHistoryCase(test);
  expect(
    result.kind,
    `${test.id}: ${result.message} at ${result.at ?? "boundary"}`,
  ).toBe("pass");
  return result;
};

/** Fault fixtures leave the actual graph untouched, so final-state equality cannot hide outputs. */
const faulty =
  (onlyChurned: boolean, overhead = false) =>
  async (): Promise<QuantWorld> => {
    const world = await createHistoryQuantWorld();
    let scar = false;
    let extra = 0;
    return {
      ...world,
      execute(operation): Observation {
        const observation = world.execute(operation);
        if (operation.type === "dispose" && operation.id.startsWith("private"))
          scar = true;
        if (
          operation.type === "read" &&
          operation.id === "a0" &&
          (!onlyChurned || scar)
        ) {
          if (overhead) extra++;
          else return { ...observation, value: Number(observation.value) + 1 };
        }
        return observation;
      },
      counters() {
        const counters = world.counters();
        return { ...counters, scans: counters.scans + extra };
      },
    };
  };

const faultCase = (): HistoryCase => {
  const test = historyCase({
    width: 1,
    depth: 0,
    watchers: 1,
    history: ["disposed-neighbor"],
  });
  return { ...test, suffix: [op.read("a0"), op.flush()], bounds: [] };
};

describe("history erasure: successful quiescent checkpoints", () => {
  it("certifies every rule separately, including settled ABA and both kinds of recovery", async () => {
    for (const rule of historyRules) {
      for (const width of [1, 8, 40]) {
        const result = await check(historyCase({ width, history: [rule] }));
        expect(result.witness?.facts).toContain("all observations current");
        expect(result.resources?.a.relations).toBe(
          result.resources?.b.relations,
        );
        expect(result.resources?.b.reachableEdges).toBe(
          result.resources?.b.relations,
        );
      }
    }
  });

  it("composes long histories before a common failure/recovery/disposal suffix", async () => {
    await check(
      historyCase({
        width: 64,
        depth: 3,
        watchers: 3,
        history: Array.from(
          { length: 60 },
          (_, i) => historyRules[i % historyRules.length]!,
        ),
        actions: [
          { target: "failure", value: 1, demand: true },
          { target: "failure", value: 0, demand: false },
          { target: "failure", value: 2, demand: false },
          { target: "a0", value: 2, demand: false },
          { target: "failure", value: 0, demand: false },
        ],
      }),
    );
  });

  it("generates convergent prefixes and shared continuations reproducibly", async () => {
    await fc.assert(
      fc.asyncProperty(historyCaseArbitrary, async (test) => {
        const result = await runHistoryCase(test);
        if (result.kind === "pass") return;
        if (result.kind === "ineligible")
          throw new Error(describeHistoryFailure(test, result));
        const smaller = await shrinkHistoryCase(
          test,
          (_candidate, failure) => failure.kind === result.kind,
        );
        throw new Error(
          describeHistoryFailure(smaller, await runHistoryCase(smaller)),
        );
      }),
      {
        seed: 0x51a7e,
        numRuns: 160,
        endOnFailure: true,
      },
    );
  });

  it("rejects outstanding ABA debt before constructing Quant worlds", async () => {
    const test = historyCase({ width: 1, history: [] });
    const result = await runHistoryCase(
      { ...test, prefixB: [...test.prefixB, op.set("a0", 7), op.set("a0", 1)] },
      async () => {
        throw new Error("Quant must not be consulted");
      },
    );
    expect(result.kind).toBe("ineligible");
    expect(result.message).toContain("version debt");
  });

  it("requires recovery rather than equating a failed watcher with its old value/frontier", async () => {
    const test = historyCase({ width: 1, history: [] });
    const result = await runHistoryCase({
      ...test,
      prefixB: [...test.prefixB, op.set("failure", 2), op.flush()],
    });
    expect(result.kind).toBe("ineligible");
  });

  it("checks callback definitions even when their current values and deps coincide", async () => {
    const test = historyCase({ width: 1, depth: 0, history: [] });
    const prefixB = test.prefixB.map((operation) =>
      operation.type === "computed"
        ? { ...operation, expression: e.add(operation.expression, e.value(0)) }
        : operation,
    );
    const result = await runHistoryCase({ ...test, prefixB });
    expect(result.kind).toBe("ineligible");
    expect(result.message).toBe("spec checkpoints differ");
  });

  it("rejects references to hidden prefix names and malformed shrinking candidates", async () => {
    const test = faultCase();
    for (const suffix of [
      [op.read("missing")],
      [op.dispose("private0")],
      [op.computed("later", e.read("private0"))],
      [op.enterBatch()],
      [op.signal("private0", 0)],
    ]) {
      expect((await runHistoryCase({ ...test, suffix })).kind).toBe(
        "ineligible",
      );
    }
  });

  it("creates independent module globals and counters", async () => {
    const a = await createHistoryQuantWorld();
    const b = await createHistoryQuantWorld();
    for (const world of [a, b]) {
      world.execute(op.signal("s", 1));
      world.execute(op.computed("c", e.read("s")));
    }
    const before = a.counters();
    b.execute(op.read("c"));
    expect(a.counters()).toEqual(before);
    expect(b.counters().runs).toBeGreaterThan(before.runs);
    a.audit();
    b.audit();
  });

  it("detects a history-specific output even though both next states still agree", async () => {
    const result = await runHistoryCase(faultCase(), faulty(true));
    expect(result.kind).toBe("history-leak");
    expect(result.at).toBe(0);
    expect(result.difference?.phase).toBe("suffix");
    expect(result.difference?.expected).toEqual({ value: 1, effects: [] });
    expect(result.difference?.actual).toEqual({ value: 2, effects: [] });
  });

  it("detects a shared implementation error which Quant-versus-Quant would miss", async () => {
    const result = await runHistoryCase(faultCase(), faulty(false));
    expect(result.kind).toBe("implementation");
    expect(result.at).toBe(0);
  });

  it("compares the next states even when every suffix observation agrees", async () => {
    const test = faultCase();
    const factory = async (): Promise<QuantWorld> => {
      const world = await createHistoryQuantWorld();
      let scar = false;
      return {
        ...world,
        execute(operation) {
          const observation = world.execute(operation);
          if (
            operation.type === "dispose" &&
            operation.id.startsWith("private")
          )
            scar = true;
          if (scar && operation.type === "read" && operation.id === "a0")
            world.nodes.get("a0")!.node.value = 99;
          return observation;
        },
      };
    };
    const result = await runHistoryCase(test, factory);
    expect(result.kind).toBe("history-leak");
    expect(result.at).toBe(test.suffix.length);
    expect(result.difference?.phase).toBe("next");
  });

  it("records work differences without making equality of constant factors a contract", async () => {
    const result = await runHistoryCase(faultCase(), faulty(true, true));
    expect(result.kind).toBe("pass");
    expect(result.work!.b[0]!.scans).toBe(result.work!.a[0]!.scans + 1);
    const bounded = { ...faultCase(), bounds: [{ at: 0, max: { scans: 0 } }] };
    const failure = await runHistoryCase(bounded, faulty(true, true));
    expect(failure.kind).toBe("structure");
    expect(failure.message).toContain("scans=1 exceeds 0");
  });

  it("audits retained disposed handles after each operation", async () => {
    const test = historyCase({ width: 16, history: ["disposed-neighbor"] });
    const factory = async (): Promise<QuantWorld> => {
      const world = await createHistoryQuantWorld();
      return {
        ...world,
        execute(operation) {
          const observation = world.execute(operation);
          if (operation.type === "dispose" && operation.id === "private0") {
            world.nodes.get("private0")!.node.slot =
              world.nodes.get("a0")!.node.firstSub;
          }
          return observation;
        },
      };
    };
    const result = await runHistoryCase(test, factory);
    expect(result.kind).toBe("structure");
    expect(result.message).toContain("slot cell at rest");
  });

  it("inspects physically occupied stack/queue slots even when their logical sizes are zero", async () => {
    const world = await createHistoryQuantWorld();
    world.execute(op.signal("s", 1));
    world.execute(op.computed("c", e.read("s")));
    world.execute(op.read("c"));
    const node = world.nodes.get("c")!.node;
    const kernel = {
      active: null,
      cursor: null,
      top: 0,
      slots: Array(256).fill(null),
    };
    const host = { size: 0, hold: 0, slots: Array(256).fill(null) };
    kernel.slots[255] = node.firstDep;
    expect(() => auditHistoryRoots(world, kernel, host)).toThrow(
      "inactive work-stack slot",
    );
    kernel.slots[255] = null;
    host.slots[255] = node;
    expect(() => auditHistoryRoots(world, kernel, host)).toThrow(
      "inactive queue slot",
    );
    host.slots[255] = null;
    expect(auditHistoryRoots(world, kernel, host).reachableEdges).toBe(1);
  });

  it("shrinks the histories, continuation and checkpoint without losing certification", async () => {
    const base = faultCase();
    const test: HistoryCase = {
      ...base,
      handles: [...base.handles, "unused"],
      prefixA: [
        op.signal("unused", 0),
        ...base.prefixA,
        op.read("a0"),
        op.flush(),
      ],
      prefixB: [
        op.signal("unused", 0),
        ...base.prefixB,
        op.flush(),
        op.flush(),
      ],
      suffix: [op.flush(), ...base.suffix, op.flush()],
    };
    const smaller = await shrinkHistoryCase(
      test,
      (_candidate, result) => result.kind === "history-leak",
      faulty(true),
    );
    expect(smaller.handles).not.toContain("unused");
    expect(
      smaller.prefixA.length + smaller.prefixB.length + smaller.suffix.length,
    ).toBeLessThan(
      test.prefixA.length + test.prefixB.length + test.suffix.length,
    );
    const result = await runHistoryCase(smaller, faulty(true));
    expect(result.kind).toBe("history-leak");
    expect(result.witness?.boundary).toBe("successful-quiescent");
  });
});
