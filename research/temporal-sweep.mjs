import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { root } from "./experiment-runtime.mjs";
import {
  buildBoundaryOracle,
  buildBoundaryRuntime,
} from "./temporal-runtime.mjs";
import { annotateTemporalReport } from "./temporal-facts.mjs";
const handoffs = process.argv.includes("--handoffs");

const campaignRoot = path.join(root, ".cache", "temporal-ownership");
mkdirSync(campaignRoot, { recursive: true });
const artifacts = mkdtempSync(
  path.join(campaignRoot, String(Date.now()) + "-"),
);
const reference = await buildBoundaryOracle(path.join(artifacts, "oracle"));
const variants = [
  { dev: true, mask: undefined },
  { dev: false, mask: undefined },
  { dev: true, mask: 7 },
  { dev: false, mask: 7 },
];
const label = (options) =>
  `${options.dev ? "dev" : "prod"}-${options.mask ?? "full"}`;
async function run(id, options, edits = [], only) {
  const directory = path.join(artifacts, id, label(options)),
    resultFile = path.join(directory, "observations.json");
  let bundle;
  try {
    bundle = await buildBoundaryRuntime(directory, reference.oracle, {
      ...options,
      edits,
      handoffs,
    });
  } catch (error) {
    return { kind: "invalid", message: String(error) };
  }
  const child = spawnSync(
    process.execPath,
    [
      path.join(root, "research", "temporal-observer.mjs"),
      "--child",
      bundle.outfile,
      reference.outfile,
      resultFile,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        QUANT_TEMPORAL_SUITE: handoffs ? "handoffs" : "boundaries",
        ...(only ? { QUANT_BOUNDARY_ONLY: only } : {}),
      },
      encoding: "utf8",
      timeout: edits.length ? 8000 : 30000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  if (child.error?.code === "ETIMEDOUT") return { kind: "timeout" };
  if (child.status !== 0)
    return {
      kind: "invalid",
      message: (child.stderr || String(child.error)).slice(-2000),
    };
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  return {
    ...result,
    runtimeSha256: bundle.sha256,
    artifacts: path.relative(root, resultFile),
  };
}
const baselines = [];
for (const options of variants) {
  const result = await run("baseline", options);
  if (result.kind !== "pass" || result.checked === 0)
    throw new Error(
      `invalid pristine boundary domain ${label(options)}: ${JSON.stringify(result)}`,
    );
  baselines.push({ variant: label(options), result });
}
const direct = [];
for (const offset of [0, 2]) {
  const dev = baselines[offset],
    prod = baselines[offset + 1];
  if (!isDeepStrictEqual(dev.result.traces, prod.result.traces))
    throw new Error(
      `direct DEV/PROD divergence: ${dev.variant}/${prod.variant}`,
    );
  direct.push({
    mask: variants[offset].mask ?? "full",
    programs: dev.result.checked,
    observations: dev.result.traces.reduce(
      (n, t) => n + t.observations.length,
      0,
    ),
    equal: true,
    traceSha256: dev.result.traceSha256,
  });
}
const compact = baselines.map(({ variant, result: { traces, ...result } }) => ({
  variant,
  ...result,
}));
const report = {
  domain: handoffs
    ? "finite coupled ownership handoffs with closure epochs, relation identity and alias-role witnesses"
    : "finite temporal boundary callbacks; model admission and vertical checks, direct DEV/PROD observations, operation-scoped graph/retirement/root audits",
  node: process.version,
  v8: process.versions.v8,
  generated: new Date().toISOString(),
  sourceSha256: createHash("sha256")
    .update(
      readdirSync(path.join(root, "src"))
        .sort()
        .map((name) => readFileSync(path.join(root, "src", name), "utf8"))
        .join("\n"),
    )
    .digest("hex"),
  baselines: compact,
  direct,
  artifacts: path.relative(root, artifacts),
};
if (process.argv.includes("--mutants")) {
  const { temporalMutants, discoverDevMutants } =
    await import("./temporal-facts.mjs");
  const catalogue = handoffs
    ? (await import("./handoff-mutants.mjs")).handoffMutants()
    : [...temporalMutants(), ...discoverDevMutants(root)];
  const results = [];
  for (const mutant of catalogue) {
    let verdict = "survived";
    const witnesses = [];
    for (const options of variants) {
      const { traces, coverage, ...result } = await run(
        mutant.id,
        options,
        mutant.edits,
      );
      witnesses.push({ variant: label(options), ...result });
      if (result.kind !== "pass") {
        verdict = result.kind;
        break;
      }
    }
    results.push({ ...mutant, verdict, witnesses });
    process.stdout.write(`${mutant.id}: ${verdict}\n`);
  }
  const summary = Object.fromEntries(
    ["killed", "survived", "invalid", "timeout", "coverage-gap"].map((kind) => [
      kind,
      results.filter((r) => r.verdict === kind).length,
    ]),
  );
  report.mutations = {
    seeded: catalogue.length,
    summary,
    score: summary.killed / catalogue.length,
    results,
  };
  if (handoffs) {
    const missingSlot = catalogue.find(
      (m) => m.id === "handoff-slots-destination-missing",
    );
    report.slotWork = [];
    for (const width of [32, 64, 128]) {
      const id = `handoff-slot-work-${width}`;
      const { traces, coverage, ...result } = await run(
        `work-evidence-${width}`,
        { dev: false },
        missingSlot.edits,
        id,
      );
      const pristine = baselines
        .find((b) => b.variant === "prod-full")
        .result.coverage.find((c) => c.id === id);
      report.slotWork.push({
        width,
        pristine: pristine.indexedWork,
        measured: result.indexed ?? coverage?.[0]?.indexedWork,
        result,
      });
    }
  }
}
annotateTemporalReport(report);
if (handoffs) (await import("./handoff-mutants.mjs")).annotateHandoffs(report);
writeFileSync(
  path.join(
    root,
    "research",
    handoffs
      ? report.mutations
        ? "HANDOFF-MUTANTS.json"
        : "HANDOFF-PARITY.json"
      : report.mutations
        ? "TEMPORAL-BOUNDARIES.json"
        : "BOUNDARY-PARITY.json",
  ),
  JSON.stringify(report, null, 2) + "\n",
);
process.stdout.write(
  JSON.stringify({ direct, mutations: report.mutations?.summary }) + "\n",
);
if (
  report.mutations &&
  (report.mutations.summary.invalid ||
    report.mutations.summary.timeout ||
    report.mutations.summary["coverage-gap"])
)
  process.exitCode = 1;
