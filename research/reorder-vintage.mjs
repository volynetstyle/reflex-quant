// Replay the published slot decomposition with its own worker, field names,
// primitives, and allocation order. Only the index treatment changes setup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build, version } from "esbuild";

const revision = "816acde637bf1e6a41c4e890de664a4fd9febd0d";
const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".cache/reorder-vintage");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const files = git("ls-tree", "-r", "--name-only", revision, "src", "bench", "package.json", "package-lock.json").trim().split("\n");
for (const file of files) {
  const local = path.join(out, file);
  mkdirSync(path.dirname(local), { recursive: true });
  writeFileSync(local, git("show", revision + ":" + file));
}
const lock = JSON.parse(readFileSync(path.join(out, "package-lock.json"), "utf8"));
assert.equal(version, lock.packages["node_modules/esbuild"].version, "historical minifier");
const phases = path.join(out, "bench/cost/scenarios.mjs");
const source = readFileSync(phases, "utf8");
const anchor = "const decompose = {";
assert.equal(source.split(anchor).length, 2);
writeFileSync(phases, source.replace(anchor, anchor + `
  ...Object.fromEntries([1, 2, 3].map((phase) => ["index" + phase, (q, n) => {
    const { c, tick } = rawShuffle(q, n);
    q.set(tick, phase);
    q.get(c);
    const { index, clearIndex } = q;
    return (i) => {
      index(c, c.deps);
      clearIndex(c);
      return i & 1;
    };
  }])),
  ...Object.fromEntries(["none", "fill", "clear", "both"].map((mode) => ["address-" + mode, (q, n) => {
    const { c, tick, orders, ps } = rawShuffle(q, n);
    const edgeOf = new Map();
    for (let e = c.deps; e !== null; e = e.next) edgeOf.set(e.from, e);
    const schedules = orders.map((order) => [edgeOf.get(tick), ...order.map((id) => edgeOf.get(ps[id]))]);
    const filling = mode === "fill" || mode === "both";
    const clearing = mode === "clear" || mode === "both";
    let previous = 0;
    let verifying = true;
    const step = (i) => {
      const after = i & 3;
      q.setAddressOrders(filling ? schedules[previous] : null, clearing ? schedules[after] : null, verifying);
      q.set(tick, i);
      const result = q.get(c);
      previous = after;
      return result;
    };
    for (let i = 1; i <= 4; i++) {
      if (step(i) !== n * (n - 1) / 2) throw new Error("wrong oracle value");
      let e = c.deps, last = null;
      for (const expected of schedules[i & 3]) {
        if (e !== expected || e.prev !== last || e.from.slot !== null) throw new Error("wrong oracle topology");
        last = e;
        e = e.next;
      }
      if (e !== null) throw new Error("long oracle list");
    }
    verifying = false;
    return step;
  }])),
`));
const options = {
  entryPoints: [path.join(out, "bench/adapters/quant-internals.ts")],
  bundle: true, format: "esm",
  platform: "neutral", minify: true, target: "es2022",
  define: { __STATS__: "false", __DEV__: "false" },
};
await build({ ...options, outfile: path.join(out, "raw/index.mjs") });

// On the four known, complete permutations, supply only the addresses for
// the original index/clear walks. The comparison executes the historical
// production miss, slot lookup, move, public write and validation in full.
const kernelFile = path.join(out, "src/kernel.ts");
let kernel = readFileSync(kernelFile, "utf8");
const indexStart = kernel.indexOf("export function index(");
const loopStart = kernel.indexOf("  for (let e = c.deps;", indexStart);
const loopEnd = kernel.indexOf("\n}\n", loopStart);
assert.ok(indexStart > 0 && loopStart > indexStart && loopEnd > loopStart);
const original = kernel.slice(loopStart, loopEnd);
const vector = original.replace("for (let e = c.deps; e !== null; e = e.next) {",
  "for (let i = 0; i < fillOrder.length; i++) {\n    const e = fillOrder[i];");
assert.notEqual(vector, original);
kernel = kernel.slice(0, loopStart) + "  if (fillOrder !== null) {\n    if (verifyOrder) verifyWalk(c.deps, fillOrder);\n" + vector + "\n    return;\n  }\n" + kernel.slice(loopStart);
const clear = "  for (let e = n.deps; e !== null; e = e.next) e.from.slot = null;";
assert.equal(kernel.split(clear).length, 2);
kernel = kernel.replace(clear, `  if (clearOrder !== null) {
    if (verifyOrder) verifyWalk(n.deps, clearOrder);
    for (let i = 0; i < clearOrder.length; i++) clearOrder[i].from.slot = null;
  } else {
${clear}
  }`);
writeFileSync(kernelFile, kernel + `
let fillOrder: Edge[] | null = null, clearOrder: Edge[] | null = null;
let verifyOrder = false;
function verifyWalk(edge: Edge | null, schedule: Edge[]) {
  for (const expected of schedule) {
    if (edge !== expected) throw new Error("schedule differs from actual traversal");
    edge = edge.next;
  }
  if (edge !== null) throw new Error("short schedule");
}
export function setAddressOrders(fill: Edge[] | null, clear: Edge[] | null, verify: boolean) {
  fillOrder = fill;
  clearOrder = clear;
  verifyOrder = verify;
}
`);
const adapter = path.join(out, "bench/adapters/quant-internals.ts");
writeFileSync(adapter, readFileSync(adapter, "utf8") + '\nexport { setAddressOrders } from "../../src/kernel.ts";\n');
await build({ ...options, outfile: path.join(out, "addresses/index.mjs") });
