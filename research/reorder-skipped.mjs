// Structural probe for a selective exact witness already carried by an edge.
// A SKIPPED tag on the pair returned by the bounded subscriber scan certifies
// an unread edge. Prediction for an eight-swap window: the large suffix walk
// vanishes at fixed edit size as the untouched suffix grows. No timing here.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { range } from "../bench/scaling.mjs";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".cache/reorder-skipped");
mkdirSync(out, { recursive: true });
const anchor = "  if (found !== null && found !== undefined) begin(c, found, first, next);";
const patch = `  if (found !== null && found !== undefined) {
    if (next !== null && found.ver === SKIPPED) {
      if (__STATS__) stats.skippedProofs++;
      found.ver = s.ver;
      cursor = found;
      return moveDep(c, found, last, next);
    }
    begin(c, found, first, next);
  }`;

async function bundle(proof) {
  const outfile = path.join(out, proof ? "proof.mjs" : "baseline.mjs");
  const src = path.join(out, "src");
  if (proof) {
    cpSync(path.join(root, "src"), src, { recursive: true });
    const kernel = path.join(src, "kernel.ts");
    const source = readFileSync(kernel, "utf8");
    assert.equal(source.split(anchor).length, 2);
    writeFileSync(kernel, source.replace(anchor, () => patch));
    const stats = path.join(src, "instrumentation.ts");
    writeFileSync(stats, readFileSync(stats, "utf8").replace("  reads: 0,", "  skippedProofs: 0,\n  reads: 0,"));
  }
  await build({
    entryPoints: [path.join(root, "bench/adapters/quant-internals.ts")],
    outfile, bundle: true, minify: true, target: "es2022", platform: "neutral", format: "esm",
    define: { __STATS__: "true", __DEV__: "false" },
    plugins: [{
      name: "skipped-proof",
      setup(plugin) {
        plugin.onLoad({ filter: /quant-internals\.ts$/ }, ({ path: file }) => ({
          contents: readFileSync(file, "utf8") + '\nexport { stats } from "../../src/kernel.ts";\n',
          loader: "ts",
        }));
        if (!proof) return;
        plugin.onResolve({ filter: /[\\/]src[\\/][\w-]+\.ts$/ }, ({ path: file }) => ({
          path: path.join(src, path.basename(file)),
        }));
      },
    }],
  });
  return import(pathToFileURL(outfile));
}

function measure(q, width, swaps) {
  const sources = range(width).map((id) => q.signal(id));
  const tick = q.signal(0);
  const plain = range(width), window = range(2 * swaps).map((k) => 256 + k);
  const nested = [...plain.slice(0, 256), ...window.filter((k) => k & 1),
    ...window.filter((k) => !(k & 1)), ...plain.slice(256 + 2 * swaps)];
  const orders = [plain, nested];
  const c = q.computed(() => {
    let value = 0;
    for (const id of orders[q.get(tick) & 1]) value = (Math.imul(value, 31) + q.get(sources[id])) | 0;
    return value;
  });
  q.get(c);
  const before = { ...q.stats };
  const identities = sources.map((s) => s.firstSub);
  const checks = [];
  for (let i = 1; i <= 8; i++) {
    q.set(tick, i);
    const answer = q.get(c);
    checks.push(answer);
    assert.equal(c.firstDep.from, tick);
    let prev = c.firstDep, edge = prev.nextDep;
    for (const id of orders[i & 1]) {
      assert.equal(edge, identities[id]);
      assert.equal(edge.prevDep, prev);
      assert.equal(edge.ver, sources[id].ver);
      assert.equal(sources[id].slot, null);
      prev = edge;
      edge = edge.nextDep;
    }
    assert.equal(edge, null);
    assert.equal(prev, c.lastDep);
  }
  const counts = Object.fromEntries(["indexed", "sweeps", "lookups", "skippedProofs"].map(
    (name) => [name, ((q.stats[name] ?? 0) - (before[name] ?? 0)) / checks.length],
  ));
  return { checks, counts };
}

const original = await bundle(false);
const candidate = await bundle(true);
const results = [];
const widths = [1024, 4096, 8192].map((width) => [width, 8]);
const edits = [1, 2, 4, 16, 32, 128].map((swaps) => [1024, swaps]);
for (const [width, swaps] of [...widths, ...edits]) {
  const a = measure(original, width, swaps), b = measure(candidate, width, swaps);
  assert.deepEqual(b.checks, a.checks);
  if (swaps === 8) {
    assert.ok(a.counts.indexed > 0);
    assert.equal(b.counts.indexed, 0);
  }
  results.push({ width, swaps, baseline: a.counts, proof: b.counts });
}
writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results));
