// Mechanism ablation: remove one mechanism of the quant runtime at a time and
// record which tests fail. A mechanism no test needs is a candidate for
// deletion; the failing test is its smallest known counterexample.
//
//   node research/mutants.mjs [id ...]      results -> research/mutants.json
//   node research/mutants.mjs --emulate-reflex
//        builds quant with Reflex's failure choices (D3, D4, D5) and prints
//        the directory, for QUANT_SRC=<dir> (test/tools/attribution.test.ts)
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cache = path.join(root, ".cache/mutants");
const K = "kernel.ts";
const H = "host.ts";
const I = "index.ts";

/** id, mechanism removed, then [file, find, replace] edits (each find unique). */
export const mutants = [
  ["direct-dirty-running", "a running direct subscriber is left to versions (no DIRTY)",
    [K, "        n.flags = f | STALE;\n        if ((f & WATCH) !== 0) wake(n);", "        n.flags = f | STALE | DIRTY;\n        if ((f & WATCH) !== 0) wake(n);"]],
  ["no-direct-dirty", "O2: direct subscribers marked DIRTY on write (optimization)",
    [K, "      n.flags = f | DIRTY;\n    } else {\n      n.flags = f | DIRTY | STALE;", "      n.flags = f;\n    } else {\n      n.flags = f | STALE;"]],
  ["no-woken", "WOKEN: a watcher woken by signals only skips the vacuous validation (optimization)",
    [K, "      n.flags = f | DIRTY | WOKEN;\n      if ((f & (STALE | WOKEN)) === 0) wake(n);", "      n.flags = f | DIRTY | STALE;\n      if ((f & STALE) === 0) wake(n);"]],
  ["woken-when-running", "a running watcher gets STALE (versions decide), not WOKEN|DIRTY",
    [K, "    if ((f & BUSY) !== 0) {\n      // Running", "    if ((f & BUSY) !== 0 && (f & WATCH) === 0) {\n      // Running"]],
  ["no-fresh-source", "a source without subscribers is absent before any scan (optimization)",
    [K, "    if (s.subs === null) return link(c, s, last, next, false);\n", ""]],
  ["no-suffix-scan", "O1: bounded scan of the unread suffix before indexing (optimization)",
    [K, "    if (e !== null && e.from === s) {\n      if (__STATS__) stats.scans++;", "    if (false) {\n      if (__STATS__) stats.scans++;"]],
  ["no-absence-proof", "O1: bounded absence proofs, consumer or source side, before indexing (optimization)",
    [K, "    if ((e === null && p === null) || absent(s, c) === true) return link(c, s, last, next, false);\n", ""]],
  ["no-displaced", "save/restore of an enclosing run's slot cells",
    [K, "    const s = e.from;\n    if (s.slot !== null) {\n      stack[top++] = s;\n      stack[top++] = s.slot;\n    }\n    s.slot = e;", "    const s = e.from;\n    s.slot = e;"],
    [K, "  if (indexed) {\n    if (s.slot !== null) {\n      stack[top++] = s;\n      stack[top++] = s.slot;\n    }\n    s.slot = e;", "  if (indexed) {\n    s.slot = e;"]],
  ["no-unread", "UNREAD marking of the suffix while indexing",
    [K, "    if (unread) e.ver = UNREAD;\n", ""]],
  ["validate-tentative", "tentative edges excluded from watcher validation",
    [K, "!== 0 && e.gen !== tentative) pull(s);", "!== 0) pull(s);"]],
  ["keep-tentative", "removal of earlier failed runs' unread edges",
    [K, "    if (e.gen === tentative) {\n      const before", "    if (false) {\n      const before"]],
  ["cut-on-failure", "committed edges kept after a failure (wake set)",
    [K, "  n.flags |= DIRTY;\n  const tentative", "  n.flags |= DIRTY;\n  cut(n, n.last);\n  return;\n  const tentative"]],
  ["clear-after", "STALE cleared before the run, so pushes during it survive",
    [K, "  n.flags = (n.flags & ~(STALE | DIRTY)) | BUSY;", "  n.flags = (n.flags & ~DIRTY) | BUSY;"],
    [K, "  n.flags = f & ~(BUSY | INDEX);", "  n.flags = f & ~(BUSY | INDEX | STALE);"]],
  ["validation-stale", "a failed validation leaves DIRTY (push passes) rather than STALE",
    [K, "    n.flags |= DIRTY;\n    while (top > base) {\n      (stack[--top] as Edge).to.flags |= DIRTY;",
      "    n.flags |= STALE;\n    while (top > base) {\n      (stack[--top] as Edge).to.flags |= STALE;"]],
  ["retry-as-stale", "a watcher whose validation threw is marked RETRY, not left STALE (re-delivery)",
    [H, "      w.flags |= RETRY;", "      w.flags |= STALE;"]],
  ["no-retry", "a watcher whose validation threw stays runnable by a plain run (V1)",
    [H, "      w.flags |= RETRY;\n", ""]],
  ["idle-after-failure", "a failed watcher keeps its execution obligation (R2)",
    [K, "  n.flags |= DIRTY;\n  const tentative", "  if ((n.flags & WATCH) === 0) n.flags |= DIRTY;\n  const tentative"]],
  ["existential-watcher", "watcher validation covers every committed source (V3)",
    [K, "  let owed = (w.flags & DIRTY) !== 0;\n", "  let owed = (w.flags & DIRTY) !== 0;\n  if (owed) return;\n"],
    [K, "      owed = true;\n      w.flags |= DIRTY;\n", "      w.flags |= DIRTY;\n      return;\n"]],
  ["eager-dispose", "disposal deferred to the end of the node's own run",
    [K, "  n.fn = null;\n  if ((n.flags & BUSY) === 0) detach(n);", "  n.fn = null;\n  detach(n);"]],
  ["no-cycle-check", "BUSY checked on read (cycle detection)",
    [K, "  if ((n.flags & (STALE | DIRTY | BUSY)) !== 0) pull(n);", "  if ((n.flags & (STALE | DIRTY)) !== 0) pull(n);"]],
  ["no-repeat-check", "immediate repeat recognised before the scans",
    [K, "  if (last !== null && last.from === s) {\n    if (__STATS__) stats.repeats++;", "  if (false) {\n    if (__STATS__) stats.repeats++;"]],
  ["run-direct", "effects run inside the host's drain loop",
    [I, "  wake(w);\n  flush();", "  run(w);"],
    [I, "import { flush, stop, wake, watcher } from \"./host\";", "import { flush, run, stop, watcher } from \"./host\";"]],
  ["prepend-subs", "subscribers kept in birth order (lastSub append)",
    [K, "prevSub: tail, nextSub: null };", "prevSub: null, nextSub: s.subs };"],
    [K, "  if (tail !== null) tail.nextSub = e;\n  else s.subs = e;\n  s.lastSub = e;",
      "  if (s.subs !== null) s.subs.prevSub = e;\n  else s.lastSub = e;\n  s.subs = e;"]],
];

