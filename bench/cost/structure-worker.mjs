// Structural work of one cost scenario on quant, in a fresh process (the stack
// high-water mark is cumulative, so one scenario per process).
//
//   node --expose-gc bench/cost/structure-worker.mjs <scenario-id>
//
// Prints one JSON line: kernel counters per step (mean over 256 steps after 64
// warm-up steps), the work stack's high-water mark, and the heap after setup.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scenarios } from "./scenarios.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const [id] = process.argv.slice(2);
const scenario = scenarios.find((s) => s.id === id);
if (scenario === undefined) throw new Error(`unknown scenario ${id}`);
const api = await import(pathToFileURL(path.join(root, ".cache/bench/quant-stats/index.mjs")).href);

// Two full collections each side: one is not always enough to settle the heap.
const settle = () => (globalThis.gc?.(), globalThis.gc?.(), process.memoryUsage().heapUsed);
const base = settle();
const step = scenario.setup(api);
const graphBytes = settle() - base;

const STEPS = 256;
for (let i = 1; i <= 64; i++) step(i);
const before = { ...api.stats };
for (let i = 65; i < 65 + STEPS; i++) step(i);
const perStep = Object.fromEntries(Object.keys(api.stats).map((k) => [k, (api.stats[k] - before[k]) / STEPS]));
console.log(JSON.stringify({ id, perStep, stackHighWater: api.stackHighWater(), graphBytes }));
