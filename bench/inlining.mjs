// A public-API workload for JIT traces, not an assertion about engine policy.
// Build first, then retain names for readable traces, or use dist/index.js:
// node --trace-opt --trace-turbo-inlining --trace-maglev-inlining \
//   bench/inlining.mjs .cache/release/inspect.js cutoff 400000
// Profiles: cutoff/change use a 3-node validation chain; deep uses 1,200.
import path from "node:path";
import { pathToFileURL } from "node:url";

const [bundle, profile = "cutoff", count] = process.argv.slice(2);
if (!bundle || !["cutoff", "change", "deep"].includes(profile)) {
  throw new Error(
    "usage: node bench/inlining.mjs <bundle> [cutoff|change|deep] [steps]",
  );
}
const steps = Number(count ?? (profile === "deep" ? 50000 : 400000));
if (!Number.isSafeInteger(steps) || steps < 1 || steps > 1_000_000) {
  throw new Error("steps must be an integer between 1 and 1000000");
}
const { signal, computed, get, set } = await import(
  pathToFileURL(path.resolve(bundle)).href
);
const source = signal(0);
let tip = computed(() => {
  const value = get(source);
  return profile === "cutoff" ? value & 1 : value;
});
get(tip);
const depth = profile === "deep" ? 1200 : 3;
for (let i = 0; i < depth; i++) {
  const below = tip;
  tip = computed(() => get(below) + 1);
  get(tip); // Build bottom-up so cold JS recursion is not the workload.
}
let checksum = 0;
for (let i = 1; i <= steps; i++) {
  set(source, profile === "cutoff" ? i * 2 : i);
  checksum = (checksum + get(tip)) | 0;
}
const expected =
  (steps * depth + (profile === "cutoff" ? 0 : (steps * (steps + 1)) / 2)) | 0;
if (checksum !== expected)
  throw new Error(`checksum ${checksum} != ${expected}`);
console.log(
  JSON.stringify({
    profile,
    depth,
    steps,
    checksum,
    node: process.versions.node,
    v8: process.versions.v8,
  }),
);
