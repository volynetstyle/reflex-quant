// Timing comparison of quant, Reflex and alien-signals (CI only: timing runs
// never count when taken on a developer machine).
//
//   node bench/build.mjs && node bench/run.mjs [--suite scenarios|mechanisms|scaling] [--rounds 7] [--only <regex>] [--out <file>] [--verify-only]
//
// Protocol: every (runtime, scenario) pair runs in a fresh process per
// round; within a round the pairs run in a random order, so drift and
// thermal state spread over all runtimes alike. A round's value is the
// median of 21 batches of ~10 ms after warm-up; the reported value is the
// median over rounds, with the range of the round medians. Before timing,
// every scenario must produce the same 64-step checksum on every runtime.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import path from "node:path";
import { suiteOf } from "./suites.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const { name: suite, scenarios } = suiteOf(args);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const rounds = Number(option("--rounds", 7));
const only = new RegExp(option("--only", "."));
const outFile = option("--out", path.join(root, ".cache/bench/results.json"));
const runtimes = ["quant", "reflex", "alien"];
const bundle = (name) => path.join(root, ".cache/bench", name);
const worker = path.join(root, "bench/worker.mjs");
const selected = scenarios.filter((s) => only.test(s.id));

let seed = 0x2545f491;
const random = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
const shuffle = (list) => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};
const runWorker = (runtime, id, extra = []) =>
  JSON.parse(
    execFileSync(process.execPath, ["--expose-gc", worker, bundle(runtime), id, "--suite", suite, ...extra], { encoding: "utf8", timeout: 120_000 })
      .trim()
      .split("\n")
      .pop(),
  );

// 1. Same program, same answers.
const invalid = [];
for (const s of selected) {
  const sums = runtimes.map((r) => runWorker(r, s.id, ["--verify"]).checksum);
  if (new Set(sums).size !== 1) invalid.push(`${s.id}: ${runtimes.map((r, k) => `${r}=${sums[k]}`).join(" ")}`);
}
if (invalid.length) {
  console.error(`checksum mismatch:\n  ${invalid.join("\n  ")}`);
  process.exitCode = 1;
}
if (args.includes("--verify-only")) {
  console.log(`${selected.length} scenarios verified on ${runtimes.join(", ")}: ${invalid.length} checksum mismatches`);
  process.exit();
}

// 2. Timing.
const results = {};
for (let round = 0; round < rounds; round++) {
  const pairs = shuffle(selected.flatMap((s) => runtimes.map((r) => [r, s.id])));
  for (const [runtime, id] of pairs) {
    const m = runWorker(runtime, id);
    ((results[id] ??= {})[runtime] ??= []).push(m.nsPerStep);
  }
  process.stderr.write(`round ${round + 1}/${rounds}\n`);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const rows = selected.map((s) => {
  const row = { id: s.id, group: s.group, note: s.note };
  for (const r of runtimes) {
    const xs = results[s.id][r];
    row[r] = { median: median(xs), min: Math.min(...xs), max: Math.max(...xs) };
  }
  const best = Math.min(row.reflex.median, row.alien.median);
  row.quantVsBest = row.quant.median / best;
  row.quantVsReflex = row.quant.median / row.reflex.median;
  row.quantVsAlien = row.quant.median / row.alien.median;
  return row;
});

const env = {
  node: process.version,
  v8: process.versions.v8,
  cpu: cpus()[0]?.model,
  cores: cpus().length,
  os: `${platform()} ${release()} ${arch()}`,
  suite,
  rounds,
  manifest: JSON.parse(readFileSync(path.join(root, ".cache/bench/manifest.json"), "utf8")),
  invalid,
};
writeFileSync(outFile, JSON.stringify({ env, rows }, null, 2) + "\n");

const fmt = (ns) => (ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : ns >= 1e3 ? `${(ns / 1e3).toFixed(2)} µs` : `${ns.toFixed(0)} ns`);
const lines = [
  `Node ${env.node} (V8 ${env.v8}), ${env.cpu} x${env.cores}, ${env.os}; ${rounds} rounds; reflex ${env.manifest.reflex.commit.slice(0, 7)}, alien ${env.manifest.alien.version}`,
  "",
  "| scenario | quant | reflex | alien | quant / best | quant / reflex | quant / alien |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...rows.map(
    (r) =>
      `| ${r.id} | ${fmt(r.quant.median)} | ${fmt(r.reflex.median)} | ${fmt(r.alien.median)} | ${r.quantVsBest.toFixed(2)} | ${r.quantVsReflex.toFixed(2)} | ${r.quantVsAlien.toFixed(2)} |`,
  ),
  "",
  "Round ranges (min..max of the round medians):",
  "",
  ...rows.map((r) => `- ${r.id}: ${runtimes.map((k) => `${k} ${fmt(r[k].min)}..${fmt(r[k].max)}`).join(", ")}`),
];
const table = lines.join("\n");
writeFileSync(outFile.replace(/\.json$/, ".md"), table + "\n");
console.log(table);
