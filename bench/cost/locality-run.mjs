// One GitHub Actions job per group. Preserve round pairing, A/A, order, raw
// ns/step, GC observations and bundle identities for reanalysis.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { permutation } from "../scaling.mjs";
import { scenarios } from "./locality.mjs";

const [group, count = "7"] = process.argv.slice(2);
const rounds = Number(count);
assert.ok(Number.isInteger(rounds) && (rounds === 0 || rounds >= 5));
const root = path.resolve(import.meta.dirname, "../..");
const cache = path.join(root, ".cache");
const cells = [];
function add(label, suite, id, bundle, comparison = id) {
  cells.push({ label, suite, id, bundle, comparison });
}

if (["walk", "splice", "pages"].includes(group)) {
  for (const { id, n } of scenarios.filter((s) => s.id.startsWith(group + "."))) {
    add("raw", "locality", id, "cost/quant-internals", group + n);
    if (/^(walk\.rr\.chain|splice\.indirect|pages\.packed)@/.test(id))
      add("A/A", "locality", id, "cost/quant-internals", group + n);
  }
} else if (group === "runtime") {
  for (const n of [512, 1024, 2048, 4096, 8192]) {
    for (const family of ["reverse", "shuffle"]) {
      const id = `regime.${family}@${n}`;
      for (const [label, bundle] of Object.entries({
        quant: "bench/quant", "A/A": "bench/quant", slots: "cost/rv-index-always", reflex: "bench/reflex",
      })) add(label, "cost", id, bundle);
    }
  }
} else {
  throw new Error(`unknown group ${group}`);
}

function worker(script, args) {
  const output = execFileSync(process.execPath, ["--expose-gc", path.join(root, script), ...args], {
    encoding: "utf8", timeout: 180_000,
  });
  return JSON.parse(output.trim());
}
const checks = new Map(), structure = [], hashes = {};
for (const cell of cells) {
  const { bundle, suite, id, comparison } = cell;
  const dir = path.join(cache, bundle);
  const { checksum } = worker("bench/worker.mjs", [dir, id, "--suite", suite, "--verify"]);
  if (checks.has(comparison)) assert.equal(checksum, checks.get(comparison), id);
  checks.set(comparison, checksum);
  hashes[bundle] ??= createHash("sha256").update(readFileSync(path.join(dir, "index.mjs"))).digest("hex");
  if (group === "runtime" && ["quant", "slots"].includes(cell.label)) {
    structure.push({ label: cell.label, ...worker("bench/cost/structure-worker.mjs", [
      id, "--suite", suite, "--bundle", dir + "-stats",
    ]) });
  }
}

const samples = [];
const seed = Number(process.env.GITHUB_RUN_ID ?? 3089) >>> 0;
for (let round = 0; round < rounds; round++) {
  for (const index of permutation(cells.length, seed + round * 7919)) {
    const { label, suite, id, bundle, comparison } = cells[index];
    const m = worker("bench/worker.mjs", [path.join(cache, bundle), id, "--suite", suite, "--gc"]);
    assert.equal(m.checksum, checks.get(comparison), id);
    samples.push({ round, label, ...m });
  }
  console.log(`${group}: finished round ${round + 1}/${rounds}`);
}
const out = path.join(cache, "locality-results");
mkdirSync(out, { recursive: true });
const result = {
  group, seed, cpu: cpus()[0].model, node: process.version, v8: process.versions.v8,
  sha: process.env.GITHUB_SHA ?? null, hashes, checks: Object.fromEntries(checks), structure, cells, samples,
};
writeFileSync(path.join(out, group + ".json"), JSON.stringify(result, null, 2) + "\n");
console.log(`${cells.length} cells verified, ${samples.length} timed`);
