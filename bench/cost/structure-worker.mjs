// Structural work of one scenario on a quant stats bundle, in a fresh process
// (the stack high-water mark is cumulative, so one scenario per process).
//
//   node --expose-gc bench/cost/structure-worker.mjs <scenario-id> [--bundle <dir>] [--suite <name>]
//
// Defaults: the quant-stats bundle (.cache/bench/quant-stats) and the cost
// suite. Prints one JSON line: kernel counters per step (mean over 256 steps
// after 64 warm-up steps), the work stack's high-water mark, and the heap
// after setup.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { suiteOf } from "../suites.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const [id] = args;
const bundle = args.includes("--bundle") ? args[args.indexOf("--bundle") + 1] : path.join(root, ".cache/bench/quant-stats");
const { scenarios } = suiteOf(args.includes("--suite") ? args : [...args, "--suite", "cost"]);
const scenario = scenarios.find((s) => s.id === id);
if (scenario === undefined) throw new Error(`unknown scenario ${id}`);
const api = await import(pathToFileURL(path.join(path.resolve(bundle), "index.mjs")).href);

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
