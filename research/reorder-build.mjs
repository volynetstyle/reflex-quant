// Build a source copy for QUANT_SRC and use the production benchmark adapters.
// Anchors fail closed on source drift. The shipping kernel is never written.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".cache/reorder-suffix");
const src = path.join(out, "src");
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "src"), src, { recursive: true });
const file = path.join(src, "kernel.ts");
let kernel = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
function edit(anchor, replacement) {
  assert.equal(kernel.split(anchor).length, 2, "non-unique or missing kernel anchor: " + anchor);
  kernel = kernel.replace(anchor, () => replacement);
}
const fragment = readFileSync(path.join(import.meta.dirname, "reorder-suffix.ts"), "utf8");
edit("const compare = Object.is;", "const compare = Object.is;\n" + fragment);
edit("  const prevCursor = cursor;\n  const base = top;", `  const prevCursor = cursor;
  const outerSuffix = suffix;
  suffix = null;
  const base = top;`);
for (const indent of ["    ", "  "]) {
  const anchor = `\n${indent}const last = cursor as Edge | null;\n${indent}active = prev;`;
  edit(anchor, `\n${indent}const last = cursor as Edge | null;
${indent}if (suffix !== null) closeSuffix(n, last);
${indent}suffix = outerSuffix;
${indent}active = prev;`);
}
edit("  // An indexed pass owns", `  if (next === null && suffix !== null) return readSuffix(c, s, last);
  // An indexed pass owns`);
edit("  if (found !== null && found !== undefined) begin(c, found, first, next);", `  if (found !== null && found !== undefined && next !== null) {
    if (found === first) {
      openSuffix(c, last, next);
      return appendSeen(c, s, found, last);
    }
    index(c, next);
  }`);
const from = kernel.indexOf("/**\n * The pass's lookup from here on");
const to = kernel.indexOf("/**\n * A found edge:", from);
assert.ok(from >= 0 && to > from);
kernel = kernel.slice(0, from) + kernel.slice(to);
writeFileSync(file, kernel);
const statsFile = path.join(src, "instrumentation.ts");
const stats = readFileSync(statsFile, "utf8");
assert.ok(stats.includes("  reads: 0,"));
writeFileSync(statsFile, stats.replace("  reads: 0,",
  "  snapshots: 0,\n  savedEdges: 0,\n  snapshotHits: 0,\n  appends: 0,\n  restoreVisits: 0,\n  restoredEdges: 0,\n  reads: 0,"));

for (const [dir, adapter, counting] of [
  ["api", "quant.mjs", false],
  ["api-stats", "quant-stats.mjs", true],
  ["raw", "quant-internals.ts", false],
]) {
  await build({
    entryPoints: [path.join(root, "bench/adapters", adapter)],
    outfile: path.join(out, dir, "index.mjs"),
    bundle: true, minify: true, target: "es2022", platform: "neutral", format: "esm",
    define: { __STATS__: String(counting), __DEV__: "false" },
    plugins: [{ name: "research-source", setup(plugin) {
      plugin.onResolve({ filter: /[\\/]src[\\/][\w-]+\.ts$/ }, ({ path: specifier }) => ({
        path: path.join(src, path.basename(specifier)),
      }));
    } }],
  });
}
