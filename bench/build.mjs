// Builds one bench bundle per runtime into .cache/bench/<name>/index.mjs.
//
//   node bench/build.mjs [--reflex <commit>]     default: the dev head the experiment was cut from
//
// quant         src/index.ts, counters compiled out, esbuild-minified
// quant-stats   the same with research counters (structure runs only)
// reflex        the runtime's own production oracle bundle of <commit>
//               (scripts/build-baseline-oracle.mjs --production: inline
//               constants, minified like dist) behind bench/adapters/reflex.mjs
// alien         alien-signals 3.2.1 from the workspace, esbuild-minified
// alien-stats   alien with link counters (the lab's instrumentation)
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(root, "../..");
const runtimePkg = path.join(repo, "packages/reflex-runtime");
const out = path.join(root, ".cache/bench");
const args = process.argv.slice(2);
const reflexCommit = args.includes("--reflex") ? args[args.indexOf("--reflex") + 1] : "bf71877";

const esbuild = createRequire(createRequire(path.join(runtimePkg, "package.json")).resolve("vite"))("esbuild");
const alienEntry = createRequire(path.join(repo, "packages/reflex/package.json")).resolve("alien-signals");
const alienEsm = path.join(alienEntry.slice(0, alienEntry.lastIndexOf(`${path.sep}alien-signals${path.sep}`)), "alien-signals/esm");
const alienVersion = JSON.parse(readFileSync(path.join(alienEsm, "../package.json"), "utf8")).version;

async function bundle(name, entry, { stats = false, alias = {} } = {}) {
  const dir = path.join(out, name);
  mkdirSync(dir, { recursive: true });
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    minify: true,
    target: "es2022",
    define: { __QUANT_STATS__: String(stats) },
    alias,
    outfile: path.join(dir, "index.mjs"),
    logLevel: "warning",
  });
  return dir;
}

const manifest = {};

await bundle("quant", path.join(root, "bench/adapters/quant.mjs"));
await bundle("quant-stats", path.join(root, "bench/adapters/quant-stats.mjs"), { stats: true });
manifest.quant = { source: "packages/reflex-runtime-quant/src", minifier: "esbuild" };

// Reflex: the runtime package builds its own production bundle of the commit.
const reflexDir = path.join(out, "reflex");
mkdirSync(reflexDir, { recursive: true });
const oracle = path.join(out, "reflex-oracle");
execFileSync(process.execPath, [path.join(runtimePkg, "scripts/build-baseline-oracle.mjs"), "--commit", reflexCommit, "--production", "--out", oracle], {
  cwd: runtimePkg,
  stdio: ["ignore", "ignore", "inherit"],
});
copyFileSync(path.join(oracle, "runtime.mjs"), path.join(reflexDir, "runtime.mjs"));
copyFileSync(path.join(root, "bench/adapters/reflex.mjs"), path.join(reflexDir, "index.mjs"));
const resolved = execFileSync("git", ["rev-parse", reflexCommit], { cwd: repo, encoding: "utf8" }).trim();
manifest.reflex = { commit: resolved, build: "build-baseline-oracle.mjs --production" };

await bundle("alien", path.join(root, "bench/adapters/alien.mjs"), { alias: { "alien-signals": path.join(alienEsm, "index.mjs") } });
manifest.alien = { version: alienVersion, minifier: "esbuild" };

// alien-stats: the lab's link counters, applied to the same alien sources.
const instrumented = path.join(out, "alien-src");
mkdirSync(instrumented, { recursive: true });
let system = readFileSync(path.join(alienEsm, "system.mjs"), "utf8");
const edit = (find, replace) => {
  if (!system.includes(find)) throw new Error(`alien instrumentation anchor missing: ${find.slice(0, 50)}`);
  system = system.replace(find, replace);
};
edit("export function createReactiveSystem", "export const stats = { linksCreated: 0, linksReused: 0, linksUnlinked: 0 };\nexport function createReactiveSystem");
edit("if (prevDep !== undefined && prevDep.dep === dep) {\n            return;", "if (prevDep !== undefined && prevDep.dep === dep) {\n            stats.linksReused++;\n            return;");
edit("if (nextDep !== undefined && nextDep.dep === dep) {\n            nextDep.version", "if (nextDep !== undefined && nextDep.dep === dep) {\n            stats.linksReused++;\n            nextDep.version");
edit("const newLink = sub.depsTail", "stats.linksCreated++;\n        const newLink = sub.depsTail");
edit("function unlink(link, sub = link.sub) {", "function unlink(link, sub = link.sub) {\n        stats.linksUnlinked++;");
writeFileSync(path.join(instrumented, "system.mjs"), system);
writeFileSync(
  path.join(instrumented, "index.mjs"),
  readFileSync(path.join(alienEsm, "index.mjs"), "utf8") + "\nexport { stats } from './system.mjs';\n",
);
writeFileSync(path.join(instrumented, "adapter.mjs"), readFileSync(path.join(root, "bench/adapters/alien.mjs"), "utf8") + 'export { stats } from "alien-signals";\n');
await bundle("alien-stats", path.join(instrumented, "adapter.mjs"), { alias: { "alien-signals": path.join(instrumented, "index.mjs") } });

writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest));
