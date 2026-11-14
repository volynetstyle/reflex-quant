import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const root = process.argv[2];
const median = (values) => {
  const s = [...values].sort((a, b) => a - b),
    i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};
console.log(
  "# Representation ablations\n\nEach row compares one candidate with its own runner's baseline. Negative changes mean faster; A/A uses byte-identical code. Primary workloads are marked with *. Do not pool absolute times across runners.\n",
);
console.log(
  "| Job | CPU | Workload | Candidate | Baseline ns | Candidate ns | Change | A/A |\n| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
);
for (const dir of readdirSync(root).sort()) {
  const r = JSON.parse(
    readFileSync(path.join(root, dir, "results.json"), "utf8"),
  );
  const name = r.variants.find(
    (v) => v.name !== "baseline" && v.name !== "baseline-control",
  ).name;
  for (const [id, values] of Object.entries(r.samples).sort(([a], [b]) =>
    a === r.env.primary ? -1 : b === r.env.primary ? 1 : a.localeCompare(b),
  )) {
    const base = median(values.baseline),
      candidate = median(values[name]),
      control = median(values["baseline-control"]);
    console.log(
      `| ${dir} | ${r.env.cpu} | ${id}${id === r.env.primary ? " *" : ""} | ${name} | ${base.toFixed(1)} | ${candidate.toFixed(1)} | ${((candidate / base - 1) * 100).toFixed(2)}% | ${((control / base - 1) * 100).toFixed(2)}% |`,
    );
  }
}
