// Build each experiment with the production adapter, plus separate counting
// and raw-debug bundles. Source copies can also be passed to QUANT_SRC.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const fragment = readFileSync(path.join(import.meta.dirname, "reorder-learning.ts"), "utf8");
const counters = [
  "trainingStarts", "trainingRuns", "trainingVisits", "trainingRetires",
  "qualifyingRuns", "promotions", "demotions", "threadRuns", "threadAppends",
  "threadOldVisits", "threadRepairs", "witnessCellsBuilt", "witnessRuns",
  "witnessFillVisits", "witnessClearVisits", "witnessListClears",
];
const args = process.argv.slice(2);
const variants = args.length === 0 ? ["observe", "thread", "witness"] : args;

for (const variant of variants) {
  assert.ok(["observe", "thread", "witness"].includes(variant));
  const out = path.join(root, ".cache/reorder-learning", variant);
  mkdirSync(out, { recursive: true });
  const src = path.join(out, "src");
  cpSync(path.join(root, "src"), src, { recursive: true });
  const filename = path.join(src, "kernel.ts");
  const original = readFileSync(filename, "utf8").replaceAll("\r\n", "\n");
  let kernel = original;
  function edit(anchor, patch) {
    assert.equal(kernel.split(anchor).length, 2, "missing or ambiguous anchor: " + anchor);
    kernel = kernel.replace(anchor, () => patch);
  }

  edit("  if (__STATS__) stats.indexes++;", "  if (next !== null) recordBudget(c, 2);\n  if (__STATS__) stats.indexes++;");
  edit("  if (__STATS__) stats.sweeps++;", "  recordBudget(c, 1);\n  if (__STATS__) stats.sweeps++;");
  edit("  if (__STATS__) stats.links++;", "  recordBirth(c);\n  if (__STATS__) stats.links++;");
  edit("  if (__STATS__) stats.moves++;", "  recordMoved(c);\n  if (__STATS__) stats.moves++;");
  if (variant === "thread") {
    edit("  if (found !== null && found !== undefined) begin(c, found, first, next);", `  if (found !== null && found !== undefined) {
    if (found === first && next !== null && startLearnedThread(c, s, found, last, next)) return;
    begin(c, found, first, next);
  }`);
    edit("  }\n  near(c, s, last, next, first);", `  } else {
    const state = trial;
    if (state?.consumer === c && state.head !== null) return readLearnedThread(state, s, last, first);
  }
  near(c, s, last, next, first);`);
  }
  if (variant === "witness") {
    edit("  const first = s.firstSub;\n\n  // Absent", `  if (last === null && trial?.consumer === c && trial.usingWitness) return slot(c, s, null, next);
  const first = s.firstSub;

  // Absent`);
    edit("  while (top > base) {\n    const cell = stack[--top] as Edge;",
      "  restoreDisplacedSlots(base);\n}\n\nfunction restoreDisplacedSlots(base: number): void {\n  while (top > base) {\n    const cell = stack[--top] as Edge;");
  }
  for (const pattern of [
    /export function read\(n: Node\): unknown \{[\s\S]*?\n\}(?=\n)/,
    /export function exec\(n: Node\): void \{[\s\S]*?\n\}(?=\n)/,
  ]) assert.equal(kernel.match(pattern)?.[0], original.match(pattern)?.[0], "hot entry changed");
  const witnessStart = fragment.indexOf("// Vector lookup");
  const threadStart = fragment.indexOf("function startLearnedThread(");
  assert.ok(witnessStart > 0 && threadStart > witnessStart);
  let learner = fragment.slice(0, witnessStart).replace("__EXPERIMENT__", variant);
  if (variant === "witness") learner += fragment.slice(witnessStart, threadStart);
  else learner = learner
    .replace("    const base = top;\n", "")
    .replace(/^.*openWitness\(state\).*\n/m, "")
    .replace(/^.*closeWitness\(state, base\).*\n/m, "");
  if (variant === "thread") learner += fragment.slice(threadStart);
  else learner = learner.replace(/^.*finishThread\(state, last\).*\n/m, "");
  writeFileSync(filename, kernel + "\n" + learner);

  const statsFile = path.join(src, "instrumentation.ts");
  const stats = readFileSync(statsFile, "utf8");
  assert.ok(stats.includes("  reads: 0,"));
  writeFileSync(statsFile, stats.replace("  reads: 0,", counters.map((key) => `  ${key}: 0,\n`).join("") + "  reads: 0,"));
  writeFileSync(path.join(out, "tsconfig.json"),
    JSON.stringify({ extends: "../../../tsconfig.json", include: ["src"] }) + "\n");

  for (const [name, adapter, counting] of [
    ["api", "quant.mjs", false],
    ["api-stats", "quant-stats.mjs", true],
    ["raw-stats", "quant-internals.ts", true],
  ]) {
    await build({
      entryPoints: [path.join(root, "bench/adapters", adapter)],
      outfile: path.join(out, name, "index.mjs"),
      bundle: true, minify: true, target: "es2022", platform: "neutral", format: "esm",
      define: { __STATS__: String(counting), __DEV__: "false" },
      plugins: [{
        name: "learning-source",
        setup(plugin) {
          plugin.onResolve({ filter: /[\\/]src[\\/][\w-]+\.ts$/ }, ({ path: specifier }) => ({
            path: path.join(src, path.basename(specifier)),
          }));
          if (name === "raw-stats") {
            plugin.onLoad({ filter: /quant-internals\.ts$/ }, ({ path: file }) => ({
              contents: readFileSync(file, "utf8") + '\nexport { stats } from "../../src/kernel.ts";\n',
              loader: "ts",
            }));
          }
        },
      }],
    });
  }
}