/**
 * Reflex's D5 in full (INVARIANTS §3: a failed watcher is "otherwise idle"):
 * the obligation and the evidence behind it are both gone. In quant the
 * evidence also lives in edge versions, so emulating idle means marking every
 * observed change consumed, after a cleanup or a callback failure.
 */
const consumeEvidence = "for (let e = w.deps; e !== null; e = e.next) e.ver = e.from.ver;";
const reflexIdle = [
  [H, "    untracked(cleanup as Fn);\n    if (w.fn === null) return;",
    `    try {\n      untracked(cleanup as Fn);\n    } catch (error) {\n      w.flags &= ~DIRTY;\n      ${consumeEvidence}\n      throw error;\n    }\n    if (w.fn === null) return;`],
  [H, "  exec(w);\n}",
    `  try {\n    exec(w);\n  } catch (error) {\n    w.flags &= ~DIRTY;\n    ${consumeEvidence}\n    throw error;\n  }\n}`],
];

function build(id, edits) {
  const dir = path.join(cache, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(root, "src"), dir, { recursive: true });
  for (const [file, find, replace] of edits) {
    const target = path.join(dir, file);
    const text = readFileSync(target, "utf8");
    const at = text.indexOf(find);
    if (at < 0 || text.indexOf(find, at + 1) >= 0) throw new Error(`${id}: edit not found once in ${file}: ${find.slice(0, 60)}`);
    writeFileSync(target, text.slice(0, at) + replace + text.slice(at + find.length));
  }
  return dir;
}

function runSuite(dir, id) {
  const out = path.join(cache, `${id}.json`);
  const result = spawnSync(
    process.execPath,
    [path.join(root, "../../node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", "--reporter=json", `--outputFile=${out}`],
    { cwd: root, env: { ...process.env, QUANT_SRC: dir, QUANT_RUNS: "3000" }, encoding: "utf8", timeout: 600_000 },
  );
  try {
    const report = JSON.parse(readFileSync(out, "utf8"));
    const failed = report.testResults.flatMap((file) =>
      file.assertionResults.filter((t) => t.status === "failed").map((t) => `${path.basename(file.name)} > ${t.title}`),
    );
    const suiteErrors = report.testResults
      .filter((f) => f.status === "failed" && f.assertionResults.length === 0)
      .map((f) => `${path.basename(f.name)}: ${f.message.split("\n")[0]}`);
    return { failed: [...failed, ...suiteErrors], total: report.numTotalTests };
  } catch {
    return { failed: [`suite crashed: ${(result.stderr || result.stdout).split("\n").slice(0, 3).join(" ")}`], total: 0 };
  }
}

if (process.argv.includes("--emulate-reflex")) {
  const pick = (id) => mutants.find((m) => m[0] === id).slice(2);
  const edits = ["validate-tentative", "keep-tentative"].flatMap(pick);
  console.log(build("emulate-reflex", [...edits, ...reflexIdle]));
  process.exit();
}

const only = new Set(process.argv.slice(2));
const results = [];
for (const [id, mechanism, ...edits] of mutants) {
  if (only.size && !only.has(id)) continue;
  const dir = build(id, edits);
  const { failed, total } = runSuite(dir, id);
  results.push({ id, mechanism, killed: failed.length > 0, failed });
  console.log(`${failed.length ? "KILLED  " : "SURVIVED"} ${id.padEnd(20)} ${failed.length}/${total}  ${failed.slice(0, 3).join(" | ")}`);
}
if (!only.size) writeFileSync(path.join(root, "research/mutants.json"), JSON.stringify(results, null, 2) + "\n");
