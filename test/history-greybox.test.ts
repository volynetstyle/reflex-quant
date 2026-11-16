import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { ins as i, ix as x } from "./support/imperative-language";
import {
  scarCandidates,
  scarDistance,
  searchScars,
  searchImperativeContinuations,
  evolveScars,
} from "./support/history-greybox";

describe("greybox scar prioritization", () => {
  it("maximizes implementation distance only within independently equal spec states", async () => {
    const candidates = scarCandidates(12);
    candidates.push({
      ...candidates[11]!,
      id: "different-spec-state",
      operations: [...candidates[11]!.operations, i.set("a", x.value(999))],
    });
    const result = await searchScars(candidates, {
      maxCandidates: 20,
      stagnation: 4,
    });
    expect(result.status, JSON.stringify(result)).toBe("exhausted");
    if (!("selected" in result)) throw new Error("missing search result");
    expect(result.classes).toBe(2);
    expect(result.selected!.distance).toBeGreaterThan(0);
    expect(result.selected!.history.id).not.toContain("different-spec-state");
    const search = await searchImperativeContinuations(
      result.selected!.history,
      [i.set("a", x.value(2)), i.flush(), i.dispose("w")],
      2,
    );
    expect(search.status, JSON.stringify(search)).toBe("equivalent");
    expect(search.checked).toBe(12);
    if (process.env["QUANT_SCAR_REPORT"]) {
      const guided = await evolveScars({
        seed: 0x55ace,
        maxCandidates: Number(process.env["QUANT_SCAR_STEPS"] ?? 64),
        stagnation: 16,
        maxBlocks: 8,
      });
      if (
        !("selected" in guided.search) ||
        guided.search.selected === undefined
      )
        throw new Error("guided search produced no certified pair");
      const continuation = await searchImperativeContinuations(
        guided.search.selected.history,
        [i.set("a", x.value(2)), i.flush(), i.dispose("w")],
        2,
      );
      expect(continuation.status).toBe("equivalent");
      writeFileSync(
        process.env["QUANT_SCAR_REPORT"],
        JSON.stringify(
          {
            domain:
              "feedback-guided bounded imperative histories; spec-only state admission; 12 continuation words on the farthest pair",
            node: process.version,
            v8: process.versions.v8,
            search: guided.search,
            seed: guided.seed,
            maxBlocks: guided.maxBlocks,
            corpusSize: guided.corpusSize,
            smoke: result,
            continuation,
          },
          null,
          2,
        ) + "\n",
      );
    }
  });
  it("feeds only novel admitted scars back into bounded parent selection", async () => {
    const result = await evolveScars({
      seed: 0x55ace,
      maxCandidates: 32,
      stagnation: 16,
      maxBlocks: 6,
    });
    expect(result.search.status, JSON.stringify(result)).toBe("budget");
    expect(result.corpusSize).toBeGreaterThan(4);
    if (!("selected" in result.search)) throw new Error("missing selection");
    expect(result.search.selected!.distance).toBeGreaterThan(0);
  });
  it("reports corpus saturation and a candidate budget distinctly", async () => {
    const candidates = scarCandidates(2);
    const repeated = [...candidates, ...Array(5).fill(candidates[1]!)];
    const saturated = await searchScars(repeated, {
      maxCandidates: 20,
      stagnation: 3,
    });
    expect(saturated.status).toBe("saturated");
    expect(saturated.evaluated).toBe(5);
    const budget = await searchScars(candidates, {
      maxCandidates: 1,
      stagnation: 3,
    });
    expect(budget.status).toBe("budget");
    expect(scarDistance({ gen: 1 }, { gen: 1 })).toBe(0);
  });
});
