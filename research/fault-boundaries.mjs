import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const modes = ["development", "production"];
const narrowPeriod = 8;
const fullPeriod = 2 ** 30;
const { values: options } = parseArgs({
  options: {
    mode: { type: "string" },
    "full-period": { type: "boolean" },
    strict: { type: "boolean" },
  },
});
if (options.mode !== undefined && !modes.includes(options.mode)) {
  throw new Error("--mode must be development or production");
}

// Narrow only the shared producer version increment. Generations and SETTLE have their own
// invariant, and narrowing them here would confound the version experiment.
const narrowVersions = {
  name: "narrow-versions",
  setup(builder) {
    builder.onLoad({ filter: /[\\/]src[\\/]kernel\.ts$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      const increment =
        /(\bn\.ver\s*=\s*\(n\.ver\s*\+\s*1\)\s*&\s*)CounterLimit\.Mask\b/g;
      if ([...source.matchAll(increment)].length !== 1) {
        throw new Error(
          "Update the research transform for the shared version increment",
        );
      }
      const contents = source.replace(
        increment,
        (_, prefix) => prefix + (narrowPeriod - 1),
      );
      return { contents, loader: "ts" };
    });
  },
};

async function bundle(mode, plugins = []) {
  const development = mode === "development";
  const { outputFiles } = await build({
    absWorkingDir: root,
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    define: { __DEV__: String(development), __STATS__: "false" },
    minify: !development,
    minifySyntax: true,
    legalComments: "none",
    write: false,
    plugins,
  });
  return (
    "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
  );
}

let instance = 0;
function freshRuntime(url) {
  // Each continuation has its own graph, host queue, and kernel state.
  return import(`${url}#${++instance}`);
}

function attempt(run, injected) {
  try {
    return run();
  } catch (error) {
    if (injected !== undefined && error === injected)
      return { error: "injected" };
    return {
      error: error?.name ?? typeof error,
      message: error?.message ?? String(error),
    };
  }
}

function delivery(
  { signal, computed, effect, get, set, batch, dispose },
  phase,
  firstRead,
  secondWatcher,
  writeTo,
) {
  const a = signal(0);
  const b = signal(0);
  const injected = new Error(phase);
  let armed = false;
  function fail(at) {
    if (armed && phase === at) {
      armed = false;
      throw injected;
    }
  }

  const left = computed(() => {
    const value = get(a);
    fail("validation");
    return value;
  });
  const right = computed(() => get(b));
  const seen = [];
  const watcher = effect(() => {
    const pair =
      firstRead === "A"
        ? [get(left), get(right)]
        : [get(right), get(left)].reverse();
    fail("body");
    seen.push(pair);
    return () => fail("cleanup");
  });
  const siblingSeen = [];
  const sibling = secondWatcher
    ? effect(() => {
        siblingSeen.push(get(right));
      })
    : null;

  armed = true;
  const first = attempt(() => {
    batch(() => {
      set(a, 1);
      set(b, 1);
    });
    return null;
  }, injected);
  const afterBatch = seen.slice();
  const afterSibling = siblingSeen.slice();
  const next = attempt(() => {
    set(writeTo === "A" ? a : b, 2);
    return null;
  }, injected);
  armed = false;
  dispose(watcher);
  if (sibling !== null) dispose(sibling);
  return { first, afterBatch, afterSibling, next, seen };
}

function spine(api, depth, topology, inject, continuation) {
  const { signal, computed, effect, get, set, dispose } = api;
  const source = signal(0);
  const injected = new Error("leaf");
  let armed = inject;
  const leaf = computed(() => {
    const value = get(source);
    if (value === 1 && armed) {
      armed = false;
      throw injected;
    }
    return value;
  });
  const chain = [leaf];
  get(leaf);
  for (let i = 1; i < depth; i++) {
    const child = chain[i - 1];
    const parent = computed(() => {
      if (topology === "shared-signal") get(source);
      return get(child) + 1;
    });
    get(parent);
    chain.push(parent);
  }
  const tip = chain.at(-1);

  const first = attempt(() => {
    set(source, 1);
    return get(tip);
  }, injected);
  const next = attempt(() => {
    if (continuation === "write") set(source, 2);
    if (continuation === "bottom-up") {
      for (const node of chain) get(node);
    }
    if (continuation === "independent-graph") {
      const other = signal(40);
      const value = computed(() => get(other) + 1);
      const seen = [];
      const watcher = effect(() => {
        seen.push(get(value));
      });
      set(other, 41);
      dispose(watcher);
      return seen;
    }
    return get(tip);
  }, injected);
  return { first, next };
}

