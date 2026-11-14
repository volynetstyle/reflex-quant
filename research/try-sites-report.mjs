import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync(process.argv[2], "utf8"));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const i = sorted.length >> 1;
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};
console.log(
  "# Try-site ablation\n\nTimes are ns/step; positive change means slower. Compare only within each scenario on this runner.\n",
);
console.log("| Site | Function | Source |\n| --- | --- | --- |");
for (const s of data.sites)
  console.log(`| ${s.id} | ${s.function} | ${s.file}:${s.line} |`);
console.log(
  "\nCumulative order removes nested sites before their containing catch. Removing the containing catch also removes the nested site from the generated code.\n",
);
for (const [scenario, values] of Object.entries(data.samples)) {
  const baseline = median(values.baseline);
  console.log(
    `## ${scenario}\n\n| Variant | Median ns/step | Range | Change |\n| --- | ---: | ---: | ---: |`,
  );
  for (const variant of data.variants) {
    const xs = values[variant.name];
    const m = median(xs);
    console.log(
      `| ${variant.name} | ${m.toFixed(1)} | ${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)} | ${((m / baseline - 1) * 100).toFixed(1)}% |`,
    );
  }
  console.log();
}
