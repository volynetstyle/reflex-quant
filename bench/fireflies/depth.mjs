// How deep effects nest inside one another in alien-signals on this model (64x40 unless FW/FH set).
// Run with a larger stack to see the full depth:  node --stack-size=20000 depth.mjs
import * as I from "./impls.mjs";
import { seed } from "./seed.mjs";
const m = await import("alien-signals");
const un = (f) => { const p = m.setActiveSub(undefined); try { return f(); } finally { m.setActiveSub(p); } };
const tick = m.signal(0), pulse = seed().map(() => m.signal(0));
const st = seed().map((p) => ({ phase: p, tick: 0, lit: -1e9 }));
let depth = 0, maxDepth = 0, maxTick = 0, t = 0;
st.forEach((s, i) => m.effect(() => {
  if (++depth > maxDepth) { maxDepth = depth; maxTick = t; }
  try {
    const tt = tick(), inc = pulse[i]();
    un(() => {
      if (inc) pulse[i](0);
      s.phase += (tt - s.tick) * I.DT; s.tick = tt;
      if (inc && tt - s.lit > I.REF) s.phase += inc;
      if (s.phase >= 1) { s.phase = 0; s.lit = tt; for (const j of I.NB[i]) pulse[j](un(() => pulse[j]()) + I.EPS); }
    });
  } finally { depth--; }
}));
try {
  for (t = 1; t <= 2000; t++) {
    tick(t);
    for (let again = true; again;) { again = false; for (let i = 0; i < I.N; i++) if (un(() => pulse[i]()) !== 0) { again = true; m.trigger(() => pulse[i]()); } }
  }
  console.log(`no overflow in 2000 ticks; deepest nesting ${maxDepth} effects (tick ${maxTick}) of ${I.N} fireflies`);
} catch (e) { console.log(`${e.constructor.name} at tick ${t}; deepest nesting reached ${maxDepth} effects of ${I.N} fireflies`); }
