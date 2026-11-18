// Compact the verified Actions artifacts without pooling jobs or dropping
// any timing cells. Input layout: <directory>/<run-id>/<artifact>/*.json.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , input, output] = process.argv;
assert.ok(input && output, "usage: node research/reorder-results.mjs <download-directory> <output.json>");
function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(child);
    else if (entry.name.endsWith(".json")) yield child;
  }
}
const jobs = new Map();
const round = (n) => Math.round(n * 1000) / 1000;
for (const file of files(input)) {
  const parts = path.relative(input, file).split(path.sep);
  const run = parts[0];
  assert.match(run, /^\d+$/);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const subgroup = parts.find((p) => /^(suffix|thread)-(global|local|neighbors)-[12]$/.test(p)) ?? raw.group;
  const key = run + "/" + subgroup;
  const rows = raw.cells.map(({ label, id, comparison }) => {
    const series = raw.samples.filter((s) => s.label === label && s.id === id).sort((a, b) => a.round - b.round);
    assert.deepEqual(series.map((s) => s.round), [0, 1, 2, 3, 4, 5, 6], key + " " + id);
    for (const s of series) {
      assert.equal(s.checksum, raw.checks[comparison]);
      assert.ok(s.nsPerStep > 0 && s.steps > 0 && s.gc.events >= 0);
    }
    return [id, label, series.map((s) => round(s.nsPerStep)), series.map((s) => s.gc.events),
      series.map((s) => s.steps), series.map((s) => round(s.gc.costUs))];
  });
  assert.equal(raw.samples.length, rows.length * 7);
  const work = raw.structure.map((s) => [s.id, s.label, s.graphBytes, s.stackHighWater,
    Object.fromEntries(Object.entries(s.perStep).filter(([, v]) => v !== 0))]);
  const job = { run, job: subgroup, commit: raw.sha, cpu: raw.cpu, node: raw.node, v8: raw.v8,
    seed: raw.seed, hashes: raw.hashes, checks: raw.checks, work, rows };
  if (jobs.has(key)) assert.deepEqual(job, jobs.get(key), "conflicting copies of " + key);
  jobs.set(key, job);
}
assert.ok(jobs.size > 0);
const header = {
  rows: ["scenario", "label", "nsPerStep by round", "GC events by round", "sampled steps by round", "GC microseconds by round"],
  work: ["scenario", "label", "setup heap delta in bytes", "stack array high-water capacity", "nonzero kernel counts per step"],
  unit: "Each timing observation is the median of 21 batches in one fresh process. Times rounded to 0.001 ns/step. Compare labels only inside a job and round.",
};
const lines = [];
const encodeRow = (row) => JSON.stringify(row);
for (const [, job] of [...jobs].sort(([a], [b]) => a.localeCompare(b))) {
  const { work, rows, ...meta } = job;
  lines.push(JSON.stringify(meta).slice(0, -1) + ',\n"work":[' + work.map(encodeRow).join(",\n") +
    '],\n"rows":[' + rows.map(encodeRow).join(",\n") + "]}");
}
writeFileSync(output, '{"schema":' + JSON.stringify(header) + ',\n"jobs":[\n' + lines.join(",\n") + "\n]}\n");
console.log(`${jobs.size} jobs, ${[...jobs.values()].reduce((n, j) => n + 7 * j.rows.length, 0)} timed processes`);
