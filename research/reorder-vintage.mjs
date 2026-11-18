// Replay the published slot decomposition with its own worker, field names,
// primitives, and allocation order. Only the index treatment changes setup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build, version } from "esbuild";

const revision = "816acde637bf1e6a41c4e890de664a4fd9febd0d";
const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".cache/reorder-vintage");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const files = git("ls-tree", "-r", "--name-only", revision, "src", "bench", "package.json", "package-lock.json").trim().split("\n");
for (const file of files) {
  const local = path.join(out, file);
  mkdirSync(path.dirname(local), { recursive: true });
  writeFileSync(local, git("show", revision + ":" + file));
}
const lock = JSON.parse(readFileSync(path.join(out, "package-lock.json"), "utf8"));
assert.equal(version, lock.packages["node_modules/esbuild"].version, "historical minifier");
const phases = path.join(out, "bench/cost/scenarios.mjs");
const source = readFileSync(phases, "utf8");
const anchor = "const decompose = {";
assert.equal(source.split(anchor).length, 2);
writeFileSync(phases, source.replace(anchor, anchor + `
  ...Object.fromEntries([1, 2, 3].map((phase) => ["index" + phase, (q, n) => {
    const { c, tick } = rawShuffle(q, n);
    q.set(tick, phase);
    q.get(c);
    const { index, clearIndex } = q;
    return (i) => {
      index(c, c.deps);
      clearIndex(c);
      return i & 1;
    };
  }])),
`));
await build({
  entryPoints: [path.join(out, "bench/adapters/quant-internals.ts")],
  outfile: path.join(out, "raw/index.mjs"), bundle: true, format: "esm",
  platform: "neutral", minify: true, target: "es2022",
  define: { __STATS__: "false", __DEV__: "false" },
});
