// Source mutants, separate from adapter fault fixtures. No original source edits.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const vitest = path.join(
  path.dirname(require.resolve("vitest/package.json")),
  "vitest.mjs",
);
const cases = [
  [
    "pre-run-woken",
    "kernel.ts",
    "n.flags = (n.flags & ~Flag.PendingMarked) | Flag.Busy;",
    "n.flags = (n.flags & ~(__DEV__ ? Flag.PendingMarked : Flag.Pending)) | Flag.Busy;",
    "test/history-reentrant.test.ts",
    "cleanup-write-before",
  ],
  [
    "preserve-consumed-cleanup",
    "host.ts",
    "    w.value = undefined;",
    "    /* mutant: cleanup retained */",
    "test/history-reentrant.test.ts",
    "cleanup-failure-consumed",
  ],
  [
    "retain-queued",
    "host.ts",
    "queuedWatcher.flags & ~Flag.Queued",
    "queuedWatcher.flags",
    "test/history-reentrant.test.ts",
    "W2-self-write",
  ],
  [
    "never-shrink-ring",
    "host.ts",
    "if ((spare += taken) > mask) shrink(calm);",
    "if (false) shrink(calm);",
    "test/history-reentrant.test.ts",
    "returns the ring",
  ],
  [
    "skip-settle",
    "kernel.ts",
    "if ((n.gen & SETTLE) === 0) settleDeps(n);",
    "if (false) settleDeps(n);",
    "test/history-counter-wrap.test.ts",
    "exhausts 120",
  ],
  [
    "stale-stack-slots",
    "kernel.ts",
    "stack[top] = null;",
    "/* mutant: popped slot retained */",
    "test/history-temporal-witnesses.test.ts",
    "branching propagation",
    true,
  ],
  [
    "retired-next-sub",
    "graph.ts",
    "  e.nextSub = null;",
    "  /* mutant: next subscriber retained */",
    "test/history-temporal-witnesses.test.ts",
    "retired early",
  ],
  [
    "retired-prev-dep",
    "graph.ts",
    "  e.prevDep = null;",
    "  /* mutant: retained prefix */",
    "test/history-temporal-witnesses.test.ts",
    "cut suffix",
  ],
  [
    "keep-dirty-on-success",
    "kernel.ts",
    "n.flags = (n.flags & ~Flag.PendingMarked) | Flag.Busy;",
    "n.flags = (n.flags & ~Flag.Stale) | Flag.Busy;",
    "test/history-reentrant.test.ts",
    "P5-first",
  ],
  [
    "refresh-reread",
    "kernel.ts",
    "else if (__STATS__) stats.repeats++;",
    "else { last.ver = n.ver; if (__STATS__) stats.repeats++; }",
    "test/history-reentrant.test.ts",
    "P5-first",
  ],
  [
    "lose-failed-debt",
    "kernel.ts",
    "  n.flags |= Flag.Dirty;\n  const tentative",
    "  if ((n.flags & Flag.Watch) === 0) n.flags |= Flag.Dirty;\n  const tentative",
    "test/history-temporal-witnesses.test.ts",
    "failed execution debt",
  ],
  [
    "replace-first-error",
    "host.ts",
    "if (!failed) first = error;",
    "first = error;",
    "test/history-reentrant.test.ts",
    "F5-drain",
  ],
];
const out = path.join(root, ".cache", "temporal-mutants", String(Date.now()));
mkdirSync(out, { recursive: true });
function run(directory, test, pattern, label) {
  const resultFile = path.join(out, label + ".json");
  const env = { ...process.env };
  if (directory) env.QUANT_SRC = directory;
  else delete env.QUANT_SRC;
  const child = spawnSync(
    process.execPath,
    [
      vitest,
      "run",
      "--config",
      "vitest.config.ts",
      "--mode",
      "production",
      test,
      "-t",
      pattern,
      "--reporter=json",
      "--outputFile",
      resultFile,
    ],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  let report;
  try {
    report = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch {
    /* invalid/timeout retained below */
  }
  const failedAssertions =
    report?.testResults
      ?.flatMap((suite) => suite.assertionResults ?? [])
      .filter((test) => test.status === "failed") ?? [];
  return {
    exit: child.status,
    timeout: child.error?.code === "ETIMEDOUT",
    total: report?.numTotalTests ?? 0,
    passed: report?.numPassedTests ?? 0,
    failed: failedAssertions.length,
    evidence: failedAssertions.map((test) => {
      const message = test.failureMessages?.[0];
      const at = message?.match(/"at":(\d+)/);
      return {
        name: test.fullName,
        // First differing top-level operation on this fixed linear witness.
        // This is not a globally minimized continuation depth.
        firstDivergenceStep: at ? Number(at[1]) + 1 : null,
        message: message?.slice(0, 2500),
      };
    }),
    toolError:
      child.error?.message ??
      (!report ? (child.stderr || child.stdout).slice(-2000) : undefined),
  };
}
const results = [];
for (const [id, file, needle, replacement, test, pattern, all] of cases) {
  const baseline = run(undefined, test, pattern, id + "-baseline");
  if (baseline.exit !== 0 || baseline.failed || !baseline.passed)
    throw new Error(`invalid baseline ${id}: ${JSON.stringify(baseline)}`);
  const source = readFileSync(path.join(root, "src", file), "utf8");
  const occurrences = source.split(needle).length - 1;
  if (!occurrences || (!all && occurrences !== 1)) {
    results.push({
      id,
      status: "invalid",
      reason: `anchor occurrences ${occurrences}`,
    });
    continue;
  }
  const directory = path.join(out, id);
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(path.join(root, "src")))
    writeFileSync(
      path.join(directory, name),
      readFileSync(path.join(root, "src", name)),
    );
  writeFileSync(
    path.join(directory, file),
    all
      ? source.replaceAll(needle, replacement)
      : source.replace(needle, replacement),
  );
  const result = run(directory, test, pattern, id);
  const status = result.timeout
    ? "timeout"
    : result.failed > 0
      ? "killed"
      : result.exit === 0
        ? "survived"
        : "invalid";
  results.push({ id, file, test, pattern, status, result });
  process.stdout.write(`${id}: ${status}\n`);
}
const summary = Object.fromEntries(
  ["killed", "survived", "invalid", "timeout"].map((status) => [
    status,
    results.filter((result) => result.status === status).length,
  ]),
);
const report = {
  domain:
    "12 source-level temporal mutants; production; named finite witnesses",
  node: process.version,
  v8: process.versions.v8,
  summary,
  score: summary.killed / cases.length,
  denominator: cases.length,
  sourceSha256: createHash("sha256")
    .update(
      readdirSync(path.join(root, "src"))
        .sort()
        .map((file) => readFileSync(path.join(root, "src", file), "utf8"))
        .join("\n"),
    )
    .digest("hex"),
  catalog: cases.map(([id, file, needle, replacement]) => ({
    id,
    file,
    needle,
    replacement,
  })),
  results,
  artifacts: path.relative(root, out),
};
writeFileSync(
  path.join(root, "research", "TEMPORAL-MUTANTS.json"),
  JSON.stringify(report, null, 2) + "\n",
);
process.stdout.write(JSON.stringify(summary) + "\n");
process.exitCode =
  summary.survived || summary.invalid || summary.timeout ? 1 : 0;
