// Subscriber-side retention probe: one source, few long-lived watchers replaced
// rarely under a fast rotation of short ones. A removed edge that still points
// at younger subscribers keeps them alive across scavenges: watch peakMB and scav.
//
//   node --expose-gc bench/sub-churn.mjs [bundle-dir]   (LONG=1 PERIOD=20000)
import { pathToFileURL } from "node:url";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
const api = await import(
  pathToFileURL(
    path.join(
      path.resolve(process.argv[2] ?? ".cache/bench/quant"),
      "index.mjs",
    ),
  ).href
);
const LONG = +(process.env.LONG ?? 1),
  SHORT = 32,
  PERIOD = +(process.env.PERIOD ?? 20000),
  STEPS = 400000;
let gcMs = 0,
  scav = 0,
  major = 0;
new PerformanceObserver((l) => {
  for (const e of l.getEntries()) {
    gcMs += e.duration;
    e.detail?.kind === 1 ? scav++ : major++;
  }
}).observe({ entryTypes: ["gc"] });
const s = api.signal(0);
let sink = 0;
const mk = () =>
  api.effect(() => {
    sink += s.get();
  });
const long = Array.from({ length: LONG }, mk);
const short = Array.from({ length: SHORT }, mk);
let li = 0,
  si = 0,
  peak = 0;
const step = (i) => {
  short[si]();
  short[si] = mk();
  si = (si + 1) % SHORT;
  if (i % PERIOD === 0) {
    long[li]();
    long[li] = mk();
    li = (li + 1) % LONG;
  }
};
for (let i = 1; i <= 50000; i++) step(i);
globalThis.gc?.();
gcMs = scav = major = 0;
const t = process.hrtime.bigint();
for (let i = 1; i <= STEPS; i++) {
  step(i);
  if ((i & 4095) === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
}
const ns = Number(process.hrtime.bigint() - t) / STEPS;
await new Promise((r) => setTimeout(r, 50));
console.log(
  JSON.stringify({
    ns: +ns.toFixed(0),
    gcMs: +gcMs.toFixed(1),
    scav,
    major,
    peakMB: +(peak / 1048576).toFixed(1),
    sink: sink & 1,
  }),
);