function signalVersion({ signal, effect, get, set, dispose }, changes) {
  const source = signal(0);
  const observed = [];
  const watcher = effect(() => {
    const value = get(source);
    observed.push(value);
    if (value === 0) {
      for (let commit = 1; commit <= changes; commit++) set(source, commit);
    }
  });
  dispose(watcher);
  return { observed, committed: get(source) };
}

function computedVersion({ signal, computed, get, set }, changes) {
  const source = signal(0);
  const publisher = computed(() => get(source));
  const observer = computed(() => get(publisher));
  get(observer);
  let committed;
  for (let commit = 1; commit <= changes; commit++) {
    set(source, commit);
    committed = get(publisher);
  }
  return { observed: get(observer), committed };
}

let cases = 0;
let violations = 0;
function report(context, expected, observed) {
  const mismatches = Object.keys(expected).filter(
    (key) => !isDeepStrictEqual(expected[key], observed[key]),
  );
  cases++;
  if (mismatches.length > 0) violations++;
  console.log(
    JSON.stringify({
      kind: "case",
      ...context,
      expected,
      observed,
      mismatches,
    }),
  );
}

console.log(
  JSON.stringify({
    kind: "environment",
    node: process.versions.node,
    v8: process.versions.v8,
    options,
  }),
);
for (const mode of options.mode === undefined ? modes : [options.mode]) {
  const runtime = await bundle(mode);
  for (const phase of ["none", "validation", "cleanup", "body"]) {
    for (const firstRead of ["A", "B"]) {
      for (const secondWatcher of [false, true]) {
        for (const writeTo of ["A", "B"]) {
          const afterBatch =
            phase === "none"
              ? [
                  [0, 0],
                  [1, 1],
                ]
              : [[0, 0]];
          report(
            {
              family: "delivery",
              contract: ["F4", "F5"],
              mode,
              phase,
              firstRead,
              secondWatcher,
              writeTo,
            },
            {
              first: phase === "none" ? null : { error: "injected" },
              afterBatch,
              afterSibling: secondWatcher ? [0, 1] : [],
              next: null,
              seen: [...afterBatch, writeTo === "A" ? [2, 1] : [1, 2]],
            },
            delivery(
              await freshRuntime(runtime),
              phase,
              firstRead,
              secondWatcher,
              writeTo,
            ),
          );
        }
      }
    }
  }

  for (const depth of [32, 100_000]) {
    for (const [topology, inject] of [
      ["leaf", false],
      ["leaf", true],
      ["shared-signal", false],
    ]) {
      for (const continuation of [
        "demand",
        "write",
        "bottom-up",
        "independent-graph",
      ]) {
        const next =
          continuation === "independent-graph"
            ? [41, 42]
            : depth + Number(continuation === "write");
        report(
          {
            family: "spine",
            contract: ["S7"],
            mode,
            depth,
            topology,
            inject,
            continuation,
          },
          { first: inject ? { error: "injected" } : depth, next },
          spine(
            await freshRuntime(runtime),
            depth,
            topology,
            inject,
            continuation,
          ),
        );
      }
    }
  }

  const full = options["full-period"];
  const period = full ? fullPeriod : narrowPeriod;
  const versionRuntime = full ? runtime : await bundle(mode, [narrowVersions]);
  for (const offset of full ? [0] : [-1, 0, 1]) {
    const changes = period + offset;
    const signalApi = await freshRuntime(versionRuntime);
    report(
      {
        family: "version",
        contract: ["P5"],
        mode,
        source: "signal",
        period,
        changes,
      },
      { observed: [0, changes], committed: changes },
      attempt(() => signalVersion(signalApi, changes)),
    );
    const computedApi = await freshRuntime(versionRuntime);
    report(
      {
        family: "version",
        contract: ["P1"],
        mode,
        source: "computed",
        period,
        changes,
      },
      { observed: changes, committed: changes },
      attempt(() => computedVersion(computedApi, changes)),
    );
  }
}

console.log(JSON.stringify({ kind: "summary", cases, violations }));
if (options.strict && violations !== 0) process.exitCode = 1;
