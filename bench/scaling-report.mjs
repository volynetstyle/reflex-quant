// Scaling report: how ns/step grows with N, per family and runtime.
//
//   node bench/scaling-report.mjs <timing.json> [more.json ...] [--out <file.md>]
//
// Input: run.mjs output of the scaling suite (one file, or CI shards). For
// each family and runtime: ns/step at every N, ns per unit of N at the
// largest N, and the least-squares slope of log(ns) on log(N), so
//   ~0 constant, ~1 linear, ~2 quadratic.
// The slope compares growth across runtimes; absolute times are only
// comparable within one file (one runner).
import { readFileSync, writeFileSync } from "node:fs";
import { families as templates } from "./scaling.mjs";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt < 0 ? undefined : args[outAt + 1];
const files = args.filter((_, i) => outAt < 0 || (i !== outAt && i !== outAt + 1));
if (files.length === 0) throw new Error("usage: scaling-report.mjs <timing.json> [...] [--out <file.md>]");

const byFamily = new Map();
let env;
for (const file of files) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  env ??= data.env;
  const main = data.env?.manifest?.["quant-main"]?.commit;
  if (main !== env?.manifest?.["quant-main"]?.commit) throw new Error(`inconsistent main baseline in ${file}`);
  for (const row of data.rows) {
    const [family, size] = row.id.split("@");
    const n = Number(size);
    if (!Number.isFinite(n)) continue;
    const entry = byFamily.get(family) ?? { family, note: templates[family]?.note ?? row.note, points: [] };
    entry.points.push({
      n, quant: row.quant.median, reflex: row.reflex.median, alien: row.alien.median,
      "quant-main": row["quant-main"]?.median, mainRatio: row.mainComparison?.median,
    });
    byFamily.set(family, entry);
  }
}

function slope(points, runtime) {
  const xs = points.map((p) => Math.log(p.n));
  const ys = points.map((p) => Math.log(p[runtime]));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? NaN : num / den;
}

const fmt = (ns) => (ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : ns >= 1e3 ? `${(ns / 1e3).toFixed(2)} µs` : `${ns.toFixed(1)} ns`);
const families = [...byFamily.values()].map((f) => ({ ...f, points: f.points.sort((a, b) => a.n - b.n) }));
const sizes = [...new Set(families.flatMap((f) => f.points.map((p) => p.n)))].sort((a, b) => a - b);
const main = env?.manifest?.["quant-main"]?.commit;
const runtimes = main ? ["quant", "quant-main", "reflex", "alien"] : ["quant", "reflex", "alien"];
const columns = [
  ...runtimes.map((r) => `${r} slope`),
  ...runtimes.map((r) => `${r} ns/N`),
  "quant / best at max N",
];
if (main) columns.push("quant / main at max N (paired)");

const lines = [];
if (env) lines.push(`Node ${env.node} (V8 ${env.v8}), ${env.cpu} x${env.cores}, ${env.os}; ${env.rounds} rounds`, "");
if (main) lines.push(`Quant ${env.manifest.quant.commit} vs main ${main}.`, "");
lines.push(
  "Growth exponent: slope of log(ns/step) on log(N) (0 constant, 1 linear, 2 quadratic); ns per N at the largest N.",
  "",
  `| family | ${columns.join(" | ")} |`,
  `| --- | ${columns.map(() => "---:").join(" | ")} |`,
);
for (const f of families) {
  const big = f.points.at(-1);
  const s = runtimes.map((r) => slope(f.points, r).toFixed(2));
  const perN = runtimes.map((r) => (big[r] / big.n).toFixed(2));
  const vsBest = (big.quant / Math.min(big.reflex, big.alien)).toFixed(2);
  const cells = [f.family, ...s, ...perN, vsBest];
  if (main) cells.push(big.mainRatio.toFixed(3));
  lines.push(`| ${cells.join(" | ")} |`);
}
lines.push("", `ns/step per N (${runtimes.join(" / ")})`, "", `| family | ${sizes.map((n) => `N=${n}`).join(" | ")} |`, `| --- | ${sizes.map(() => "---:").join(" | ")} |`);
for (const f of families) {
  const cells = sizes.map((n) => {
    const p = f.points.find((x) => x.n === n);
    return p ? runtimes.map((r) => fmt(p[r])).join(" / ") : "";
  });
  lines.push(`| ${f.family} | ${cells.join(" | ")} |`);
}
lines.push("", "Families:", "", ...families.map((f) => `- ${f.family}: ${f.note}`));

const table = lines.join("\n");
if (out) writeFileSync(out, table + "\n");
console.log(table);
