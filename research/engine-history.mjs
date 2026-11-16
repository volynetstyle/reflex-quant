import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { cpus, release } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildExperimentRuntime,
  root,
  scalarGraph,
} from "./experiment-runtime.mjs";

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    mid = sorted.length >> 1;
  return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

async function child(bundle, parameters) {
  const api = await import(pathToFileURL(bundle).href);
  const sources = Array.from({ length: 256 }, () => api.signal(0));
  const mode = api.signal(0),
    failure = api.signal(false);
  const c = api.computed(() => {
    if (api.get(failure)) throw new Error("attempt");
    const degree = api.get(mode) ? sources.length : 1;
    let sum = 0;
    for (let n = 0; n < degree; n++) sum += Number(api.get(sources[n]));
    return sum;
  });
  api.get(c);
  if (parameters.history === "polymorphic")
    for (let n = 0; n < 3000; n++) {
      for (const value of [n, { valueOf: () => n }, BigInt(n), n]) {
        api.set(sources[0], value);
        api.get(c);
      }
    }
  if (parameters.history === "high-degree")
    for (let n = 0; n < 1000; n++) {
      api.set(mode, 1);
      api.get(c);
      api.set(mode, 0);
      api.get(c);
    }
  if (parameters.history === "failure-churn")
    for (let n = 0; n < 1000; n++) {
      api.set(failure, true);
      try {
        api.get(c);
      } catch {
        /* deliberate prefix */
      }
      api.set(mode, n & 1);
      api.set(failure, false);
      api.get(c);
    }
  api.set(mode, 0);
  api.set(failure, false);
  api.set(sources[0], 0);
  api.get(c);
  const logical = scalarGraph([...sources, mode, failure, c]);
  if (parameters.diagnostic) process.stdout.write("\nMARK checkpoint\n");
  const work = (count) => {
    let checksum = 0;
    for (let n = 0; n < count; n++) {
      api.set(sources[0], n & 255);
      checksum += api.get(c);
    }
    api.set(sources[0], 0);
    api.get(c);
    return checksum;
  };
  const count = parameters.iterations;
  const remainder = count % 256;
  const expected =
    Math.floor(count / 256) * 32640 + (remainder * (remainder - 1)) / 2;
  // Repeated common warmup after the divergent prefix, then separate late rounds.
  for (let n = 0; n < 5; n++)
    if (work(count) !== expected) throw new Error("warmup semantic mismatch");
  if (parameters.diagnostic) process.stdout.write("\nMARK warmed\n");
  const rounds = [];
  for (let n = 0; n < 9; n++) {
    const start = performance.now(),
      checksum = work(count);
    rounds.push({ ms: performance.now() - start, checksum });
    if (checksum !== expected) throw new Error("timed semantic mismatch");
  }
  return {
    parameters,
    logical,
    rounds,
    earlyMedian: median(rounds.slice(0, 4).map((round) => round.ms)),
    lateMedian: median(rounds.slice(4).map((round) => round.ms)),
    expected,
  };
}

