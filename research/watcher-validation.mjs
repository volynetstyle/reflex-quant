import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const modes = ["development", "production"];
const { values: options } = parseArgs({
  options: {
    mode: { type: "string" },
    strict: { type: "boolean" },
  },
});
if (options.mode !== undefined && !modes.includes(options.mode)) {
  throw new Error("--mode must be development or production");
}
async function bundle(mode) {
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
  { signal, computed, effect, read, compute, set, batch, dispose },
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
    const value = read(a);
    fail("validation");
    return value;
  });
  const right = computed(() => read(b));
  const seen = [];
  const watcher = effect(() => {
    const pair =
      firstRead === "A"
        ? [compute(left), compute(right)]
        : [compute(right), compute(left)].reverse();
    fail("body");
    seen.push(pair);
    return () => fail("cleanup");
  });
  const siblingSeen = [];
  const sibling = secondWatcher
    ? effect(() => {
        siblingSeen.push(compute(right));
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
  const afterNext = seen.slice();
  const recovery = attempt(() => {
    set(a, 3);
    return null;
  }, injected);
  armed = false;
  dispose(watcher);
  if (sibling !== null) dispose(sibling);
  return {
    first,
    afterBatch,
    afterSibling,
    next,
    seen: afterNext,
    recovery,
    afterRecovery: seen,
  };
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
          // A failed check before B was visited consumed this delivery.
          // Another write into B's already-pending path coalesces (D7).
          const coalesced =
            phase === "validation" &&
            firstRead === "A" &&
            !secondWatcher &&
            writeTo === "B";
          const afterNext = coalesced
            ? afterBatch
            : [...afterBatch, writeTo === "A" ? [2, 1] : [1, 2]];
          report(
            {
              family: "delivery",
              contract: ["F4", "F5", "D7"],
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
              seen: afterNext,
              recovery: null,
              afterRecovery: [...afterNext, [3, writeTo === "A" ? 1 : 2]],
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
}

console.log(JSON.stringify({ kind: "summary", cases, violations }));
if (options.strict && violations !== 0) process.exitCode = 1;
