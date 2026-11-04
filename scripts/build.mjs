// Release build: dist/index.js (ESM), dist/index.cjs (CJS), both with
// source maps, declarations for each format, research counters compiled out.
//
//   node scripts/build.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const require = createRequire(path.join(root, "package.json"));

/** Own devDependency first; inside the Reflex workspace, the one vite brings. */
function load(name) {
  try {
    return require(name);
  } catch {
    const vite = createRequire(require.resolve("vite", { paths: [path.join(root, "../reflex-runtime")] }));
    return vite(name);
  }
}
const esbuild = load("esbuild");
const tsc = (() => {
  try {
    return require.resolve("typescript/bin/tsc");
  } catch {
    return createRequire(path.join(root, "../../package.json")).resolve("typescript/bin/tsc");
  }
})();

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const common = {
  entryPoints: [path.join(root, "src/index.ts")],
  bundle: true,
  platform: "neutral",
  target: "es2022",
  define: { __STATS__: "false" },
  // Full minification (exported names are never mangled); the source maps
  // restore names in traces and profiles.
  minify: true,
  sourcemap: true,
  legalComments: "none",
  banner: { js: `/* reflex-quant ${version} | MIT */` },
  logLevel: "warning",
};
await esbuild.build({ ...common, format: "esm", outfile: path.join(dist, "index.js") });
await esbuild.build({ ...common, format: "cjs", outfile: path.join(dist, "index.cjs") });
// Unminified twin, never published: the release check proves the minified
// build behaves exactly like it.
await esbuild.build({ ...common, minify: false, sourcemap: false, banner: {}, format: "esm", outfile: path.join(root, ".cache/release/plain.js") });

// Declarations: emitted once, then written per format with explicit
// extensions, so node16/bundler resolution finds the right file.
execFileSync(process.execPath, [tsc, "-p", path.join(root, "tsconfig.build.json")], { stdio: "inherit" });
const types = path.join(dist, ".types");
for (const file of readdirSync(types)) {
  const text = readFileSync(path.join(types, file), "utf8");
  const base = file.replace(/\.d\.ts$/, "");
  const withExt = (ext) => text.replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, `$1$2${ext}$3`);
  writeFileSync(path.join(dist, `${base}.d.ts`), withExt(".js"));
  writeFileSync(path.join(dist, `${base}.d.cts`), withExt(".cjs"));
}
rmSync(types, { recursive: true, force: true });
console.log(`built reflex-quant ${version}: ${readdirSync(dist).sort().join(", ")}`);
