// Checks that the stack visualization (src/scripts/sim.ts) reproduces the real reflex-quant:
// same callbacks, same order, same console output, for every scenario. Needs ../dist (npm run build at the root).
import { SCENARIOS, quant, naive } from "../src/scripts/sim.ts";
import * as R from "../../dist/index.development.js";
let bad = 0;
for (const sc of SCENARIOS) {
  // Real library: trace callback runs and logs per action.
  let on = false; const real = [];
  const wrap = (id, fn) => () => { if (on) real.push("run " + id); return fn(); };
  const api = {
    signal: (id, l, v) => R.signal(v),
    computed: (id, l, fn) => R.computed(wrap(id, fn)),
    effect: (id, l, fn) => R.effect(wrap(id, fn)),
    get: (h) => R.get(h), set: (h, v) => R.set(h, v),
    log: (...a) => { if (on) real.push("log " + a.map((x) => Array.isArray(x) ? `[${x.join(", ")}]` : String(x)).join(" ")); },
  };
  const h = sc.build(api); on = true;
  for (const act of sc.actions) { real.push("== " + act.line); act.run(api, h); }
  // Simulator: same events from the step notes.
  const steps = quant(sc); const sim = []; let lastLog = 0; let act = -1;
  const lines = sc.actions.map((a) => a.line);
  for (const s of steps) {
    if (/^Done with this write/.test(s.note) || /^Setup done/.test(s.note)) continue;
    const ai = lines.indexOf(s.line);
    if (/^\S+ = .* A write only marks|already holds/.test(s.note)) { act++; sim.push("== " + lines[act]); }
    const m = s.note.match(/^(\S+) runs/); if (m) sim.push("run " + m[1]);
    while (s.log.length > lastLog) sim.push("log " + s.log[lastLog++]);
  }
  const ok = JSON.stringify(real) === JSON.stringify(sim);
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "DIFF"} ${sc.id}: ${steps.length} quant steps, ${naive(sc).length} naive steps`);
  if (!ok) { console.log("  real:", real.join(" | ")); console.log("  sim: ", sim.join(" | ")); }
  // Naive must log the same thing.
  const nlogs = naive(sc).at(-1).log, rlogs = real.filter((x) => x.startsWith("log ")).map((x) => x.slice(4));
  console.log("  logs  quant:", JSON.stringify(rlogs), " naive:", JSON.stringify(nlogs));
}
console.log(bad ? `${bad} mismatches` : "all scenarios match the real library");
process.exitCode = bad ? 1 : 0;
