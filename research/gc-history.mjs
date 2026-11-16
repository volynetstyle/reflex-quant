import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { PerformanceObserver, constants } from "node:perf_hooks";
import { getHeapSpaceStatistics } from "node:v8";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildExperimentRuntime, root } from "./experiment-runtime.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
let anchor;
const spaces = () =>
  Object.fromEntries(
    getHeapSpaceStatistics().map((space) => [
      space.space_name,
      space.space_used_size,
    ]),
  );

async function conditionEdges(api, collect) {
  const sources = Array.from({ length: 32 }, () => api.signal(0));
  const tick = api.signal(0);
  let index = 0;
  const c = api.computed(() => {
    api.get(tick);
    return api.get(sources[index]);
  });
  api.get(c);
  await collect("major");
  const kept = [];
  for (let batch = 0; batch < 4; batch++) {
    for (let n = 0; n < 512; n++) {
      index = (index + 1) % sources.length;
      api.set(tick, batch * 512 + n + 1);
      api.get(c);
      for (let edge = c.firstDep; edge !== null; edge = edge.nextDep)
        if (edge.from === sources[index]) kept.push(edge);
    }
    await collect("minor");
  }
  api.dispose(c);
  kept.length = 0;
}

async function fixture(api, parameters, collect) {
  if (parameters.treatment === "bare")
    return {
      payload: new WeakRef({ bytes: new Uint8Array(32 * 1024) }),
      source: null,
      consumer: null,
      edge: null,
    };
  if (parameters.history === "edge-conditioned") {
    await conditionEdges(api, collect);
    await collect("major");
  }
  let source = api.signal(0),
    payload = 0;
  let consumer =
    parameters.treatment === "carrier"
      ? api.signal(0)
      : api.computed(() => {
          api.get(source);
          return parameters.endpoint === "from" ? 0 : payload;
        });
  let edge = null;
  const initialize = () => {
    if (parameters.treatment !== "carrier") {
      api.get(consumer);
      edge = consumer.firstDep;
    }
  };
  if (parameters.treatment !== "young-edge") initialize();
  if (parameters.history === "aged") {
    await collect("major");
    await collect("minor");
  }
  const target = {
    bytes: new Uint8Array(32 * 1024),
    marker: parameters.endpoint,
  };
  if (parameters.endpoint === "from") api.set(source, target);
  else if (parameters.treatment === "carrier") api.set(consumer, target);
  else {
    payload = target;
    api.set(source, 1);
  }
  if (parameters.treatment !== "carrier") {
    api.get(consumer);
    edge ??= consumer.firstDep;
    api.dispose(consumer);
    if (consumer.firstDep !== null || source.firstSub !== null)
      throw new Error("logical disposal failed");
    for (const field of ["prevDep", "nextDep", "prevSub", "nextSub"])
      if (edge[field] !== null) throw new Error(`retirement failed: ${field}`);
  }
  const refs = {
    payload: new WeakRef(target),
    source: new WeakRef(source),
    consumer: new WeakRef(consumer),
    edge: edge === null ? null : new WeakRef(edge),
  };
  if (parameters.treatment === "positive-root") anchor = edge;
  edge = null;
  consumer = null;
  source = null;
  payload = null;
  return refs;
}

async function child(bundle, parameters) {
  if (typeof global.gc !== "function")
    return { status: "unavailable", reason: "--expose-gc required" };
  const api = await import(pathToFileURL(bundle).href);
  const events = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      events.push({ kind: entry.detail.kind, flags: entry.detail.flags });
  });
  observer.observe({ entryTypes: ["gc"] });
  const collect = async (type) => {
    await turn();
    global.gc({ type, execution: "sync" });
    await turn();
    await turn();
  };
  const refs = await fixture(api, parameters, collect);
  const before = spaces(),
    observations = [];
  for (const requested of [
    "minor",
    "minor",
    "minor",
    "major",
    "major",
    "major",
  ]) {
    const start = events.length;
    await collect(requested);
    observations.push({
      requested,
      observedKinds: events.slice(start).map((event) => event.kind),
      alive: Object.fromEntries(
        Object.entries(refs).map(([name, ref]) => [
          name,
          ref === null ? null : ref.deref() !== undefined,
        ]),
      ),
    });
  }
  const minorObserved = events.some(
    (entry) => entry.kind === constants.NODE_PERFORMANCE_GC_MINOR,
  );
  const majorObserved = events.some(
    (entry) => entry.kind === constants.NODE_PERFORMANCE_GC_MAJOR,
  );
  const retained = observations.at(-1).alive.payload;
  observer.disconnect();
  anchor = undefined;
  const validControl = parameters.treatment !== "positive-root" || retained;
  return {
    parameters,
    status:
      !minorObserved || !majorObserved || !validControl
        ? "invalid"
        : retained
          ? "retained-after-budget"
          : "collected",
    before,
    after: spaces(),
    minorObserved,
    majorObserved,
    observations,
    events,
    note: "Histories condition ages/allocation sites; individual object generations are not measured.",
  };
}

