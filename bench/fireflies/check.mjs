// Same answers: every runtime against the hand-written worklist, state compared after every tick.
// Usage: node check.mjs [names] [ticks]     e.g. node check.mjs quant,alien 1500
import * as I from "./impls.mjs";
import { ALL, seed } from "./seed.mjs";
const names = process.argv[2] ? process.argv[2].split(",") : ALL;
const TICKS = +(process.argv[3] || 1500);
let failed = false;
for (const n of names) {
  const ref = await I.plain(seed()), o = await I[n](seed());
  let bad = "", flashes = 0, t = 0;
  try {
    for (t = 1; t <= TICKS && !bad; t++) {
      ref.step(); o.step();
      const rl = ref.lits(), rp = ref.phases(), l = o.lits(), p = o.phases();
      for (let i = 0; i < I.N; i++) {
        if (rl[i] === t) flashes++;
        if (l[i] !== rl[i] || Math.abs(p[i] - rp[i]) > 1e-9) { bad = `differs at tick ${t}, firefly ${i}: phase ${p[i].toFixed(4)}, expected ${rp[i].toFixed(4)}`; break; }
      }
    }
  } catch (e) { bad = `${e.constructor.name} at tick ${t}: ${String(e.message).slice(0, 60)}`; }
  failed ||= !!bad;
  console.log(n.padEnd(11), bad || `same state on all ${TICKS} ticks (${flashes} flashes); callbacks/tick ${(o.runs / TICKS).toFixed(0)} (worklist ${(ref.runs / TICKS).toFixed(0)})`);
}
process.exit(failed ? 1 : 0);
