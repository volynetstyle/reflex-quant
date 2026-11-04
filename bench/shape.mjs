// JIT shape probe: run one scenario on one bundle for N steps, without any
// timing, so V8 traces (deopts, field generalizations, inlining) can be read
// from a steady state. Shape facts are deterministic; timing stays on CI.
//
//   node --trace-deopt --trace-generalization bench/shape.mjs <bundle-dir> <scenario> [steps]
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scenarios } from "./scenarios.mjs";

const [dir, id, steps = "20000"] = process.argv.slice(2);
const api = await import(pathToFileURL(path.join(path.resolve(dir), "index.mjs")).href);
const scenario = scenarios.find((s) => s.id === id);
if (scenario === undefined) throw new Error(`unknown scenario ${id}`);
const step = scenario.setup(api);
let sink = 0;
for (let i = 1; i <= Number(steps); i++) sink = (sink + (Number(step(i)) | 0)) | 0;
console.log(`# ${api.name} ${id} ${steps} steps, sink ${sink & 1}`);
