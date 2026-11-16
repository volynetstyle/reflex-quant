import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { root } from "./experiment-runtime.mjs";

const require = createRequire(path.join(root, "package.json"));
const vitest = path.join(
  path.dirname(require.resolve("vitest/package.json")),
  "vitest.mjs",
);
const report = path.join(root, "research", "SCAR-SEARCH.json");
const child = spawnSync(
  process.execPath,
  [
    vitest,
    "run",
    "--config",
    "vitest.config.ts",
    "--mode",
    "production",
    "test/history-greybox.test.ts",
    "-t",
    "maximizes implementation",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      QUANT_SCAR_REPORT: report,
      QUANT_SCAR_STEPS: process.env.QUANT_SCAR_STEPS ?? "256",
    },
    stdio: "inherit",
    windowsHide: true,
    timeout: 60_000,
  },
);
if (child.status !== 0)
  throw new Error(`scar campaign failed: ${child.error ?? child.status}`);
const result = JSON.parse(readFileSync(report, "utf8"));
process.stdout.write(
  JSON.stringify({
    evaluated: result.search.evaluated,
    novel: result.search.novel,
    classes: result.search.classes,
    distance: result.search.selected.distance,
    pair: result.search.selected.history.id,
    continuations: result.continuation.checked,
  }) + "\n",
);
