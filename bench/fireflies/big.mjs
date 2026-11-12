// What happens as the field grows. Default stack size, state compared with the worklist at the end.
//   FW=200 FH=200 node big.mjs quant 900
import * as I from "./impls.mjs";
import { seed } from "./seed.mjs";
const name = process.argv[2] || "quant", TICKS = +(process.argv[3] || 900);
const o = await I[name](seed()), p = await I.plain(seed());
let maxFlash = 0, t = 0;
const t0 = performance.now();
try {
  for (t = 1; t <= TICKS; t++) {
    p.step(); o.step();
    let n = 0; for (const l of p.lits()) if (l === t) n++;
    if (n > maxFlash) maxFlash = n;
  }
  const a = o.lits(), b = p.lits();
  console.log(name.padEnd(11), a.every((x, i) => x === b[i]) ? "same state as the worklist" : "DIFFERENT state", `| biggest flash ${maxFlash}/${I.N} | ${((performance.now() - t0) / 1000).toFixed(1)} s for ${TICKS} ticks`);
} catch (e) { console.log(name.padEnd(11), `${e.constructor.name}: ${String(e.message).slice(0, 60)} at tick ${t} (biggest flash before it: ${maxFlash}/${I.N})`); }
