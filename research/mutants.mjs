// Mechanism ablation: remove one mechanism of the quant runtime at a time and
// record which tests fail. A mechanism no test needs is a candidate for
// deletion; the failing test is its smallest known counterexample.
//
//   node research/mutants.mjs [id ...]      results -> research/mutants.json
//   node research/mutants.mjs --validation [--mode production]
//        requires each validation mutant to fail its named public witness
//   node research/mutants.mjs --emulate-reflex
//        builds quant with Reflex's failure choices (D3, D4, D5) and prints
//        the directory, for QUANT_SRC=<dir> (test/tools/attribution.test.ts)
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cache = path.join(root, ".cache/mutants");
const K = "kernel.ts";
const T = "kernel.ts";
const H = "host.ts";
const I = "index.ts";

/** id, mechanism removed, then [file, find, replace] edits (each find unique). */
export const mutants = [
  ["direct-dirty-running", "a running direct subscriber is left to versions (no DIRTY)",
    [K, "        n.flags = f | Flag.Stale;\n        if ((f & Flag.Watch) !== 0) wake(n);", "        n.flags = f | Flag.Stale | Flag.Dirty;\n        if ((f & Flag.Watch) !== 0) wake(n);"]],
  ["no-direct-dirty", "O2: direct subscribers marked DIRTY on write (optimization)",
    [K, "      n.flags = f | Flag.Dirty;\n    } else {\n      n.flags = f | Flag.Dirty | Flag.Stale;", "      n.flags = f;\n    } else {\n      n.flags = f | Flag.Stale;"]],
  ["no-woken", "WOKEN: a watcher woken by signals only skips the vacuous validation (optimization)",
    [K, "      n.flags = f | Flag.Dirty | Flag.Woken;\n      wake(n);", "      n.flags = f | Flag.Dirty | Flag.Stale;\n      wake(n);"]],
  ["woken-when-running", "a running watcher gets STALE (versions decide), not WOKEN|DIRTY",
    [K, "    if ((f & Flag.Busy) !== 0) {\n      // Running", "    if ((f & Flag.Busy) !== 0 && (f & Flag.Watch) === 0) {\n      // Running"]],
  ["no-fresh-source", "a source without subscribers is absent before any scan (optimization)",
    [T, "  if (first === null || alien(first, c)) return attach(c, s, last, next);", "  if (first !== null && alien(first, c)) return attach(c, s, last, next);"]],
  ["no-source-absence", "LOG 49: a source whose at most two subscribers are other readers is absent before any scan (optimization)",
    [T, "  if (first === null || alien(first, c)) return attach(c, s, last, next);", "  if (first === null) return attach(c, s, last, next);"]],
  ["no-suffix-scan", "O1: bounded scan of the unread suffix before indexing (optimization)",
    [T, "    while (e !== null && e.from !== s && --budget !== 0) e = e.nextDep;\n    if (e !== null && e.from === s) {", "    while (e !== null && e.from !== s && --budget !== 0) e = e.nextDep;\n    if (false) {"]],
  ["no-defer", "LOG 47: an edge a read skips twice goes to the end of the list (optimization)",
    [T, "  if (next.ver === SKIPPED) return skipDep(c, last, next, e);\n", ""]],
  ["no-skip-marker", "LOG 50: an edge a read skips once stays; only a second skip defers it (optimization)",
    [T, "  if (next.ver === SKIPPED) return skipDep(c, last, next, e);", "  return skipDep(c, last, next, e);"]],
  ["no-tail-scan", "LOG 47: bounded scan of the unread suffix from its end (optimization)",
    [T, "    if (e.from === s) {\n      if (__STATS__) stats.tails++;", "    if (false) {\n      if (__STATS__) stats.tails++;"]],
  ["no-absence-proof", "O1: a completely scanned reader list proves absence before the subscribers are asked (optimization)",
    [T, "  if (e === null && p === null) return attach(c, s, last, next);\n", ""]],
  ["index-always", "LOG 28: a pair found as the source's first subscriber marks the pass instead of indexing it (optimization)",
    [T, "  if (e !== first) return index(c, next);", "  return index(c, next);"]],
  ["no-mark", "LOG 28: a marked pass sets UNREAD on its unread suffix",
    [T, "    if (__STATS__) stats.indexed++;\n    u.ver = UNREAD;", "    if (__STATS__) stats.indexed++;"]],
  ["no-displaced", "save/restore of an enclosing run's slot cells",
    [K, "  const cell = s.slot;\n  if (cell !== null) stack[top++] = cell;\n  s.slot = e;", "  s.slot = e;"]],
  ["no-unread", "UNREAD marking of the suffix while indexing",
    [K, "    if (unread) e.ver = UNREAD;\n", ""]],
  ["validate-tentative", "tentative edges excluded from watcher validation",
    [K, "        (s.flags & (__DEV__ ? Flag.Pull : Flag.Pending)) !== 0 &&\n        e.gen !== tentative", "        (s.flags & (__DEV__ ? Flag.Pull : Flag.Pending)) !== 0"]],
  ["keep-tentative", "removal of earlier failed runs' unread edges",
    [K, "    if (e.gen === tentative) {\n      const before", "    if (false) {\n      const before"]],
  ["cut-on-failure", "committed edges kept after a failure (wake set)",
    [K, "  n.flags |= Flag.Dirty;\n  const tentative", "  n.flags |= Flag.Dirty;\n  cutDeps(n, last);\n  return;\n  const tentative"]],
  ["clear-after", "STALE cleared before the run, so pushes during it survive",
    [K, "n.flags = (n.flags & ~Flag.PendingMarked) | Flag.Busy;", "n.flags = (n.flags & ~(Flag.PendingMarked & ~Flag.Stale)) | Flag.Busy;"],
    [K, "  n.flags = f & ~Flag.Busy;", "  n.flags = f & ~(Flag.Busy | Flag.Stale);"]],
  ["validation-stale", "D8: retaining STALE after interruption blocks the next causal push",
    [K, "flags | Flag.Unverified : flags;", "flags | Flag.Stale : flags;"]],
  ["validation-dirty", "D8: fabricating DIRTY after interruption loses cutoff",
    [K, "flags | Flag.Unverified : flags;", "flags | Flag.Dirty : flags;"]],
  ["validation-clean", "D8: clearing interrupted validation skips the next demand",
    [K, "(flags & Flag.Dirty) === 0 ? flags | Flag.Unverified : flags;", "flags;"]],
  ["no-check-restart", "P4: a fresh STALE mark requires validation before lifecycle",
    [K, "    if ((flags & Flag.Stale) === 0) return flags;\n    w.flags = flags & ~Flag.Stale;", "    return flags;"]],
  ["no-attachment-handoff", "P5: a new observer receives the invalidation that preceded its edge",
    [K, "  if ((s.flags & Flag.Stale) !== 0) mark(e);\n", ""]],
  ["wake-guard", "the kernel wakes a watcher only when it is neither STALE nor WOKEN (re-delivery after a failed validation)",
    [K, "      n.flags = f | Flag.Dirty | Flag.Woken;\n      wake(n);", "      n.flags = f | Flag.Dirty | Flag.Woken;\n      if ((f & (Flag.Stale | Flag.Woken)) === 0) wake(n);"],
    [K, "        n.flags = f | Flag.Stale;\n        wake(n);", "        n.flags = f | Flag.Stale;\n        if ((f & (Flag.Stale | Flag.Woken)) === 0) wake(n);"]],
  ["no-retry", "a watcher whose validation threw stays runnable by a plain run (V1)",
    [H, "      w.flags |= Flag.Stale;\n      throw error;", "      throw error;"]],
  ["idle-after-failure", "a failed watcher keeps its execution obligation (R2)",
    [K, "  n.flags |= Flag.Dirty;\n  const tentative", "  if ((n.flags & Flag.Watch) === 0) n.flags |= Flag.Dirty;\n  const tentative"]],
  ["existential-watcher", "watcher validation covers every committed source (V3)",
    [K, "    let e = w.firstDep;", "    if ((flags & Flag.Dirty) !== 0) return flags;\n    let e = w.firstDep;"],
    [K, "          w.flags |= Flag.Dirty;\n          e = e.nextDep;\n          break;", "          w.flags |= Flag.Dirty;\n          return w.flags;"]],
  ["watcher-detach-keeps-chain", "W3: a disposed watcher's teardown ends the dependency chain, so its validation pulls no further source",
    [K, "  if ((n.flags & Flag.Watch) === 0) cutDeps(n, null);", "  if (true) cutDeps(n, null);"]],
  ["eager-dispose", "disposal deferred to the end of the node's own run",
    [K, "  n.fn = null;\n  if ((n.flags & Flag.Busy) === 0) detach(n);", "  n.fn = null;\n  detach(n);"]],
  ["no-cursor-restore", "T3: nested execution restores the enclosing pass's cursor on success and failure",
    [K, "    cursor = prevCursor;\n    fail(n, base, last);", "    fail(n, base, last);"],
    [K, "  cursor = prevCursor;\n  const f = n.flags;", "  const f = n.flags;"]],
  ["no-cycle-check", "BUSY checked on read (cycle detection)",
    [K, "  if ((n.flags & Flag.Pull) !== 0) pull(n);", "  if ((n.flags & (Flag.Pull & ~Flag.Busy)) !== 0) pull(n);"]],
  ["no-checking-read", "C1 (development diagnostic): CHECKING on read, so a node under validation is a cycle, not its previous value",
    [K, "  if ((n.flags & Flag.Pull) !== 0) pull(n);", "  if ((n.flags & (Flag.Pull & ~Flag.Checking)) !== 0) pull(n);"]],
  ["no-checking-descent", "C1 (development diagnostic): CHECKING on every node a validation descends into, not only on its root",
    [K, "                ? (sf & ~Flag.Validate) | Flag.Checking\n", "                ? sf & ~Flag.Validate\n"]],
  ["checking-kept-when-clean", "C1 (development diagnostic): a node its validation finds clean leaves the walk (its one extra store)",
    [K, "        if (__DEV__) n.flags &= ~Flag.Checking;\n", ""]],
  ["checking-kept-on-run", "C1 (development diagnostic): a node on the walk that runs leaves it as the run starts (folded into exec's store)",
    [K, "n.flags = (n.flags & ~Flag.PendingMarked) | Flag.Busy;", "const pending = __DEV__ && (n.flags & Flag.Watch) === 0 ? Flag.Pending : Flag.PendingMarked;\n  n.flags = (n.flags & ~pending) | Flag.Busy;"]],
  ["checking-kept-on-failure", "C1 (development diagnostic): a failed validation clears CHECKING along its walk",
    [K, "        const flags = n.flags & ~(Flag.Validate | Flag.Checking);", "        const flags = n.flags & ~Flag.Validate;"]],
  ["verify-busy-blind", "C1 (development diagnostic): validation fails on a source on the stack even when no push marked it again",
    [K, "          if ((sf & (__DEV__ ? Flag.Pull : Flag.Pending)) !== 0) {", "          if ((sf & Flag.Pending) !== 0) {"]],
  ["check-busy-blind", "C1 (development diagnostic): watcher validation pulls a source on the stack, so it fails before the cleanup (P4)",
    [K, "        if ((s.flags & (__DEV__ ? Flag.Pull : Flag.Pending)) !== 0)", "        if ((s.flags & Flag.Pending) !== 0)"],
    [K, "        (s.flags & (__DEV__ ? Flag.Pull : Flag.Pending)) !== 0 &&", "        (s.flags & Flag.Pending) !== 0 &&"]],
  ["disposed-run", "W3: a node disposed during its validation is not run when its own source changed",
    [K, "            if (n.fn !== null) exec(n);\n            break settled;", "            exec(n);\n            break settled;"]],
  ["disposed-run-climb", "W3: a node disposed during its validation is not run when the climb reaches it",
    [K, "        if (n.fn !== null) exec(n);\n      }", "        exec(n);\n      }"]],
  ["disposed-left-dirty", "W3: a failed walk leaves a node disposed during it with no pending validation",
    [K, "      if (n.fn !== null) {\n        const flags = n.flags", "      {\n        const flags = n.flags"]],
  ["no-trim", "empty work stacks release oversized capacity after push, validation and indexed runs (retained memory)",
    [K, "  if (stack.length > TRIM && top === 0) {", "  if (false) {"]],
  ["no-trim-mark", "a completed push releases capacity without waiting for a later demand",
    [K, "    if (top === base) {\n      trim();\n      return;\n    }", "    if (top === base) return;"]],
  ["no-trim-validation", "a successful validation releases its temporary capacity",
    [K, "        if (top === base) {\n          trim();\n          return;\n        }", "        if (top === base) return;"]],
  ["no-trim-failed-validation", "a throwing validation releases capacity after unwinding its entries",
    [K, "      stack[top] = null;\n    }\n    trim();\n    throw error;", "      stack[top] = null;\n    }\n    throw error;"]],
  ["no-trim-unindex", "indexed execution releases capacity on normal, throwing and disposed exits, including direct watchers",
    [K, "    cell.from.slot = cell;\n  }\n  trim();", "    cell.from.slot = cell;\n  }"]],
  ["no-settle", "SETTLE: a commit restamps its edges twice a cycle, so a wrapped generation never reads a committed edge as tentative",
    [K, "  if ((n.gen & SETTLE) === 0) settleDeps(n);", ""]],
  ["settle-once-a-cycle", "SETTLE: the restamp comes twice a cycle; once leaves an edge 2^30 - 1 behind just before it",
    [K, "  if ((n.gen & SETTLE) === 0) settleDeps(n);", "  if (n.gen === 0) settleDeps(n);"]],
  ["construction-commits", "W5: an effect() call that throws detaches its watcher",
    [I, "      stop(effectNode);\n    } catch {", "    } catch {"]],
  ["rollback-error-replaces", "F5: a throwing rollback cleanup does not replace the failed run's error",
    [I, "    try {\n      stop(effectNode);\n    } catch {\n      /** F5 */\n    }", "    stop(effectNode);"]],
  ["batch-error-replaces", "F5: a deferred watcher's error at the batch end does not replace the body's",
    [H, "      try {\n        flush();\n      } catch {\n        // F5: a later error does not replace the body's.\n      }", "      flush();"]],
  ["no-queue-shrink", "S8: small drains give back a ring four times larger than they need (LOG 48, LOG 50)",
    [H, "      if ((spare += taken) > mask) shrink(calm);\n", ""]],
  ["queue-shrink-eager", "LOG 50: the ring is given back once small drains have delivered a ring's worth, not at the first",
    [H, "      if ((spare += taken) > mask) shrink(calm);", "      shrink(calm);"]],
  ["repeat-refresh", "P5: a repeated read keeps the first observation's version (immediate, prefix-scan and found repeats)",
    [T, "      else if (__STATS__) stats.repeats++;", "      else last.ver = n.ver;"],
    [T, "  if (p !== null && p.from === s) {\n    if (__STATS__) stats.dups++;\n    return;", "  if (p !== null && p.from === s) {\n    if (__STATS__) stats.dups++;\n    p.ver = s.ver;\n    return;"],
    [T, "  if (e.ver !== UNREAD) {\n    if (__STATS__) stats.dups++;\n    return;", "  if (e.ver !== UNREAD) {\n    if (__STATS__) stats.dups++;\n    e.ver = s.ver;\n    return;"]],
  ["no-repeat-check", "immediate repeat recognised before the scans",
    [T, "      if (last.from !== n) miss(c, n, last, next);\n      else if (__STATS__) stats.repeats++;", "      miss(c, n, last, next);"]],
  ["run-direct", "effects run inside the host's drain loop",
    [I, "  start(effectNode);", "  run(effectNode);"],
    [I, "import { drainNow, hold, size, start, stop, watcher } from \"./host\";", "import { drainNow, hold, size, run, stop, watcher } from \"./host\";"]],
  ["start-outside-drain", "an effect's unqueued first run opens the drain",
    [H, "  hold = 1;\n  try {\n    exec(w);", "  try {\n    exec(w);"]],
  ["prepend-subs", "subscribers kept in birth order (append after the head's prevSub, the last subscriber)",
    [K, "  if (first !== null) {\n    tail!.nextSub = e;\n    first.prevSub = e;\n  } else {",
      "  if (first !== null) {\n    e.nextSub = first;\n    first.prevSub = e;\n    s.firstSub = e;\n  } else {"]],
];