if (process.argv[2] === "--child") {
  const result = await child(process.argv[3], JSON.parse(process.argv[4]));
  process.stdout.write(JSON.stringify(result));
} else {
  const runtime = await buildExperimentRuntime("physical-gc");
  const trials = Number(process.env.QUANT_GC_TRIALS ?? 2);
  if (!Number.isSafeInteger(trials) || trials < 1)
    throw new Error("invalid GC trial count");
  const results = [];
  for (let trial = 0; trial < trials; trial++)
    for (const endpoint of ["from", "to"]) {
      for (const history of ["fresh", "aged", "edge-conditioned"])
        for (const treatment of ["old-edge", "young-edge", "carrier"]) {
          const parameters = { trial, endpoint, history, treatment };
          const run = spawnSync(
            process.execPath,
            [
              "--expose-gc",
              fileURLToPath(import.meta.url),
              "--child",
              runtime.outfile,
              JSON.stringify(parameters),
            ],
            {
              cwd: root,
              encoding: "utf8",
              timeout: 30_000,
              windowsHide: true,
              maxBuffer: 4 * 1024 * 1024,
            },
          );
          if (run.status !== 0)
            throw new Error(`GC child failed: ${run.stderr || run.error}`);
          results.push(JSON.parse(run.stdout));
        }
      const parameters = {
        trial,
        endpoint,
        history: "aged",
        treatment: "positive-root",
      };
      const run = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          fileURLToPath(import.meta.url),
          "--child",
          runtime.outfile,
          JSON.stringify(parameters),
        ],
        { cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true },
      );
      if (run.status !== 0) throw new Error(`GC control failed: ${run.stderr}`);
      results.push(JSON.parse(run.stdout));
    }
  for (let trial = 0; trial < trials; trial++) {
    const parameters = {
      trial,
      endpoint: "none",
      history: "fresh",
      treatment: "bare",
    };
    const run = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        fileURLToPath(import.meta.url),
        "--child",
        runtime.outfile,
        JSON.stringify(parameters),
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true },
    );
    if (run.status !== 0)
      throw new Error(`GC weak-reference baseline failed: ${run.stderr}`);
    results.push(JSON.parse(run.stdout));
  }
  const bare = results.filter(
    (result) => result.parameters.treatment === "bare",
  );
  const minorOracleDiscriminates = bare.some((result) =>
    result.observations
      .filter((observation) => observation.requested === "minor")
      .some((observation) => !observation.alive.payload),
  );
  const report = {
    domain:
      "neighbour-clean retired endpoints, matched age schedules and ordinary-node carrier controls",
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    trials,
    runtimeSha256: runtime.sha256,
    minorOracleDiscriminates,
    interpretation: minorOracleDiscriminates
      ? "Minor controls can distinguish reclamation; inspect matched cohort curves."
      : "Even bare WeakRef targets survive all minor requests: minor endpoint-retention attribution is inconclusive. Major reclamation and positive-root controls remain measurable.",
    sources: [
      "https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/extensions/gc-extension.h",
      "https://nodejs.org/api/perf_hooks.html",
    ],
    results,
  };
  writeFileSync(
    path.join(root, "research", "GC-HISTORY.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  const summary = Object.fromEntries(
    ["collected", "retained-after-budget", "invalid"].map((status) => [
      status,
      results.filter((result) => result.status === status).length,
    ]),
  );
  process.stdout.write(JSON.stringify(summary) + "\n");
  process.exitCode = summary.invalid ? 1 : 0;
}
