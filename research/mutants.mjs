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
    [K, "    if ((flags & RUNNING) !== 0) {\n      if ((flags & STALE) === 0) {\n        sub.flags = flags | STALE;",
      "    if ((flags & RUNNING) !== 0) {\n      if ((flags & STALE) === 0) {\n        sub.flags = flags | STALE | DIRTY;"]],
  ["no-direct-dirty", "O2: direct subscribers marked DIRTY on write (optimization)",
    [K, "      sub.flags = flags | DIRTY;\n    } else {\n      sub.flags = flags | DIRTY | STALE;",
      "      sub.flags = flags;\n    } else {\n      sub.flags = flags | STALE;"]],
  ["no-woken", "WOKEN: a watcher woken by signals only skips the vacuous validation (optimization)",
    [K, "      sub.flags = flags | DIRTY | WOKEN;\n      if ((flags & (STALE | WOKEN)) === 0) deliver(sub);",
      "      sub.flags = flags | DIRTY | STALE;\n      if ((flags & STALE) === 0) deliver(sub);"]],
  ["woken-when-running", "a running watcher gets STALE (versions decide), not WOKEN|DIRTY",
    [K, "    if ((flags & RUNNING) !== 0) {\n      if ((flags & STALE) === 0) {",
      "    if ((flags & RUNNING) !== 0 && (flags & WATCH) === 0) {\n      if ((flags & STALE) === 0) {"]],
  ["no-fresh-source", "a source without subscribers is absent before any scan (optimization)",
    [K, "    if (source.subs === null) {\n      // No subscriber at all", "    if (false) {\n      // No subscriber at all"]],
  ["no-suffix-scan", "O1: bounded scan of the unread suffix before indexing (optimization)",
    [K, "if (e !== null && e.from === source) {\n      if (__QUANT_STATS__) stats.skips++;", "if (false) {\n      if (__QUANT_STATS__) stats.skips++;"]],
  ["no-absence-proof", "O1: bounded absence proofs, consumer or source side, before indexing (optimization)",
    [K, "if ((e === null && p === null) || unsubscribed(source, c)) {", "if (false) {"]],
  ["no-displaced", "save/restore of an enclosing pass's slot cells",
    [K, "const source = e.from;\n    if (source.slot !== null) displaced.push(source, source.slot);", "const source = e.from;"],
    [K, "if (indexed) {\n    if (source.slot !== null) displaced.push(source, source.slot);", "if (indexed) {"]],
  ["no-unread", "UNREAD marking of the suffix while indexing",
    [K, "if (unread) e.version = UNREAD;", ""]],
  ["validate-tentative", "tentative relations excluded from watcher validation",
    [K, "!== 0 && e.gen !== tentative) refresh(source);", "!== 0) refresh(source);"]],
  ["keep-tentative", "removal of earlier failed attempts' unread relations",
    [K, "if (e.gen === tentative) {\n      const before", "if (false) {\n      const before"]],
  ["cut-on-failure", "committed relations kept after a failure (wake set)",
    [K, "n.flags |= DIRTY;\n  const tentative", "n.flags |= DIRTY;\n  cut(n, n.cursor);\n  return;\n  const tentative"]],
  ["clear-after", "STALE cleared before the pass, so pushes during it survive",
    [K, "n.flags = (n.flags & ~(STALE | DIRTY)) | RUNNING;", "n.flags = (n.flags & ~DIRTY) | RUNNING;"],
    [K, "n.flags = flags & ~(RUNNING | INDEXED);", "n.flags = flags & ~(RUNNING | INDEXED | STALE);"]],
  ["validation-stale", "a failed validation leaves DIRTY (push passes) rather than STALE",
    [K, "    n.flags |= DIRTY;\n    while (descent.length > base) descent.pop()!.to.flags |= DIRTY;",
      "    n.flags |= STALE;\n    while (descent.length > base) descent.pop()!.to.flags |= STALE;"]],
  ["retry-as-stale", "a watcher whose validation threw is marked RETRY, not left STALE (re-delivery)",
    [H, "    w.flags |= RETRY;", "    w.flags |= STALE;"]],
  ["no-retry", "a watcher whose validation threw stays runnable by a plain run (V1)",
    [H, "    w.flags |= RETRY;", ""]],
  ["idle-after-failure", "a failed watcher keeps its execution obligation (R2)",
    [K, "  n.flags |= DIRTY;\n  const tentative", "  if ((n.flags & WATCH) === 0) n.flags |= DIRTY;\n  const tentative"]],
  ["existential-watcher", "watcher validation covers every committed source (V3)",
    [K, "  let owed = (n.flags & DIRTY) !== 0;\n", "  let owed = (n.flags & DIRTY) !== 0;\n  if (owed) return;\n"],
    [K, "      owed = true;\n      n.flags |= DIRTY;\n", "      n.flags |= DIRTY;\n      return;\n"]],
  ["eager-dispose", "disposal deferred to the end of the node's own pass",
    [K, "  n.fn = null;\n  if ((n.flags & RUNNING) !== 0) return;", "  n.fn = null;"]],
  ["no-cycle-check", "RUNNING checked on read (cycle detection)",
    [K, "if ((n.flags & (STALE | DIRTY | RUNNING)) !== 0) refresh(n);", "if ((n.flags & (STALE | DIRTY)) !== 0) refresh(n);"]],
  ["no-repeat-check", "immediate repeat recognised before the scans",
    [K, "if (cursor !== null && cursor.from === source) {\n    if (__QUANT_STATS__) stats.repeats++;", "if (false) {\n    if (__QUANT_STATS__) stats.repeats++;"]],
  ["run-direct", "effects run inside the host's drain loop",
    [I, "  schedule(w);\n  flush();", "  run(w);"],
    [I, "import { flush, schedule, stop, watcher } from \"./host\";", "import { flush, run, stop, watcher } from \"./host\";"]],
  ["prepend-subs", "subscribers kept in birth order (subsTail append)",
    [K, "prevSub: tail,\n    nextSub: null,", "prevSub: null,\n    nextSub: source.subs,"],
    [K, "if (tail !== null) tail.nextSub = e;\n  else source.subs = e;\n  source.subsTail = e;",
      "if (source.subs !== null) source.subs.prevSub = e;\n  else source.subsTail = e;\n  source.subs = e;"]],
];

/**
 * Reflex's D5 in full (INVARIANTS §3: a failed watcher is "otherwise idle"):
 * the obligation and the evidence behind it are both gone. In quant the
 * evidence also lives in relation versions, so emulating idle means marking
 * every observed change consumed, after a cleanup or a callback failure.
 */
const consumeEvidence = "for (let e = w.deps; e !== null; e = e.nextDep) e.version = e.from.version;";
const reflexIdle = [
  [H, "    untracked(cleanup as Body);\n    if (w.fn === null) return;",
    `    try {\n      untracked(cleanup as Body);\n    } catch (error) {\n      w.flags &= ~DIRTY;\n      ${consumeEvidence}\n      throw error;\n    }\n    if (w.fn === null) return;`],
  [H, "  execute(w);\n}",
    `  try {\n    execute(w);\n  } catch (error) {\n    w.flags &= ~DIRTY;\n    ${consumeEvidence}\n    throw error;\n  }\n}`],
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