/**
 * Reflex's D5 in full (INVARIANTS В§3: a failed watcher is "otherwise idle"):
 * the obligation and the evidence behind it are both gone. In quant the
 * evidence also lives in edge versions, so emulating idle means marking every
 * observed change consumed, after a cleanup or a callback failure.
 */
const consumeEvidence = "for (let e = w.firstDep; e !== null; e = e.nextDep) e.ver = e.from.ver;";
const reflexIdle = [
  [H, "    untracked(cleanup as Cleanup);\n    if (w.fn === null) return;",
    `    try {\n      untracked(cleanup as Cleanup);\n    } catch (error) {\n      w.flags &= ~Flag.Dirty;\n      ${consumeEvidence}\n      throw error;\n    }\n    if (w.fn === null) return;`],
  [H, "  exec(w);\n}",
    `  try {\n    exec(w);\n  } catch (error) {\n    w.flags &= ~Flag.Dirty;\n    ${consumeEvidence}\n    throw error;\n  }\n}`],
];

function build(id, edits) {
  const dir = path.join(cache, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(root, "src"), dir, { recursive: true });
  for (const [file, find, replace] of edits) {
    const target = path.join(dir, file);
    // Mutants are written against compact source; the real files carry blank
    // lines for reading, so drop them in this throwaway copy.
    const text = readFileSync(target, "utf8").replace(/\r?\n([ \t]*\r?\n)+/g, "\n");
    const at = text.indexOf(find);
    if (at < 0 || text.indexOf(find, at + 1) >= 0) throw new Error(`${id}: edit not found once in ${file}: ${find.slice(0, 60)}`);
    writeFileSync(target, text.slice(0, at) + replace + text.slice(at + find.length));
  }
  return dir;
}

