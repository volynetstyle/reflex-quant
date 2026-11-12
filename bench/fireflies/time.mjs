// Time per tick. One runtime per process, so no runtime warms up another's code:
//   for n in plain quant preact vue solid angular alienDrain; do node time.mjs $n; done
import * as I from "./impls.mjs";
import { seed } from "./seed.mjs";
const name = process.argv[2] || "quant", ROUNDS = 7, WARM = 200, TICKS = 1500;
const res = [];
try {
  for (let k = 0; k < ROUNDS; k++) {
    const o = await I[name](seed());
    for (let t = 0; t < WARM; t++) o.step();
    const t0 = performance.now();
    for (let t = 0; t < TICKS; t++) o.step();
    res.push((performance.now() - t0) / TICKS);
  }
  res.sort((a, b) => a - b);
  console.log(name.padEnd(11), `median ${res[3].toFixed(3)} ms/tick  (min ${res[0].toFixed(3)}, max ${res[6].toFixed(3)}; ${I.W}x${I.H}, ${ROUNDS} rounds of ${TICKS} ticks)`);
} catch (e) { console.log(name.padEnd(11), `${e.constructor.name}: ${String(e.message).slice(0, 60)}`); }
