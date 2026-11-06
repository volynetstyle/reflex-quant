// Level 2: the same programs on the executable spec, the contract spec
// (spec + D1/D2, test/support/contract-spec.ts), current Reflex and the quant
// runtime. The gate: quant equals the contract spec on every program, so
// each quant-vs-spec difference is explained by D1 or D2. Reflex's own
// differences are counted, not gated (research/REPORT.md classifies them).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Op, Program } from "../bin/reflex-runtime/test/differential/api";
import { enumerateBoundedPrograms } from "../bin/reflex-runtime/test/differential/bounded-exhaustive";
import { enumerateRecoveryPrograms } from "../bin/reflex-runtime/test/differential/recovery-exhaustive";
import { historicalFaults } from "../bin/reflex-runtime/test/differential/catalog/historical";
import { contractBoundaries } from "../bin/reflex-runtime/test/differential/catalog/boundaries";
import { brief, quantNodes, runThreeWay, type ThreeWay } from "./support/machines";
import { checkGraph } from "./support/graph";
import { probes } from "./support/probes";
import { programArbitrary } from "./support/generator";

interface Tally {
  total: number;
  /** quant differs from the contract spec: a quant bug. */
  quantBug: number;
  /** contract spec differs from the spec: explained by D1/D2 (D6 is outside the program language). */
  d1d2: number;
  /** Reflex differs from the contract spec: Reflex's own deviations. */
  reflexOwn: number;
  witnesses: string[];
}

const describeRun = (r: ThreeWay) =>
  `${r.program.id}\n  spec     ${brief(r.spec).join(" | ")}\n  contract ${brief(r.contract).join(" | ")}\n  reflex   ${brief(r.reflex).join(" | ")}\n  quant    ${brief(r.quant).join(" | ")}`;

function tally(programs: readonly Program[]): Tally {
  const t: Tally = { total: 0, quantBug: 0, d1d2: 0, reflexOwn: 0, witnesses: [] };
  for (const program of programs) {
    const r = runThreeWay(program, (_op, index) => checkGraph(quantNodes, `${program.id}@${index}`));
    t.total++;
    if (r.quantVsContract >= 0) {
      t.quantBug++;
      if (t.witnesses.length < 3) t.witnesses.push(describeRun(r));
    }
    if (r.contractVsSpec >= 0) t.d1d2++;
    if (r.reflexVsContract >= 0) t.reflexOwn++;
  }
  console.log(`== ${t.total} programs: quant≠contract ${t.quantBug}, contract≠spec (D1/D2/D6) ${t.d1d2}, reflex≠contract ${t.reflexOwn}`);
  t.witnesses.forEach((w) => console.log(w));
  return t;
}

const asPrograms = (list: readonly { name: string; program: readonly Op[] }[]): Program[] =>
  list.map((p) => ({ id: p.name, operations: p.program }));

describe("four-way differential", () => {
  it("phase 0 probes pin their classification", () => {
    const verdicts = Object.fromEntries(
      probes.map((p) => {
        const r = runThreeWay(p, (_op, i) => checkGraph(quantNodes, `${p.id}@${i}`));
        return [p.id, { quantVsContract: r.quantVsContract < 0, contractIsSpec: r.contractVsSpec < 0, reflexIsContract: r.reflexVsContract < 0 }];
      }),
    );
    const ok = { quantVsContract: true, contractIsSpec: true, reflexIsContract: true };
    expect(verdicts).toEqual({
      "P1-validation-quantifier": { ...ok, contractIsSpec: false },
      "P2-failed-computed-old-frontier": { ...ok, contractIsSpec: false },
      "P3-tentative-read-validated": { ...ok, reflexIsContract: false },
      "P4-retry-set-of-repeated-failures": { ...ok, reflexIsContract: false },
      "P5-committed-unread-wakes": ok,
      "P6-direct-aba": ok,
      "P7-cutoff": ok,
      "P10-watcher-barrier": ok,
      "P9-obligation-survives-unchanged-wake": { ...ok, reflexIsContract: false },
      "P8-throwing-cleanup": ok,
    });
  });

  it("historical faults and contract boundaries", () => {
    const t = tally([
      ...historicalFaults.map((f) => ({ id: f.id, operations: f.program })),
      ...contractBoundaries.map((b) => ({ id: b.id, operations: b.program })),
    ]);
    expect([t.quantBug, t.d1d2, t.reflexOwn]).toEqual([0, 0, 0]);
  });

  it("bounded exhaustive language", () => {
    const t = tally(asPrograms(enumerateBoundedPrograms()));
    expect([t.quantBug, t.d1d2, t.reflexOwn]).toEqual([0, 0, 0]);
  });

  it("recovery exhaustive language", () => {
    const t = tally(asPrograms(enumerateRecoveryPrograms()));
    expect([t.quantBug, t.d1d2, t.reflexOwn]).toEqual([0, 0, 0]);
  });

  it("generated programs: dynamic branches, failures, cleanups, disposal", () => {
    const runs = Number(process.env.QUANT_RUNS ?? 4000);
    const seed = Number(process.env.QUANT_SEED ?? 7);
    const t = tally(fc.sample(programArbitrary, { numRuns: runs, seed }).map((operations, i) => ({ id: `gen-${i}`, operations })));
    expect(t.quantBug).toBe(0);
  });
});