function runSuite(dir, id, { mode, files = [] } = {}) {
  const out = path.join(cache, `${id}.json`);
  rmSync(out, { force: true });
  const env = { ...process.env, QUANT_RUNS: "3000" };
  if (dir === null) delete env.QUANT_SRC;
  else env.QUANT_SRC = dir;
  const result = spawnSync(
    process.execPath,
    [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts",
      "--reporter=json", `--outputFile=${out}`, ...(mode ? ["--mode", mode] : []), ...files],
    { cwd: root, env, encoding: "utf8", timeout: 600_000 },
  );
  try {
    const report = JSON.parse(readFileSync(out, "utf8"));
    const failed = report.testResults.flatMap((file) =>
      file.assertionResults.filter((t) => t.status === "failed").map((t) => `${path.basename(file.name)} > ${t.title}`),
    );
    const suiteErrors = report.testResults
      .filter((f) => f.status === "failed" && f.assertionResults.length === 0)
      .map((f) => `${path.basename(f.name)}: ${f.message.split("\n")[0]}`);
    const error = result.error?.message ?? result.signal ?? (
      result.status === 0 || (result.status === 1 && failed.length > 0)
        ? suiteErrors.join("\n") : `unexpected exit ${result.status}`
    );
    return { failed, total: report.numTotalTests, status: result.status, error };
  } catch {
    return {
      failed: [],
      total: 0,
      status: result.status,
      error: result.error?.message ?? `no Vitest report: ${(result.stderr || result.stdout || "").trim()}`,
    };
  }
}

