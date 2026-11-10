// Bundles for the cost probes, into .cache/cost/<name>/index.mjs.
//
//   node bench/build.mjs && node bench/cost/build.mjs
//
// quant-internals  raw-handle API, kernel/graph primitives (decompose, leaf)
// lb-<variant>     quant behind the neutral adapter, with one constant-factor
//                  mechanism removed or replaced (lower bounds, not proposals);
//                  lb-identity has no edit, as a control for cell noise
// surface-<v>      host/surface A/B candidates: raw API (surface-<v>) and the
//                  neutral adapter (surface-<v>-api); semantics unchanged
//
// Lower-bound variants are exact on the lb.* workloads (one consumer, no
// nesting), which run.mjs checks by checksum before timing; elsewhere they may
// be wrong. Edits use the convention of research/mutants.mjs: blank lines are
// dropped first, and each `find` must occur exactly once. Source copies stay
// in .cache/cost/src/<id> (QUANT_SRC=<dir> runs the test suite against one).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const out = path.join(root, ".cache/cost");
const esbuild = createRequire(path.join(root, "package.json"))("esbuild");
const F = "graph.ts";
const T = "kernel.ts";
const K = "kernel.ts";
const H = "host.ts";
const I = "index.ts";

const prefixScan =
  "    let p = last !== null ? last.prev : null;\n    budget = SCAN;\n    while (p !== null && p.from !== s && --budget !== 0) p = p.prev;\n    if (p !== null && p.from === s) {\n      if (__STATS__) stats.dups++;\n      return;\n    }\n";
const displaced = [
  [K, "  const cell = s.slot;\n  if (cell !== null) stack[top++] = cell;\n  s.slot = e;", "  s.slot = e;"],
];
const firstMiss = [
  [T, "  const first = s.subs;", "  index(c, next);\n  return slot(c, s, last, next);\n  const first = s.subs;"],
];

/** variant -> [what it removes, ...edits] */
export const variants = {
  identity: ["no edit: the same bytes as quant (control for the noise of one cell)"],
  "scan-1": ["bounded scans look at one edge (SCAN = 8 -> 1)", [F, "export const SCAN = 8;", "export const SCAN = 1;"]],
  "no-absent": ["no source-side absence proof: an unproven miss indexes", [T, "  return null;\n}", "  return undefined;\n}"]],
  "no-prefix-scan": ["no backward scan for a repeated read: repeats go to the index", [T, prefixScan, "    const p = last;\n"]],
  "index-first-miss": ["the first miss indexes at once: no fresh-source, scan or absence steps", ...firstMiss],
  "no-displaced": ["no save/restore of displaced slot cells (nesting unsupported)", ...displaced],
  lean: ["index-first-miss and no-displaced together", ...firstMiss, ...displaced],
};

const setGuard = "  write(source as unknown as Node, value);\n  if (size !== 0 && !draining && depth === 0) drainNow();";
const hostImport = 'import { depth, drainNow, draining, size, start, stop, watcher } from "./host";';
const withFlush = 'import { depth, drainNow, draining, flush, size, start, stop, watcher } from "./host";';
const setFlush = [
  [I, hostImport, withFlush],
  [I, setGuard, "  write(source as unknown as Node, value);\n  flush();"],
];

/**
 * The public write and read paths against the release (current: set tests
 * the queue at the call site, LOG 27; get and peek are kernel read and peek
 * under the public type, LOG 30). flush-call and get-function are the earlier
 * forms, kept as regression guards; size-first and commit, measured in two
 * runs (research/COST-MODEL.md), are retired. None changes an answer: run.mjs
 * requires equal checksums, and the test suite runs against each source copy
 * (QUANT_SRC=.cache/cost/src/surface-<v>).
 */
export const surfaceVariants = {
  current: ["set tests the queue at the call site: as released"],
  "flush-call": ["set calls flush() (previous release)", ...setFlush],
  "get-function": [
    "get and peek as surface functions around kernel read and peek (previous release)",
    [I, "export const get: <T>(source: Readable<T>) => T = read as never;", "export function get<T>(source: Readable<T>): T {\n  return read(source as unknown as Node) as T;\n}"],
    [I, "export const peek: <T>(source: Readable<T>) => T = refresh as never;", "export function peek<T>(source: Readable<T>): T {\n  return refresh(source as unknown as Node) as T;\n}"],
  ],
};

