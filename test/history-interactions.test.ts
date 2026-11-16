import { describe, expect, it } from "vitest";
import { op } from "../reference/reflex/test/differential/api";
import {
  createHistoryQuantWorld,
  describeHistoryFailure,
  runHistoryCase,
  type QuantWorld,
} from "./support/history-erasure";
import {
  historyCase,
  historyInteractionCases,
} from "./support/history-erasure-generator";
import { searchHistoryContinuations } from "./support/history-continuations";

describe("history interaction candidates", () => {
  it("certifies commutation, idempotence, powers and every distinct triple reversal at two widths", async () => {
    for (const width of [1, 40]) {
      const cases = historyInteractionCases({ width, depth: 1, watchers: 2 });
      expect(cases).toHaveLength(93);
      expect(cases.filter((test) => test.family === "commutator")).toHaveLength(
        15,
      );
      expect(
        cases.filter((test) => test.family === "idempotence"),
      ).toHaveLength(6);
      expect(cases.filter((test) => test.family === "powers")).toHaveLength(12);
      expect(
        cases.filter((test) => test.family === "reverse-cycle"),
      ).toHaveLength(60);
      for (const { test } of cases) {
        const result = await runHistoryCase(test);
        expect(result.kind, describeHistoryFailure(test, result)).toBe("pass");
        expect(result.resources?.a.retirement?.edges).toBeGreaterThanOrEqual(0);
        expect(result.resources?.b.retirement?.edges).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("exhausts all 15 order-commutation pairs through continuation depth 3", async () => {
    const cases = historyInteractionCases({
      width: 1,
      depth: 0,
      watchers: 1,
    }).filter((test) => test.family === "commutator");
    const alphabet = [
      op.set("order", 1),
      op.set("failure", 1),
      op.set("failure", 0),
      op.set("failure", 2),
      op.read("c"),
      op.flush(),
      op.dispose("w0"),
    ];
    for (const { test } of cases) {
      const result = await searchHistoryContinuations(test, {
        maxDepth: 3,
        alphabet,
      });
      expect(
        result.status,
        result.witness === undefined
          ? test.id
          : describeHistoryFailure(result.witness.test, result.witness.result),
      ).toBe("equivalent");
      expect(result.completedDepth).toBe(3);
      expect(result.transitions).toBe(7 + 49 + 343);
    }
  });

  it("detects an order-specific scar under one common read", async () => {
    const test = historyCase({
      width: 1,
      depth: 0,
      watchers: 1,
      historyA: ["disposed-neighbor", "settled-aba"],
      history: ["settled-aba", "disposed-neighbor"],
    });
    const factory = async (): Promise<QuantWorld> => {
      const world = await createHistoryQuantWorld();
      let disposed = false;
      let scar = false;
      return {
        ...world,
        execute(operation) {
          const observation = world.execute(operation);
          if (
            operation.type === "dispose" &&
            operation.id.startsWith("private")
          )
            disposed = true;
          if (
            operation.type === "set" &&
            operation.id === "a0" &&
            operation.value === 100 &&
            disposed
          )
            scar = true;
          if (operation.type === "read" && operation.id === "a0" && scar)
            return { ...observation, value: 999 };
          return observation;
        },
      };
    };
    const result = await searchHistoryContinuations(
      test,
      { maxDepth: 1, alphabet: [op.read("a0")] },
      factory,
    );
    expect(result.witness?.depth).toBe(1);
    expect(result.witness?.result.kind).toBe("history-leak");
  });

  it("accepts an explicit bounded power domain and rejects vacuous/invalid powers", () => {
    expect(
      historyInteractionCases({}, [[3, 5]]).filter(
        (test) => test.family === "powers",
      ),
    ).toHaveLength(6);
    expect(() => historyInteractionCases({}, [[0, 1]])).toThrow(
      "positive integers",
    );
    expect(() => historyInteractionCases({}, [[2, 2]])).toThrow("distinct");
  });
});
