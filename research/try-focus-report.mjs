import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const root = process.argv[2];
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    i = sorted.length >> 1;
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};
console.log(
  "# Deliver boundary experiment\n\nEach row compares medians on one runner. Percentages are changes in time; negative is faster. A/A uses a separately built byte-identical baseline. No absolute times are compared across runners.\n",
);
console.log(
  "| Job | CPU | Scenario | Baseline ns/step | A/A | single-4 | cumulative-3 | cumulative-4 | check-safe |\n| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
);
for (const entry of readdirSync(root).sort()) {
  const result = JSON.parse(
    readFileSync(path.join(root, entry, "results.json"), "utf8"),
  );
  for (const [scenario, variants] of Object.entries(result.samples)) {
    const base = median(variants.baseline);
    const delta = (name) =>
      variants[name]
        ? `${((median(variants[name]) / base - 1) * 100).toFixed(2)}%`
        : "—";
    console.log(
      `| ${entry} | ${result.env.cpu} | ${scenario} | ${base.toFixed(1)} | ${["baseline-control", "single-4", "cumulative-3", "cumulative-4", "check-safe"].map(delta).join(" | ")} |`,
    );
  }
}
