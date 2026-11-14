// Compare the current runtime with an isolated copy without try/catch/finally.
// This deliberately breaks error recovery; it is not a replacement runtime.
//
//   node research/try-ablation.mjs --prepare-only
//   node research/try-ablation.mjs --rounds 5 [--suite scenarios|mechanisms|all] [--only <regex>]
//
// The copies, bundles, and results are written to .cache/try-ablation. Each
// measurement uses the existing worker, in a fresh process, with the two
// versions shuffled together. These local timings are exploratory, not CI
// performance evidence.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import path from "node:path";
import * as esbuild from "esbuild";
import ts from "typescript";
import { suites } from "../bench/suites.mjs";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".cache/try-ablation");
const variant = path.join(out, "src");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (i + 1 === args.length || args[i + 1].startsWith("--"))
    throw new Error(`missing value for ${name}`);
  return args[i + 1];
};
const rounds = Number(option("--rounds", "5"));
const suite = option("--suite", "all");
const only = new RegExp(option("--only", "."));
if (!Number.isInteger(rounds) || rounds < 1)
  throw new Error("--rounds must be a positive integer");
if (!["all", "scenarios", "mechanisms"].includes(suite))
  throw new Error(`unknown suite: ${suite}`);

mkdirSync(variant, { recursive: true });
cpSync(path.join(root, "src"), variant, { recursive: true });
const expected = { "kernel.ts": 3, "host.ts": 5, "index.ts": 2 };
const removed = {};

for (const file of readdirSync(variant).filter((name) =>
  name.endsWith(".ts"),
)) {
  const target = path.join(variant, file);
  const text = readFileSync(target, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits = [];
  let count = 0;
  const countTries = (node) => {
    if (ts.isTryStatement(node)) count++;
    ts.forEachChild(node, countTries);
  };
  countTries(source);
  if (count !== (expected[file] ?? 0))
    throw new Error(
      `${file}: expected ${expected[file] ?? 0} try statements, got ${count}`,
    );
  if (count) removed[file] = count;

  const collect = (node) => {
    if (!ts.isTryStatement(node)) return ts.forEachChild(node, collect);

    let replacement = node.tryBlock.getText(source);
    if (node.finallyBlock) {
      // The only finally restores tracking around `return fn()`. Preserve
      // that restoration on the successful path, but not on an exception.
      if (
        file !== "kernel.ts" ||
        node.catchClause ||
        node.tryBlock.getText(source).replace(/\s/g, "") !== "{returnfn();}" ||
        node.finallyBlock.getText(source).replace(/\s/g, "") !==
          "{active=prev;}"
      ) {
        throw new Error(
          `${file}: unexpected finally; adapt the ablation explicitly`,
        );
      }
      replacement = "{ const result = fn(); active = prev; return result; }";
    }
    edits.push({ start: node.getStart(source), end: node.end, replacement });
    // Nested tries in a discarded catch or finally disappear with that block.
  };
  collect(source);
  // Once exec's catch is gone, fail is unreachable and TypeScript's
  // noUnusedLocals rejects it. Esbuild would remove it from the bundle anyway.
  if (file === "kernel.ts") {
    const fail = source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "fail",
    );
    if (!fail) throw new Error("kernel.ts: missing fail function");
    edits.push({ start: fail.getFullStart(), end: fail.end, replacement: "" });
  }
  let result = text;
  for (const { start, end, replacement } of edits.sort(
    (a, b) => b.start - a.start,
  )) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  if (file === "kernel.ts") {
    const unusedImport = /^  unlinkSub,\r?\n/gm;
    if ([...result.matchAll(unusedImport)].length !== 1)
      throw new Error("kernel.ts: expected one unlinkSub import");
    result = result.replace(unusedImport, "");
  }
  const parsed = ts.createSourceFile(
    file,
    result,
    ts.ScriptTarget.Latest,
    true,
  );
  let leftover = 0;
  const check = (node) => {
    if (ts.isTryStatement(node)) leftover++;
    ts.forEachChild(node, check);
  };
  check(parsed);
  if (leftover || parsed.parseDiagnostics.length)
    throw new Error(
      `${file}: invalid ablation or ${leftover} try statements remain`,
    );
  writeFileSync(target, result);
}
writeFileSync(
  path.join(out, "tsconfig.json"),
  JSON.stringify(
    { extends: "../../tsconfig.json", include: ["src"] },
    null,
    2,
  ) + "\n",
);

