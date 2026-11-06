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
const F = "flags.ts";
const T = "tracking.ts";
const K = "kernel.ts";
const H = "host.ts";
const I = "index.ts";

const prefixScan =
  "    let p = last !== null ? last.prev : null;\n    budget = SCAN;\n    while (p !== null && p.from !== s && --budget !== 0) p = p.prev;\n    if (p !== null && p.from === s) {\n      if (__STATS__) stats.dups++;\n      p.ver = s.ver;\n      return;\n    }\n";
const displaced = [
  [K, "    const s = e.from;\n    if (s.slot !== null) {\n      stack[top++] = s;\n      stack[top++] = s.slot;\n    }\n    s.slot = e;", "    const s = e.from;\n    s.slot = e;"],
  [K, "  if (indexed) {\n    if (s.slot !== null) {\n      stack[top++] = s;\n      stack[top++] = s.slot;\n    }\n    s.slot = e;", "  if (indexed) {\n    s.slot = e;"],
];
const firstMiss = [
  [T, "  if ((f & Flag.Marked) === 0) {\n    // A source without subscribers is absent.", "  index(c, next);\n  return slot(c, s, last, next);\n  if ((f & Flag.Marked) === 0) {\n    // A source without subscribers is absent."],
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
 * Candidates for the public write and read paths, against the release
 * (current: set tests the queue at the call site, LOG 27). flush-call is the
 * previous release's set; size-first is that set with flush's guard
 * reordered (queue first), so flush-call -> size-first is the guard order
 * and size-first -> current the call. commit moves the same guard into one
 * host function; get-alias removes the surface function around kernel read.
 * None changes an answer: run.mjs requires equal checksums, and the test
 * suite runs against each source copy (QUANT_SRC=.cache/cost/src/surface-<v>).
 */
export const surfaceVariants = {
  current: ["set tests the queue at the call site: as released"],
  "flush-call": ["set calls flush() (previous release)", ...setFlush],
  "size-first": ["set calls flush(), whose guard tests the queue first", ...setFlush, [H, "  if (draining || depth !== 0 || size === 0) return;", "  if (size === 0 || draining || depth !== 0) return;"]],
  commit: [
    "one host function: write, then the queue guard",
    [H, 'import { check, dispose, exec, node, onWake, untracked } from "./kernel";', 'import { check, dispose, exec, node, onWake, untracked, write } from "./kernel";'],
    [H, "export function flush(): void {", "export function commit(n: Node, value: unknown): void {\n  write(n, value);\n  if (size !== 0 && !draining && depth === 0) drainNow();\n}\nexport function flush(): void {"],
    [I, hostImport, 'import { commit, depth, drainNow, draining, size, start, stop, watcher } from "./host";'],
    [I, setGuard, "  commit(source as unknown as Node, value);"],
  ],
  "get-alias": [
    "get is kernel read itself, under the public type",
    [I, "export function get<T>(source: Readable<T>): T {\n  return read(source as unknown as Node) as T;\n}", "export const get = read as unknown as <T>(source: Readable<T>) => T;"],
  ],
};

/**
 * Representation candidates for global reorders, against the release (LOG 28:
 * a pass whose first unresolved miss finds the pair among the source's first
 * subscribers marks its unread suffix and finds pairs through subscribers).
 * The release marks only when the pair is the source's first subscriber.
 * index-always and mark-any are the two earlier rules. Exact everywhere; the
 * test suite runs against each copy.
 */
export const reorderVariants = {
  "index-always": [
    "release 59f7085: a pair found among the subscribers indexes the pass",
    [T, "  if (e !== s.subs) return index(c, next);", "  return index(c, next);"],
  ],
  "mark-any": [
    "release 7b14509: a pair found anywhere within the budget marks the pass (deeper pairs walk other readers' edges per read)",
    [T, "  if (e !== s.subs) return index(c, next);\n", ""],
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
    define: { __STATS__: String(stats) },
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
