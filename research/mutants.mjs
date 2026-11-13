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
    [T, "  if (first === null) return link(c, s, last, next);\n", ""]],
  ["no-suffix-scan", "O1: bounded scan of the unread suffix before indexing (optimization)",
    [T, "    if (e !== null && e.from === s) {\n      if (__STATS__) stats.scans++;", "    if (false) {\n      if (__STATS__) stats.scans++;"]],
  ["no-defer", "LOG 47: an edge a read skips goes to the end of the list (optimization)",
    [T, "      return skipDep(c, last, next, e);", "      return moveDep(c, e, last, next);"]],
  ["no-tail-scan", "LOG 47: bounded scan of the unread suffix from its end (optimization)",
    [T, "    if (e.from === s) {\n      if (__STATS__) stats.tails++;", "    if (false) {\n      if (__STATS__) stats.tails++;"]],
  ["no-absence-proof", "O1: a completely scanned reader list proves absence before the subscribers are asked (optimization)",
    [T, "  if (e === null && p === null) return link(c, s, last, next);\n", ""]],
  ["index-always", "LOG 28: a pair found as the source's first subscriber marks the pass instead of indexing it (optimization)",
    [T, "  if (e !== first) return index(c, next);", "  return index(c, next);"]],
  ["no-mark", "LOG 28: a marked pass sets UNREAD on its unread suffix",
    [T, "    if (__STATS__) stats.indexed++;\n    u.ver = UNREAD;", "    if (__STATS__) stats.indexed++;"]],
  ["no-displaced", "save/restore of an enclosing run's slot cells",
    [K, "  const cell = s.slot;\n  if (cell !== null) stack[top++] = cell;\n  s.slot = e;", "  s.slot = e;"]],
  ["no-unread", "UNREAD marking of the suffix while indexing",
    [K, "    if (unread) e.ver = UNREAD;\n", ""]],
  ["validate-tentative", "tentative edges excluded from watcher validation",
    [K, "          0 &&\n        e.gen !== tentative\n      )\n        pull(s);", "          0\n      )\n        pull(s);"],
    [K, "        0 &&\n      e.gen !== tentative\n    )\n      pull(s);", "        0\n    )\n      pull(s);"]],
  ["keep-tentative", "removal of earlier failed runs' unread edges",
    [K, "    if (e.gen === tentative) {\n      const before", "    if (false) {\n      const before"]],
  ["cut-on-failure", "committed edges kept after a failure (wake set)",
    [K, "  n.flags |= Flag.Dirty;\n  const tentative", "  n.flags |= Flag.Dirty;\n  cutDeps(n, last);\n  return;\n  const tentative"]],
  ["clear-after", "STALE cleared before the run, so pushes during it survive",
    [K, "        ? Flag.Stale | Flag.Dirty | Flag.Checking\n        : Flag.Stale | Flag.Dirty)) |", "        ? Flag.Dirty | Flag.Checking\n        : Flag.Dirty)) |"],
    [K, "  n.flags = f & ~Flag.Busy;", "  n.flags = f & ~(Flag.Busy | Flag.Stale);"]],
  ["validation-stale", "a failed validation leaves DIRTY (push passes) rather than STALE",
    [K, "        ? (n.flags | Flag.Dirty) & ~Flag.Checking\n        : n.flags | Flag.Dirty;", "        ? (n.flags | Flag.Stale) & ~Flag.Checking\n        : n.flags | Flag.Stale;"],
    [K, "          ? (p.flags | Flag.Dirty) & ~Flag.Checking\n          : p.flags | Flag.Dirty;", "          ? (p.flags | Flag.Stale) & ~Flag.Checking\n          : p.flags | Flag.Stale;"]],
  ["wake-guard", "the kernel wakes a watcher only when it is neither STALE nor WOKEN (re-delivery after a failed validation)",
    [K, "      n.flags = f | Flag.Dirty | Flag.Woken;\n      wake(n);", "      n.flags = f | Flag.Dirty | Flag.Woken;\n      if ((f & (Flag.Stale | Flag.Woken)) === 0) wake(n);"],
    [K, "        n.flags = f | Flag.Stale;\n        wake(n);", "        n.flags = f | Flag.Stale;\n        if ((f & (Flag.Stale | Flag.Woken)) === 0) wake(n);"]],
  ["no-retry", "a watcher whose validation threw stays runnable by a plain run (V1)",
    [H, "      w.flags |= Flag.Stale;\n      throw error;", "      throw error;"]],
  ["idle-after-failure", "a failed watcher keeps its execution obligation (R2)",
    [K, "  n.flags |= Flag.Dirty;\n  const tentative", "  if ((n.flags & Flag.Watch) === 0) n.flags |= Flag.Dirty;\n  const tentative"]],
  ["existential-watcher", "watcher validation covers every committed source (V3)",
    [K, "  if ((w.flags & Flag.Dirty) === 0) {", "  if ((w.flags & Flag.Dirty) !== 0) return;\n  if ((w.flags & Flag.Dirty) === 0) {"],
    [K, "        w.flags |= Flag.Dirty;\n        e = e.nextDep;\n        break;", "        w.flags |= Flag.Dirty;\n        return;"]],
  ["eager-dispose", "disposal deferred to the end of the node's own run",
    [K, "  n.fn = null;\n  if ((n.flags & Flag.Busy) === 0) detach(n);", "  n.fn = null;\n  detach(n);"]],
  ["no-cursor-restore", "T3: nested execution restores the enclosing pass's cursor on success and failure",
    [K, "    cursor = prevCursor;\n    fail(n, base, last);", "    fail(n, base, last);"],
    [K, "  cursor = prevCursor;\n  const f = n.flags;", "  const f = n.flags;"]],
  ["no-cycle-check", "BUSY checked on read (cycle detection)",
    [K, "  if ((n.flags & (Flag.Stale | Flag.Dirty | Flag.Busy | Flag.Checking)) !== 0)\n    pull(n);", "  if ((n.flags & (Flag.Stale | Flag.Dirty | Flag.Checking)) !== 0)\n    pull(n);"]],
  ["no-checking-read", "C1 (development diagnostic): CHECKING on read, so a node under validation is a cycle, not its previous value",
    [K, "  if ((n.flags & (Flag.Stale | Flag.Dirty | Flag.Busy | Flag.Checking)) !== 0)\n    pull(n);", "  if ((n.flags & (Flag.Stale | Flag.Dirty | Flag.Busy)) !== 0)\n    pull(n);"]],
  ["no-checking-descent", "C1 (development diagnostic): CHECKING on every node a validation descends into, not only on its root",
    [K, "                ? (sf & ~Flag.Stale) | Flag.Checking\n", "                ? sf & ~Flag.Stale\n"]],
  ["checking-kept-when-clean", "C1 (development diagnostic): a node its validation finds clean leaves the walk (its one extra store)",
    [K, "        if (__DEV__) n.flags &= ~Flag.Checking;\n", ""]],
  ["checking-kept-on-run", "C1 (development diagnostic): a node on the walk that runs leaves it as the run starts (folded into exec's store)",
    [K, "        ? Flag.Stale | Flag.Dirty | Flag.Checking\n        : Flag.Stale | Flag.Dirty)) |", "        ? Flag.Stale | Flag.Dirty\n        : Flag.Stale | Flag.Dirty)) |"]],
  ["checking-kept-on-failure", "C1 (development diagnostic): a failed validation clears CHECKING along its walk",
    [K, "        ? (n.flags | Flag.Dirty) & ~Flag.Checking\n", "        ? n.flags | Flag.Dirty\n"],
    [K, "          ? (p.flags | Flag.Dirty) & ~Flag.Checking\n", "          ? p.flags | Flag.Dirty\n"]],
  ["verify-busy-blind", "C1 (development diagnostic): validation fails on a source on the stack even when no push marked it again",
    [K, "                ? Flag.Stale | Flag.Dirty | Flag.Busy | Flag.Checking\n                : Flag.Stale | Flag.Dirty)) !==", "                ? Flag.Stale | Flag.Dirty\n                : Flag.Stale | Flag.Dirty)) !=="]],
  ["check-busy-blind", "C1 (development diagnostic): watcher validation pulls a source on the stack, so it fails before the cleanup (P4)",
    [K, "            ? Flag.Stale | Flag.Dirty | Flag.Busy | Flag.Checking\n            : Flag.Stale | Flag.Dirty)) !==", "            ? Flag.Stale | Flag.Dirty\n            : Flag.Stale | Flag.Dirty)) !=="],
    [K, "          ? Flag.Stale | Flag.Dirty | Flag.Busy | Flag.Checking\n          : Flag.Stale | Flag.Dirty)) !==", "          ? Flag.Stale | Flag.Dirty\n          : Flag.Stale | Flag.Dirty)) !=="]],
  ["disposed-run", "W3: a node disposed during its validation is not run when its own source changed",
    [K, "            if (n.fn !== null) exec(n);\n            break settled;", "            exec(n);\n            break settled;"]],
  ["disposed-run-climb", "W3: a node disposed during its validation is not run when the climb reaches it",
    [K, "        if (n.fn !== null) exec(n);\n      }", "        exec(n);\n      }"]],
  ["disposed-left-dirty", "W3: a failed walk does not leave a node disposed during it owing a run",
    [K, "    if (n.fn !== null)\n      n.flags = __DEV__", "    n.flags = __DEV__"]],
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
    [I, "    try {\n      stop(effectNode);\n    } catch {\n      // F5\n    }", "    stop(effectNode);"]],
  ["batch-error-replaces", "F5: a deferred watcher's error at the batch end does not replace the body's",
    [H, "      try {\n        flush();\n      } catch {\n        // F5: a later error does not replace the body's.\n      }", "      flush();"]],
  ["no-queue-compact", "S8: the drain moves the live tail to the front once spent slots dominate",
    [H, "    if (i >= TRIM && i + i >= size) {", "    if (false) {"]],
  ["no-queue-trim", "S8: the queue at rest is cut back to KEEP",
    [H, "  if (queue.length > TRIM) queue.length = KEEP;\n", ""]],
  ["repeat-refresh", "P5: a repeated read keeps the first observation's version (immediate, prefix-scan and found repeats)",
    [T, "      if (__STATS__) stats.repeats++;\n      return;", "      if (__STATS__) stats.repeats++;\n      last.ver = s.ver;\n      return;"],
    [T, "  if (p !== null && p.from === s) {\n    if (__STATS__) stats.dups++;\n    return;", "  if (p !== null && p.from === s) {\n    if (__STATS__) stats.dups++;\n    p.ver = s.ver;\n    return;"],
    [T, "  if (e.ver !== UNREAD) {\n    if (__STATS__) stats.dups++;\n    return;", "  if (e.ver !== UNREAD) {\n    if (__STATS__) stats.dups++;\n    e.ver = s.ver;\n    return;"]],
  ["no-repeat-check", "immediate repeat recognised before the scans",
    [T, "    if (from === s) {\n      if (__STATS__) stats.repeats++;", "    if (false) {\n      if (__STATS__) stats.repeats++;"]],
  ["run-direct", "effects run inside the host's drain loop",
    [I, "  start(effectNode);", "  run(effectNode);"],
    [I, "import { depth, drainNow, draining, size, start, stop, watcher } from \"./host\";", "import { depth, drainNow, draining, size, run, stop, watcher } from \"./host\";"]],
  ["start-outside-drain", "an effect's unqueued first run opens the drain",
    [H, "  draining = true;\n  try {\n    exec(w);", "  try {\n    exec(w);"]],
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

function runSuite(dir, id) {
  const out = path.join(cache, `${id}.json`);
  const result = spawnSync(
    process.execPath,
    [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", "--reporter=json", `--outputFile=${out}`],
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
  const { failed, total } = runSuite(dir, id);
  results.push({ id, mechanism, killed: failed.length > 0, failed });
  console.log(`${failed.length ? "KILLED  " : "SURVIVED"} ${id.padEnd(20)} ${failed.length}/${total}  ${failed.slice(0, 3).join(" | ")}`);
}
if (!only.size) writeFileSync(path.join(root, "research/mutants.json"), JSON.stringify(results, null, 2) + "\n");