if (process.argv[2] === "--child") {
  const parameters = JSON.parse(process.argv[4]);
  process.stdout.write(
    (parameters.diagnostic ? "RESULT " : "") +
      JSON.stringify(await child(process.argv[3], parameters)),
  );
} else {
  const runtime = await buildExperimentRuntime("engine-history");
  const trials = Number(process.env.QUANT_ENGINE_TRIALS ?? 5),
    iterations = Number(process.env.QUANT_ENGINE_ITERATIONS ?? 200_000);
  if (
    !Number.isSafeInteger(trials) ||
    trials < 1 ||
    !Number.isSafeInteger(iterations) ||
    iterations < 1
  )
    throw new Error("invalid engine experiment budget");
  const results = [];
  for (let trial = 0; trial < trials; trial++) {
    // Alternate pair order to reduce chronological bias; each run has a fresh V8.
    const order =
      trial & 1
        ? ["failure-churn", "high-degree", "polymorphic", "fresh"]
        : ["fresh", "polymorphic", "high-degree", "failure-churn"];
    for (const history of order) {
      const parameters = { trial, history, iterations };
      const run = spawnSync(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          "--child",
          runtime.outfile,
          JSON.stringify(parameters),
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 45_000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      if (run.status !== 0)
        throw new Error(`engine child failed: ${run.stderr || run.error}`);
      results.push(JSON.parse(run.stdout));
    }
  }
  const baseline = results[0].logical;
  if (
    results.some(
      (result) => JSON.stringify(result.logical) !== JSON.stringify(baseline),
    )
  )
    throw new Error("engine histories did not reach equal logical graphs");
  const ratios = ["polymorphic", "high-degree", "failure-churn"].map(
    (history) => {
      const pairs = Array.from({ length: trials }, (_, trial) => {
        const fresh = results.find(
          (result) =>
            result.parameters.trial === trial &&
            result.parameters.history === "fresh",
        );
        const changed = results.find(
          (result) =>
            result.parameters.trial === trial &&
            result.parameters.history === history,
        );
        return {
          trial,
          early: changed.earlyMedian / fresh.earlyMedian,
          late: changed.lateMedian / fresh.lateMedian,
        };
      });
      return {
        history,
        pairs,
        medianLateRatio: median(pairs.map((pair) => pair.late)),
      };
    },
  );
  const telemetry = [];
  for (const history of [
    "fresh",
    "polymorphic",
    "high-degree",
    "failure-churn",
  ]) {
    const parameters = { history, iterations: 20_000, diagnostic: true };
    const run = spawnSync(
      process.execPath,
      [
        "--trace-opt",
        "--trace-deopt",
        fileURLToPath(import.meta.url),
        "--child",
        runtime.outfile,
        JSON.stringify(parameters),
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 45_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (run.status !== 0)
      throw new Error(`engine diagnostics failed: ${run.stderr}`);
    const file = path.join(runtime.directory, history + ".trace.txt");
    writeFileSync(file, run.stdout + run.stderr);
    let phase = "prefix";
    const counts = {
      prefix: { opt: 0, deopt: 0 },
      warmup: { opt: 0, deopt: 0 },
      measured: { opt: 0, deopt: 0 },
    };
    for (const line of run.stdout.split("\n")) {
      // V8's native trace writes can interleave with stdout markers. These are
      // emission windows, not exact attribution of background compiler work.
      if (line.includes("MARK checkpoint")) phase = "warmup";
      if (line.includes("MARK warmed")) phase = "measured";
      if (/deoptimizing/.test(line)) counts[phase].deopt++;
      else if (/completed (?:optimizing|compiling)/.test(line))
        counts[phase].opt++;
    }
    telemetry.push({
      history,
      parameters,
      counts,
      trace: path.relative(root, file),
      deoptExamples: run.stdout
        .split("\n")
        .filter((line) => /deoptimizing/.test(line))
        .slice(0, 8),
    });
  }
  const compact = results.map(({ logical, ...result }) => result);
  writeFileSync(
    path.join(root, "research", "ENGINE-HISTORY.json"),
    JSON.stringify(
      {
        domain:
          "separate-process prefix histories, five common warmups, nine timing rounds; no correctness timing threshold; optimization diagnostics run separately from timing",
        node: process.version,
        v8: process.versions.v8,
        arch: process.arch,
        platform: process.platform,
        osRelease: release(),
        cpu: cpus()[0]?.model,
        runtimeSha256: runtime.sha256,
        trials,
        iterations,
        ratios,
        logicalGraph: baseline,
        telemetry,
        results: compact,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    JSON.stringify(
      ratios.map(({ history, medianLateRatio }) => ({
        history,
        medianLateRatio,
      })),
    ) + "\n",
  );
}
