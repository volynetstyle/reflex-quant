// Isolated kernel variants. The package source and the stable read path stay
// outside the experiment. The original vector is a separate comparison cell.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const ordinary = path.join(root, "src");
const transactionSource = readFileSync(path.join(import.meta.dirname, "reorder-index-transaction.ts"), "utf8");
const variants = process.argv.slice(2);
if (variants.length === 0) variants.push("tail", "skipped", "tail-skipped");

function functionSource(source, start) {
  const at = source.indexOf(start);
  const end = source.indexOf("\n}", at);
  assert.ok(at >= 0 && end >= 0, start);
  return source.slice(at, end + 2);
}

for (const variant of variants) {
  // Code-shape ablations: tx-no-<group> drops one transaction edit group,
  // tx-only-<group> keeps only that one (on top of tail-window).
  const groups = ["miss", "index", "unindex", "link", "dispose"];
  const ablation = /^tx-(no|only)-(\w+)$/.exec(variant);
  assert.ok(["tail", "skipped", "tail-skipped", "tail-vector", "tail-window", "transaction", "resident"].includes(variant) ||
    (ablation !== null && groups.includes(ablation[2])), variant);
  const keep = (group) => ablation === null || (ablation[1] === "no" ? ablation[2] !== group : ablation[2] === group);
  const tail = variant !== "skipped";
  const resident = variant === "resident";
  const transaction = variant === "transaction" || resident || ablation !== null;
  const window = variant === "tail-window" || transaction;
  const skipped = variant === "skipped" || variant === "tail-skipped";
  const source = variant === "tail-vector"
    ? path.join(root, ".cache/reorder-learning/indexed-only/src") : ordinary;
  const out = path.join(root, ".cache/reorder-exact", variant);
  const src = path.join(out, "src");
  mkdirSync(out, { recursive: true });
  cpSync(source, src, { recursive: true });
  const kernelFile = path.join(src, "kernel.ts");
  const base = readFileSync(kernelFile, "utf8").replaceAll("\r\n", "\n");
  let kernel = base;
  function edit(anchor, change) {
    assert.equal(kernel.split(anchor).length, 2, "missing or ambiguous anchor: " + anchor);
    kernel = kernel.replace(anchor, () => change);
  }

  if (tail) {
    edit(`  let budget = SCAN;

  for (let e = first; e !== null; e = e.nextSub) {
`, `  if (first === null || first.to === c) return first;
  const tail = first.prevSub!;
  if (tail.to === c) {
    if (__STATS__) stats.sourceTails++;
    return tail;
  }
  let budget = SCAN - 1;

  for (let e = first.nextSub; e !== null; e = e.nextSub) {
`);
    // A found edge is still on its subscriber list. The forward tail ends
    // in null even though first.prevSub points back to that tail.
    edit("  if (e !== first) return index(c, next);", window
      ? "  if (e !== first && e.nextSub !== null && e.nextSub.nextSub !== null) return index(c, next);"
      : "  if (e !== first && e.nextSub !== null) return index(c, next);");
    if (window) edit("  let budget = SCAN - 1;", `  if (tail !== first) {
    const previous = tail.prevSub!;
    if (previous.to === c) {
      if (__STATS__) stats.sourceWindows++;
      return previous;
    }
  }
  let budget = SCAN - 1;`);
  }
  if (skipped) {
    edit("  if (found !== null && found !== undefined) begin(c, found, first, next);", `  if (found !== null && found !== undefined) {
    if (next !== null && found.ver === SKIPPED) {
      if (__STATS__) stats.skippedProofs++;
      found.ver = s.ver;
      cursor = found;
      return moveDep(c, found, last, next);
    }
    begin(c, found, first, next);
  }`);
  }
  if (transaction) {
    const before = "if (last !== null && last.from.slot === last) unindex(n, base);";
    if (keep("unindex")) {
      assert.equal(kernel.split(before).length, 3);
      kernel = kernel.replace(before, "if (last !== null && last.from.slot === last) unindex(n, base, last, true);");
      edit(before, "if (last !== null && last.from.slot === last) unindex(n, base, last, false);");
    }
    if (keep("index")) edit("  let unread = false;", `  const state = active === c && next !== null ? startObservation(c) : null;
  const pending = (c.gen + 1) & CounterLimit.Mask;
  let unread = false;`);
    if (keep("index")) edit("    if (unread) e.ver = UNREAD;\n\n    claim(e.from, e);",
      "    if (unread) e.ver = UNREAD;\n    if (state !== null) observeIndexEdge(state, e, unread, pending);\n\n    claim(e.from, e);");
    if (keep("unindex")) edit(`function unindex(n: Node, base: number): void {
  for (let e = n.firstDep; e !== null; e = e.nextDep) e.from.slot = null;

  while (top > base) {`, `function unindex(n: Node, base: number, last: Edge | null, ok: boolean): void {
  const state = observing;
  if (state?.consumer === n) {
    let width = 0;
    for (let e = n.firstDep; e !== null; e = e.nextDep) {
      e.from.slot = null;
      width++;
    }
    restoreDisplacedSlots(base);
    endObservation(state, last, width, ok);
    return;
  }
  for (let e = n.firstDep; e !== null; e = e.nextDep) e.from.slot = null;
  restoreDisplacedSlots(base);
}

function restoreDisplacedSlots(base: number): void {
  while (top > base) {`);
    if (keep("miss")) edit("  const first = s.firstSub;\n\n  // Absent", `  if (last === null && captured?.consumer === c) return slot(c, s, null, next);
  const first = s.firstSub;

  // Absent`);
    if (keep("link")) edit("  link(c, s, last, next);\n  claim(s, cursor as Edge);",
      "  if (captured?.consumer === c) captured.born = true;\n  link(c, s, last, next);\n  claim(s, cursor as Edge);");
    if (keep("dispose")) edit("  n.fn = null;\n\n  if ((n.flags & Flag.Busy)", "  releaseIdleCapture(n);\n  n.fn = null;\n\n  if ((n.flags & Flag.Busy)");
    if (resident) {
      edit("  if (cell !== null) stack[top++] = cell;", "  if (cell !== null && !evictIdleResident(cell.to)) stack[top++] = cell;");
      edit("  const state = observing;", `  const owner = resident?.deref();
  if (ok && owner?.consumer === n && owner !== captured) {
    trim();
    return;
  }
  const state = observing;`);
    }
    kernel += "\n" + (resident ? transactionSource.replace("const useResidency = false;", "const useResidency = true;") : transactionSource);
  }
  assert.equal(functionSource(kernel, "export function read("), functionSource(base, "export function read("));
  const exec = functionSource(kernel, "export function exec(");
  assert.equal(transaction ? exec.replace("unindex(n, base, last, true)", "unindex(n, base)") : exec,
    functionSource(base, "export function exec("));
  writeFileSync(kernelFile, kernel);

  const stats = path.join(src, "instrumentation.ts");
  const schema = readFileSync(stats, "utf8");
  assert.ok(schema.includes("  reads: 0,"));
  const counters = ["sourceTails", "sourceWindows", "skippedProofs", "observedIndexes", "observedWidth",
    "observedUnread", "qualifyingIndexes", "captureVisits", "capturedEdges", "capturedRuns", "capturedRetires",
    "residentReuses", "residentFills", "residentClears", "residentEvictions"];
  writeFileSync(stats, schema.replace("  reads: 0,", counters.map((key) => `  ${key}: 0,\n`).join("") + "  reads: 0,"));
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
        name: "exact-witness-source",
        setup(plugin) {
          plugin.onResolve({ filter: /[\\/]src[\\/][\w-]+\.ts$/ }, ({ path: file }) => ({
            path: path.join(src, path.basename(file)),
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
