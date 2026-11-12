// One measurement: one runtime, one scenario, one fresh process.
//
//   node --expose-gc bench/worker.mjs <bundle-dir> <scenario-id> [--verify] [--suite <name>] [--no-gc] [--gc]
//
// Prints one JSON line. --verify prints only the checksum of the first 64
// steps, which must be equal for every runtime (same program, same answers).
// --no-gc skips the full collection before sampling (the graph stays where
// allocation put it, usually new space); --gc reports the collections that
// ran while sampling and the heap by space when sampling started.
import path from "node:path";
import v8 from "node:v8";
import { pathToFileURL } from "node:url";
import { suiteOf } from "./suites.mjs";

const [dir, id] = process.argv.slice(2);
const { scenarios } = suiteOf(process.argv);
const verify = process.argv.includes("--verify");
const noGc = process.argv.includes("--no-gc");
const gcReport = process.argv.includes("--gc");
const api = await import(pathToFileURL(path.join(path.resolve(dir), "index.mjs")).href);
const scenario = scenarios.find((s) => s.id === id);
if (scenario === undefined) throw new Error(`unknown scenario ${id}`);

const fold = (acc, value) => (Math.imul(acc, 31) + (Number(value) | 0)) | 0;
const step = scenario.setup(api);
let checksum = 7;
for (let i = 1; i <= 64; i++) {
  const value = step(i);
  if (!Number.isFinite(Number(value))) throw new Error(`${id}: non-finite result at step ${i}: ${value}`);
  checksum = fold(checksum, value);
}
if (verify) {
  console.log(JSON.stringify({ id, runtime: api.name, checksum }));
  process.exit(0);
}

let sink = 0;
let i = 65;
const now = () => process.hrtime.bigint();
// Warm-up: at least 300 ms and 2,000 steps, so every tier has compiled.
for (const start = now(); now() - start < 300_000_000n || i < 2_065; ) sink = fold(sink, step(i++));
// Calibrate a batch to ~10 ms.
let batch = 1;
for (;;) {
  const t = now();
  for (let k = 0; k < batch; k++) sink = fold(sink, step(i++));
  if (now() - t > 10_000_000n || batch > 1 << 24) break;
  batch *= 2;
}
if (!noGc) globalThis.gc?.();
let heap;
let profiler;
if (gcReport) {
  const used = (name) => v8.getHeapSpaceStatistics().find((s) => s.space_name === name)?.space_used_size ?? 0;
  heap = { heapUsed: process.memoryUsage().heapUsed, newSpace: used("new_space"), oldSpace: used("old_space") };
  profiler = new v8.GCProfiler();
  profiler.start();
}
const samples = [];
for (let s = 0; s < 21; s++) {
  const t = now();
  for (let k = 0; k < batch; k++) sink = fold(sink, step(i++));
  samples.push(Number(now() - t) / batch);
}
let gc;
if (profiler !== undefined) {
  const events = profiler.stop().statistics;
  gc = { events: events.length, costUs: events.reduce((a, e) => a + e.cost, 0), types: {} };
  for (const e of events) gc.types[e.gcType] = (gc.types[e.gcType] ?? 0) + 1;
}
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    id,
    runtime: api.name,
    checksum,
    nsPerStep: samples[10],
    q1: samples[5],
    q3: samples[15],
    batch,
    sink: sink & 1,
    ...(gcReport ? { heap, gc, steps: 21 * batch } : {}),
  }),
);
