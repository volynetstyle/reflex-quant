// Disposal is functionally unchanged; graph checks also gate the resource
// property that functional observations alone cannot detect.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Expr, Op } from "../reference/reflex/test/differential/api";
import { Flag } from "../src/graph";
import { idle } from "../src/kernel";
import { checkGraph } from "./support/graph";
import { brief, quantNodes, runThreeWay } from "./support/machines";

const disposalPrograms = fc
  .record({
    width: fc.integer({ min: 1, max: 32 }),
    attempts: fc.integer({ min: 1, max: 6 }),
    outcome: fc.constantFrom(
      "never-run",
      "success",
      "first-failure",
      "failed-rerun",
      "cleanup-throw",
    ),
  })
  .map(({ width, attempts, outcome }): Op[] => {
    const get = (id: string): Expr => ({ type: "read", id });
    const zero: Expr = { type: "constant", value: 0 };
    const sequence = (xs: Expr[]): Expr =>
      xs.reduce((left, right): Expr => ({ type: "add", left, right }), zero);
    const p = Array.from({ length: width }, (_, i) => `p${i}`);
    const q = Array.from({ length: width }, (_, i) => `q${i}`);
    const ops: Op[] = [
      ...[...p, ...q].map((id, i): Op => ({ type: "signal", id, value: i })),
      { type: "signal", id: "flip", value: false },
      { type: "signal", id: "fault", value: outcome === "first-failure" },
      { type: "signal", id: "cleanupFault", value: false },
      {
        type: "effect",
        id: "w",
        expression: sequence([
          {
            type: "if",
            condition: get("flip"),
            then: sequence([...q].reverse().map(get)),
            else: sequence(p.map(get)),
          },
          get(p[0]!),
          {
            type: "if",
            condition: get("fault"),
            then: { type: "throw", message: "attempt" },
            else: zero,
          },
        ]),
        cleanup: {
          type: "if",
          condition: get("cleanupFault"),
          then: { type: "throw", message: "cleanup" },
          else: get(p[0]!),
        },
      },
      {
        type: "effect",
        id: "survivor",
        expression: sequence([...p, ...q].map(get)),
      },
    ];
    if (outcome === "never-run") ops.push({ type: "dispose", id: "w" });
    ops.push({ type: "flush" });
    for (let i = 0; i < attempts; i++)
      ops.push(
        { type: "set", id: "flip", value: (i & 1) === 0 },
        {
          type: "set",
          id: "fault",
          value: outcome === "first-failure" || outcome === "failed-rerun",
        },
        { type: "set", id: p[i % width]!, value: i + 100 },
        { type: "flush" },
      );
    if (outcome === "cleanup-throw")
      ops.push({ type: "set", id: "cleanupFault", value: true });
    ops.push(
      { type: "dispose", id: "w" },
      { type: "set", id: p[0]!, value: 999 },
      { type: "set", id: q[0]!, value: -999 },
      { type: "set", id: "fault", value: false },
      { type: "flush" },
      { type: "dispose", id: "w" },
      { type: "dispose", id: "survivor" },
      { type: "flush" },
    );
    return ops;
  });

describe("disposal differential", () => {
  it("releases successful, failed, never-run and throwing-cleanup watchers with unchanged observations", () => {
    fc.assert(
      fc.property(disposalPrograms, (operations) => {
        const result = runThreeWay(
          { id: "disposal-cursor", operations },
          (_op, i) => {
            checkGraph(quantNodes, `disposal-cursor@${i}`);
            expect(idle()).toBe(true);
          },
        );
        if (result.quantVsContract !== -1)
          throw new Error(
            `disposal mismatch at ${result.quantVsContract}\ncontract ${brief(result.contract).join(" | ")}\nquant ${brief(result.quant).join(" | ")}`,
          );
        const disposed = quantNodes.filter(
          (c) => (c.flags & Flag.Watch) !== 0 && c.fn === null,
        );
        expect(disposed.length).toBe(2);
        expect(disposed.every((c) => c.deps === null)).toBe(true);
      }),
      {
        numRuns: Number(process.env.QUANT_DISPOSE_RUNS ?? 300),
        seed: Number(process.env.QUANT_SEED ?? 7),
      },
    );
  });
});
