// Research tool (QUANT_TOOLS=1): shrink every generated program whose
// three-way verdict is not all-agree and print one witness per shape.
//   QUANT_TOOLS=1 SEEDS=11,23 npx vitest run --config vitest.config.ts test/tools
import { it } from "vitest";
import fc from "fast-check";
import { runThreeWay, brief, type ThreeWay } from "../support/machines";
import { shrink, describeOps } from "../support/shrink";
import { programArbitrary } from "../support/generator";

const kinds: Record<string, (r: ThreeWay) => boolean> = {
  "quant=reflex, spec differs": (r) => r.quantVsReflex < 0 && r.quantVsSpec >= 0,
  "quant=spec, reflex differs": (r) => r.quantVsSpec < 0 && r.reflexVsSpec >= 0,
  "quant differs from both": (r) => r.quantVsReflex >= 0 && r.quantVsSpec >= 0,
};

it("shrinks divergent generated programs", () => {
  const runs = Number(process.env.QUANT_RUNS ?? 25000);
  for (const seed of (process.env.SEEDS ?? "11,23").split(",").map(Number)) {
    const seen = new Set<string>();
    for (const [i, operations] of fc.sample(programArbitrary, { numRuns: runs, seed }).entries()) {
      const r = runThreeWay({ id: `gen-${i}`, operations });
      for (const [kind, holds] of Object.entries(kinds)) {
        if (!holds(r)) continue;
        const s = shrink(r.program, (p) => holds(runThreeWay(p)));
        const key = describeOps(s.operations);
        if (seen.has(key)) continue;
        seen.add(key);
        const x = runThreeWay(s);
        console.log(`\n### ${kind} | seed ${seed} gen-${i} (${s.operations.length} ops)\n${key}\n spec   ${brief(x.spec).join(" | ")}\n reflex ${brief(x.reflex).join(" | ")}\n quant  ${brief(x.quant).join(" | ")}`);
      }
    }
  }
});