if (process.argv.includes("--validation")) {
  const modeAt = process.argv.indexOf("--mode");
  const mode = modeAt < 0 ? "development" : process.argv[modeAt + 1];
  if (mode !== "development" && mode !== "production") throw new Error("expected development or production mode");
  mkdirSync(cache, { recursive: true });
  const interrupted = "test/interrupted-validation.test.ts";
  const delivery = "test/validation-delivery.test.ts";
  const retry = "retries an interrupted validation on demand and preserves cutoff (D8)";
  const witnesses = [
    ["watcher-detach-keeps-chain", delivery, "ends a disposed watcher's validation after the current pull (Q1, changed)"],
    ["validation-stale", interrupted, "delivers again through the interrupted path after a causal write (D8)"],
    ["validation-dirty", interrupted, retry],
    ["validation-clean", interrupted, retry],
    ["no-check-restart", delivery, "rechecks a committed source made stale by a later source before cleanup (RQ3, P4)"],
    ["no-attachment-handoff", delivery, "checks a pending source on demand after the first computed subscription (RQ1b)"],
  ];
  const baseline = runSuite(null, `validation-baseline-${mode}`, { mode, files: [interrupted, delivery] });
  if (baseline.status !== 0 || baseline.total === 0 || baseline.failed.length || baseline.error) {
    throw new Error(`validation baseline failed in ${mode}: ${JSON.stringify(baseline)}`);
  }
  const results = [];
  for (const [id, file, test] of witnesses) {
    const [, mechanism, ...edits] = mutants.find((candidate) => candidate[0] === id);
    const cacheId = `${id}-${mode}`;
    const suite = runSuite(build(cacheId, edits), cacheId, { mode, files: [file] });
    const witness = `${path.basename(file)} > ${test}`;
    const killed = suite.status === 1 && !suite.error && suite.failed.includes(witness);
    results.push({ id, mechanism, witness, killed, ...suite });
    console.log(`${killed ? "KILLED" : "FAILED"} ${id} (${mode}) ${suite.error || witness}`);
  }
  writeFileSync(path.join(cache, `validation-${mode}.json`), JSON.stringify({ mode, baseline, results }, null, 2) + "\n");
  if (results.some(({ killed }) => !killed)) process.exitCode = 1;
  process.exit();
}

if (process.argv.includes("--validate-anchors")) {
  for (const [id, , ...edits] of mutants) build(id, edits);
  build("reflex-idle-anchors", reflexIdle);
  console.log(`validated anchors for ${mutants.length} mutants and Reflex idle`);
  process.exit();
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
  const { failed, total, error } = runSuite(dir, id);
  results.push({ id, mechanism, killed: failed.length > 0, failed });
  console.log(`${error ? "ERROR   " : failed.length ? "KILLED  " : "SURVIVED"} ${id.padEnd(20)} ${failed.length}/${total}  ${error || failed.slice(0, 3).join(" | ")}`);
  if (error) process.exitCode = 1;
}
if (!only.size) writeFileSync(path.join(root, "research/mutants.json"), JSON.stringify(results, null, 2) + "\n");
