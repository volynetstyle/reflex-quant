import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { root } from "./experiment-runtime.mjs";
import { productionSource } from "./transition-source.mjs";
import { auditTransitions } from "./transition-audit.mjs";
import { flagAction } from "./transition-model.mjs";
import {
  buildBoundaryOracle,
  buildBoundaryRuntime,
} from "./temporal-runtime.mjs";
const source = productionSource(),
  ledger = JSON.parse(
    readFileSync(
      path.join(root, "research/transition-write-ledger.json"),
      "utf8",
    ),
  );
const audit = auditTransitions({ source, ledger });
const certificates = source.writes
  .filter((s) => s.target === "Node.flags" && s.operation === "assign")
  .map((s) => ({
    id: s.id,
    file: s.file,
    offset: s.offset,
    raw: s._node.getText(),
    base: s._node.left.expression.getText(),
    action: flagAction(s),
  }));
const parent = path.join(root, ".cache/transition-traces");
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(path.join(parent, "run-")),
  reference = await buildBoundaryOracle(path.join(directory, "oracle"));
const bundle = await buildBoundaryRuntime(
  path.join(directory, "runtime"),
  reference.oracle,
  { dev: false, handoffs: true, flagCertificates: certificates },
);
const resultFile = path.join(directory, "trace.json");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "research/temporal-observer.mjs"),
    "--child",
    bundle.outfile,
    reference.outfile,
    resultFile,
  ],
  {
    cwd: root,
    env: { ...process.env, QUANT_TEMPORAL_SUITE: "transitions" },
    windowsHide: true,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  },
);
if (child.status !== 0)
  throw new Error(`Transfer trace failed ${child.error ?? child.stderr}`);
const { traces, ...result } = JSON.parse(readFileSync(resultFile, "utf8"));
if (result.kind !== "pass" || result.checked === 0)
  throw new Error(`Transfer mismatch ${JSON.stringify(result)}`);
const counts = {};
for (const c of result.coverage)
  for (const [id, n] of Object.entries(c.flagTransfers ?? {}))
    counts[id] = (counts[id] ?? 0) + n;
const report = {
  domain:
    "bounded DEV=false instrumented write-level monitor of concrete flag pre/post action and body-entry/exit premises; independent imperative oracle and ownership audits remain enabled",
  profile: { __DEV__: false, __STATS__: true, flagWriteMonitor: true },
  sourceSha256: audit.sourceSha256,
  runtimeSha256: bundle.sha256,
  programs: result.checked,
  operations: traces.reduce((n, t) => n + t.observations.length, 0),
  counts,
  unexecuted: certificates.filter((c) => !counts[c.id]).map((c) => c.id),
  traceSha256: result.traceSha256,
  artifacts: path.relative(root, resultFile),
  excluded: result.excluded,
};
writeFileSync(
  path.join(root, "research/TRANSITION-TRACES.json"),
  JSON.stringify(report, null, 2) + "\n",
);
if (report.unexecuted.length)
  throw new Error(
    `Flag write coverage missing: ${report.unexecuted.join(", ")}`,
  );
console.log(
  JSON.stringify({
    programs: report.programs,
    operations: report.operations,
    sites: Object.keys(counts).length,
    unexecuted: report.unexecuted,
    transfers: Object.values(counts).reduce((a, b) => a + b, 0),
  }),
);
