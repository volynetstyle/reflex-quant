// Research tool (QUANT_TOOLS=1): attribute Reflex's own divergences. Run it
// twice: against src (quant vs Reflex) and against the Reflex-emulation
// mutant (research/mutants.mjs --emulate-reflex prints the directory):
//
//   QUANT_TOOLS=1 npx vitest run --config vitest.config.ts test/tools/attribution
//   QUANT_TOOLS=1 QUANT_SRC=<dir> npx vitest run --config vitest.config.ts test/tools/attribution
import { it } from "vitest";
import fc from "fast-check";
import { runThreeWay, brief } from "../support/machines";
import { programArbitrary } from "../support/generator";
import { shrink, describeOps } from "../support/shrink";

it("counts quant/Reflex differences on the generated corpus", () => {
  const runs = Number(process.env.QUANT_RUNS ?? 25000);
  const seeds = (process.env.SEEDS ?? "11,23,101,202").split(",").map(Number);
  let total = 0;
  let differ = 0;
  let shown = 0;
  for (const seed of seeds) {
    for (const [i, operations] of fc.sample(programArbitrary, { numRuns: runs, seed }).entries()) {
      const r = runThreeWay({ id: `gen-${i}`, operations });
      total++;
      if (r.quantVsReflex < 0) continue;
      differ++;
      if (shown++ < 3) {
        const s = shrink(r.program, (p) => runThreeWay(p).quantVsReflex >= 0);
        const x = runThreeWay(s);
        console.log(`\n### seed ${seed} gen-${i}\n${describeOps(s.operations)}\n reflex ${brief(x.reflex).join(" | ")}\n quant  ${brief(x.quant).join(" | ")}`);
      }
    }
  }
  console.log(`\n== ${process.env.QUANT_SRC ? "emulation" : "quant"} vs Reflex: ${differ} of ${total} programs differ`);
});
