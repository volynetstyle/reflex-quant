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

const esbuild = require("esbuild");
const tsc = require.resolve("typescript/bin/tsc");

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
// Same syntax optimizations as the release, retaining names for inspection.
await esbuild.build({ ...common, minify: false, minifySyntax: true, sourcemap: false, banner: {}, format: "esm", outfile: path.join(root, ".cache/release/inspect.js") });

// Inline the public handle types and the two re-exported signatures so
// neither format needs to publish internal declarations.
execFileSync(process.execPath, [tsc, "-p", path.join(root, "tsconfig.build.json")], { stdio: "inherit" });
const types = path.join(dist, ".types");
let declaration = readFileSync(path.join(types, "index.d.ts"), "utf8");
for (const kind of ["import", "export"]) {
  const line = new RegExp(`^${kind} type \\{[^}]+\\} from "\\./types";\\r?\\n`, "m");
  if (!line.test(declaration)) throw new Error(`missing public type reference: ${kind} type { ... } from "./types"`);
  declaration = declaration.replace(line, "");
}
declaration = readFileSync(path.join(types, "types.d.ts"), "utf8").replace(/^export \{\};\r?\n/m, "") + declaration;
for (const [name, module] of [["batch", "host"], ["untracked", "kernel"]]) {
  const source = readFileSync(path.join(types, `${module}.d.ts`), "utf8");
  const signature = source.match(new RegExp(`^export declare function ${name}[^\\n]+$`, "m"))?.[0];
  const reexport = `export { ${name} } from "./${module}";`;
  if (!signature || !declaration.includes(reexport)) throw new Error(`missing public declaration for ${name}`);
  declaration = declaration.replace(reexport, signature);
}
writeFileSync(path.join(dist, "index.d.ts"), declaration);
writeFileSync(path.join(dist, "index.d.cts"), declaration);
rmSync(types, { recursive: true, force: true });
console.log(`built reflex-quant ${version}: ${readdirSync(dist).sort().join(", ")}`);
