// Release check of dist/: both formats load through the exports map and
// behave, no research counter or source import leaked, the declarations
// typecheck as a consumer sees them, and the tarball holds only dist,
// README and LICENSE.
//
//   node scripts/check.mjs        (after node scripts/build.mjs)
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const fail = (message) => {
  throw new Error(`release check: ${message}`);
};

function smoke(api, format) {
  const { signal, computed, effect, get, set, dispose, batch } = api;
  const a = signal(1);
  const b = computed(() => get(a) * 2);
  const seen = [];
  const e = effect(() => void seen.push(get(b)));
  batch(() => {
    set(a, 2);
    set(a, 3);
  });
  dispose(e);
  set(a, 4);
  if (seen.join() !== "2,6") fail(`${format}: effect saw ${seen.join()}`);
  if (get(b) !== 8) fail(`${format}: computed is ${get(b)}`);
}

const esm = await import(pathToFileURL(path.join(root, pkg.exports["."].import.default)).href);
smoke(esm, "esm");
const cjs = createRequire(import.meta.url)(path.join(root, pkg.exports["."].require.default));
smoke(cjs, "cjs");
if (Object.keys(esm).sort().join() !== Object.keys(cjs).sort().join()) fail("esm and cjs export different names");

// Minification changes nothing: the minified build and its unminified twin
// run every bench scenario, and every step returns the same value.
{
  const plain = await import(pathToFileURL(path.join(root, ".cache/release/plain.js")).href);
  const { scenarios } = await import(pathToFileURL(path.join(root, "bench/scenarios.mjs")).href);
  const adapt = (api) => ({
    signal: (v) => {
      const n = api.signal(v);
      return { get: () => api.get(n), set: (x) => api.set(n, x) };
    },
    computed: (fn) => {
      const n = api.computed(fn);
      return { get: () => api.get(n) };
    },
    effect: (fn) => {
      const n = api.effect(fn);
      return () => api.dispose(n);
    },
    batch: api.batch,
  });
  let steps = 0;
  for (const s of scenarios) {
    const a = s.setup(adapt(esm));
    const b = s.setup(adapt(plain));
    for (let i = 1; i <= 300; i++, steps++) {
      const x = a(i);
      const y = b(i);
      if (!Object.is(x, y)) fail(`minified build differs on ${s.id} step ${i}: ${x} vs ${y}`);
    }
  }
  console.log(`minified = unminified on ${scenarios.length} scenarios, ${steps} steps`);
}

for (const file of ["dist/index.js", "dist/index.cjs"]) {
  const code = readFileSync(path.join(root, file), "utf8");
  if (/stats\.|__STATS__/.test(code)) fail(`${file} still carries research counters`);
  if (/from\s*["']\.\.?\/src/.test(code)) fail(`${file} imports source files`);
}

// A consumer project in strict mode, against the shipped declarations.
const tmp = mkdtempSync(path.join(tmpdir(), "reflex-quant-types-"));
try {
  const consumer = path.join(tmp, "use.ts");
  writeFileSync(
    consumer,
    [
      `import { signal, computed, effect, get, set, dispose, type Signal, type Computed } from ${JSON.stringify(path.join(root, "dist/index.js").replaceAll("\\", "/"))};`,
      "const a: Signal<number> = signal(1);",
      "const b: Computed<string> = computed(() => String(get(a)));",
      "const s: string = get(b);",
      "set(a, 2);",
      "dispose(effect(() => void get(b)));",
      "// @ts-expect-error a computed cannot be set",
      "set(b, 'x');",
      "export { s };",
    ].join("\n"),
  );
  const own = createRequire(path.join(root, "package.json"));
  let tsc;
  try {
    tsc = own.resolve("typescript/bin/tsc");
  } catch {
    tsc = createRequire(path.join(root, "../../package.json")).resolve("typescript/bin/tsc");
  }
  execFileSync(process.execPath, [tsc, "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--skipLibCheck", "false", consumer], { stdio: "inherit" });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// What npm would publish.
// npm itself, run by this node: no shell, no .cmd shim.
const npmCli =
  process.env.npm_execpath ??
  [path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), path.join(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find((p) => existsSync(p));
if (npmCli === undefined) fail("npm not found");
const [packed] = JSON.parse(execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }));
const files = packed.files.map((f) => f.path).sort();
const stray = files.filter((f) => !/^(dist\/|README\.md$|LICENSE$|package\.json$)/.test(f));
if (stray.length) fail(`tarball carries ${stray.join(", ")}`);
console.log(`release check ok: esm + cjs smoke, declarations, ${files.length} files, ${(packed.size / 1024).toFixed(1)} KB packed`);