/**
 * Representation candidates for global reorders, against the release (LOG 28:
 * a pass whose first unresolved miss finds the pair among the source's first
 * subscribers marks its unread suffix and finds pairs through subscribers).
 * The release marks only when the pair is the source's first subscriber.
 * index-always and mark-any are the two earlier rules. Exact: the semantic
 * and differential suites pass on each copy; the structural tests that pin
 * LOG 28 and 29 fail on them by design.
 */
export const reorderVariants = {
  "index-always": [
    "release 59f7085: a pair found among the subscribers indexes the pass",
    [T, "  if (e !== first) return index(c, next);", "  return index(c, next);"],
  ],
  "refresh-repeats": [
    "release dd13a76, before P5: a repeated read refreshes the observed version (fails the P5 semantic tests; kept to time the change)",
    [T, "      if (__STATS__) stats.repeats++;\n      return;", "      if (__STATS__) stats.repeats++;\n      last.ver = s.ver;\n      return;"],
    [T, "      if (__STATS__) stats.dups++;\n      return;\n    }", "      if (__STATS__) stats.dups++;\n      p.ver = s.ver;\n      return;\n    }"],
    [T, "  if (e.ver !== UNREAD) {\n    if (__STATS__) stats.dups++;\n    return;", "  if (e.ver !== UNREAD) {\n    if (__STATS__) stats.dups++;\n    e.ver = s.ver;\n    return;"],
  ],
  "mark-any": [
    "release 7b14509: a pair found anywhere within the budget marks the pass (deeper pairs walk other readers' edges per read)",
    [T, "  if (e !== first) return index(c, next);\n", ""],
  ],
};

async function bundle(name, entry, plugins = [], stats = false) {
  const dir = path.join(out, name);
  mkdirSync(dir, { recursive: true });
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    minify: true,
    target: "es2022",
    define: { __STATS__: String(stats), __DEV__: "false" },
    plugins,
    outfile: path.join(dir, "index.mjs"),
    logLevel: "warning",
  });
}

function variantSource(id, edits) {
  const dir = path.join(out, "src", id);
  rmSync(dir, { recursive: true, force: true });
  cpSync(path.join(root, "src"), dir, { recursive: true });
  for (const [file, find, replace] of edits) {
    const target = path.join(dir, file);
    const text = readFileSync(target, "utf8").replace(/\r?\n([ \t]*\r?\n)+/g, "\n");
    const at = text.indexOf(find);
    if (at < 0 || text.indexOf(find, at + 1) >= 0) throw new Error(`${id}: edit not found once in ${file}: ${find.slice(0, 60)}`);
    writeFileSync(target, text.slice(0, at) + replace + text.slice(at + find.length));
  }
  return dir;
}

/** Resolve an adapter's `../../src/<file>.ts` imports to a variant's copy. */
const redirect = (dir) => ({
  name: "variant-src",
  setup(build) {
    build.onResolve({ filter: /[\\/]src[\\/][\w-]+\.ts$/ }, (args) => ({ path: path.join(dir, path.basename(args.path)) }));
  },
});

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  rmSync(out, { recursive: true, force: true });
  await bundle("quant-internals", path.join(root, "bench/adapters/quant-internals.ts"));
  for (const [id, [, ...edits]] of Object.entries(variants)) {
    await bundle(`lb-${id}`, path.join(root, "bench/adapters/quant.mjs"), [redirect(variantSource(id, edits))]);
  }
  for (const [id, [, ...edits]] of Object.entries(surfaceVariants)) {
    const dir = variantSource(`surface-${id}`, edits);
    await bundle(`surface-${id}`, path.join(root, "bench/adapters/quant-internals.ts"), [redirect(dir)]);
    await bundle(`surface-${id}-api`, path.join(root, "bench/adapters/quant.mjs"), [redirect(dir)]);
  }
  for (const [id, [, ...edits]] of Object.entries(reorderVariants)) {
    const dir = variantSource(`rv-${id}`, edits);
    await bundle(`rv-${id}`, path.join(root, "bench/adapters/quant.mjs"), [redirect(dir)]);
    await bundle(`rv-${id}-stats`, path.join(root, "bench/adapters/quant-stats.mjs"), [redirect(dir)], true);
  }
  const names = [
    ...Object.keys(variants).map((v) => `lb-${v}`),
    ...Object.keys(surfaceVariants).map((v) => `surface-${v}`),
    ...Object.keys(reorderVariants).map((v) => `rv-${v}`),
  ];
  console.log(`cost bundles: quant-internals, ${names.join(", ")}`);
}
