// Structural work per step: quant's kernel counters next to alien-signals'
// link counters, on the same scenarios. Counting, not timing: it runs on any
// machine.
//
//   node bench/build.mjs && node bench/structure.mjs [--suite scenarios|mechanisms|scaling] [--only <regex>]
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { suiteOf } from "./suites.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const { name: suite, scenarios } = suiteOf(args);
const only = new RegExp(args.includes("--only") ? args[args.indexOf("--only") + 1] : ".");
const load = (name) => import(pathToFileURL(path.join(root, ".cache/bench", name, "index.mjs")).href);
const quant = await load("quant-stats");
const alien = await load("alien-stats");

const STEPS = 256;
function measure(api, scenario) {
  const step = scenario.setup(api);
  for (let i = 1; i <= 64; i++) step(i);
  const before = { ...api.stats };
  for (let i = 65; i < 65 + STEPS; i++) step(i);
  return Object.fromEntries(Object.keys(api.stats).map((k) => [k, (api.stats[k] - before[k]) / STEPS]));
}

const rows = [];
for (const s of scenarios.filter((x) => only.test(x.id))) {
  const q = measure(quant, s);
  const a = measure(alien, s);
  rows.push({ id: s.id, quant: q, alien: a });
}

const f = (x) => (x === 0 ? "0" : x < 10 ? x.toFixed(2) : x.toFixed(0));
const table = [
  "Per measured step (mean of 256 steps after 64 warm-up steps).",
  "",
  "| scenario | reads | cursor hits | skips | lookups | index + mark walks | walked | moves | new rel. | removed | executions | marks | validation loads | alien new links | alien removed |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...rows.map(
    ({ id, quant: q, alien: a }) =>
      `| ${id} | ${f(q.reads)} | ${f(q.hits)} | ${f(q.scans)} | ${f(q.lookups)} | ${f(q.indexes)} + ${f(q.sweeps ?? 0)} | ${f(q.indexed)} | ${f(q.moves)} | ${f(q.links)} | ${f(q.unlinks)} | ${f(q.runs)} | ${f(q.marks)} | ${f(q.checks)} | ${f(a.linksCreated)} | ${f(a.linksUnlinked)} |`,
  ),
].join("\n");
writeFileSync(path.join(root, `.cache/bench/structure${suite === "scenarios" ? "" : `-${suite}`}.json`), JSON.stringify(rows, null, 2) + "\n");
console.log(table);