async function build(name, sourceDir) {
  const dir = path.join(out, name);
  mkdirSync(dir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(root, "bench/adapters/quant.mjs")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    minifySyntax: true,
    minifyWhitespace: true,
    minifyIdentifiers: true,
    target: "es2022",
    define: { __STATS__: "false", __DEV__: "false" },
    plugins: [
      {
        name: "select-runtime",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/\.\.\/src\/index\.ts$/ }, () => ({
            path: path.join(sourceDir, "index.ts"),
          }));
        },
      },
    ],
    outfile: path.join(dir, "index.mjs"),
    logLevel: "warning",
  });
}

await build("before", path.join(root, "src"));
await build("after", variant);
console.log(
  `Prepared ${variant}; removed ${JSON.stringify(removed)} try statements.`,
);
if (args.includes("--prepare-only")) process.exit(0);

const selected = (
  suite === "all" ? ["scenarios", "mechanisms"] : [suite]
).flatMap((name) =>
  suites[name]
    .filter((s) => only.test(s.id))
    .map((s) => ({ ...s, suite: name })),
);
if (!selected.length) throw new Error("no matching scenarios");
const versions = ["before", "after"];
const worker = path.join(root, "bench/worker.mjs");
const measure = (version, scenario, extra = []) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--expose-gc",
        worker,
        path.join(out, version),
        scenario.id,
        "--suite",
        scenario.suite,
        ...extra,
      ],
      { cwd: root, encoding: "utf8", timeout: 120_000 },
    )
      .trim()
      .split("\n")
      .pop(),
  );

for (const scenario of selected) {
  const [before, after] = versions.map((version) =>
    measure(version, scenario, ["--verify"]),
  );
  if (before.checksum !== after.checksum)
    throw new Error(
      `${scenario.id}: checksum mismatch ${before.checksum} vs ${after.checksum}`,
    );
}
console.log(
  `Verified matching 64-step checksums in ${selected.length} scenarios.`,
);

let seed = 0x2545f491;
const random = () =>
  (seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) /
  2 ** 32;
const results = Object.fromEntries(
  selected.map((s) => [`${s.suite}/${s.id}`, { before: [], after: [] }]),
);
for (let round = 0; round < rounds; round++) {
  const pairs = selected.flatMap((scenario) =>
    versions.map((version) => ({ scenario, version })),
  );
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  for (let i = 0; i < pairs.length; i++) {
    const { scenario, version } = pairs[i];
    results[`${scenario.suite}/${scenario.id}`][version].push(
      measure(version, scenario).nsPerStep,
    );
    if ((i + 1) % 20 === 0 || i + 1 === pairs.length)
      process.stderr.write(
        `round ${round + 1}/${rounds}: ${i + 1}/${pairs.length}\n`,
      );
  }
}

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const rows = selected.map((scenario) => {
  const samples = results[`${scenario.suite}/${scenario.id}`];
  const before = median(samples.before);
  const after = median(samples.after);
  return {
    suite: scenario.suite,
    id: scenario.id,
    before,
    after,
    changePercent: (after / before - 1) * 100,
    samples,
  };
});
const report = {
  env: {
    node: process.version,
    v8: process.versions.v8,
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    os: `${platform()} ${release()} ${arch()}`,
    rounds,
  },
  removed,
  rows,
};
writeFileSync(
  path.join(out, "results.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  "| suite | scenario | before ns/step | after ns/step | change |\n| --- | --- | ---: | ---: | ---: |",
);
for (const row of rows)
  console.log(
    `| ${row.suite} | ${row.id} | ${row.before.toFixed(1)} | ${row.after.toFixed(1)} | ${row.changePercent.toFixed(1)}% |`,
  );
console.log(`Raw samples: ${path.join(out, "results.json")}`);
