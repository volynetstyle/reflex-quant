// Release check of dist/: both formats load through the exports map and
// behave, no research counter or source import leaked, the declarations
// typecheck as a consumer sees them, and the tarball holds only dist,
// README and LICENSE.
//
//   node scripts/check.mjs        (after node scripts/build.mjs)
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const ts = createRequire(path.join(root, "package.json"))("typescript");
const fail = (message) => {
  throw new Error(`release check: ${message}`);
};

function smoke(api, format) {
  const { signal, computed, effect, get, set, dispose, batch, typeOf } = api;
  const a = signal(1);
  const b = computed(() => get(a) * 2);
  const seen = [];
  const e = effect(() => void seen.push(get(b)));
  if ([typeOf(a), typeOf(b), typeOf(e)].join() !== "signal,computed,effect") fail(`${format}: incorrect handle kinds`);
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
const esmDev = await import(pathToFileURL(path.join(root, pkg.exports["."].import.development)).href);
smoke(esmDev, "esm development");
const cjsDev = createRequire(import.meta.url)(path.join(root, pkg.exports["."].require.development));
smoke(cjsDev, "cjs development");
for (const [api, format] of [[esmDev, "esm development"], [cjsDev, "cjs development"]]) {
  if (Object.keys(api).sort().join() !== Object.keys(esm).sort().join()) fail(`${format} exports different names`);
}

// The build split: the development build diagnoses the C1 precondition, the
// production build carries no diagnosis. What production answers for this
// erroneous program is not a contract; that it answers proves the diagnosis
// was compiled out.
function cycleThroughValidation({ signal, computed, get, set }) {
  const cyclic = signal(false);
  const holder = {};
  const a = computed(() => (get(cyclic) ? get(holder.b) + 1 : 0));
  holder.b = computed(() => get(a) + 1);
  get(holder.b);
  set(cyclic, true);
  try {
    get(holder.b);
    return "answered";
  } catch (error) {
    return error.message;
  }
}
for (const [api, format, expected] of [[esm, "esm", "answered"], [cjs, "cjs", "answered"], [esmDev, "esm development", "Cycle detected"], [cjsDev, "cjs development", "Cycle detected"]]) {
  const got = cycleThroughValidation(api);
  if (got !== expected) fail(`${format}: a cycle through a validating node gave "${got}", expected "${expected}"`);
}
console.log("build split: development diagnoses C1, production carries no diagnosis");

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

// Property names are not mangled by the build. Inspect the counter names in
// the actual minified outputs as well as the named, syntax-optimized twin.
const counterSource = ts.createSourceFile("instrumentation.ts", readFileSync(path.join(root, "src/instrumentation.ts"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const counterDeclaration = counterSource.statements.flatMap((statement) => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []).find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "stats");
if (!counterDeclaration || !counterDeclaration.initializer || !ts.isObjectLiteralExpression(counterDeclaration.initializer)) fail("cannot inspect research counter names");
const counterNames = new Set(counterDeclaration.initializer.properties.map((property) => property.name?.getText(counterSource)));

// Parse the artifacts: no static or dynamic imports, CommonJS require, or
// re-exports from another module.
function checkStandalone(file, rejectCounters = false) {
  const code = readFileSync(path.join(root, file), "utf8");
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) fail(`${file} is not valid JavaScript`);
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) ||
        (ts.isExportDeclaration(node) && node.moduleSpecifier) ||
        (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")))) {
      fail(`${file} references another module`);
    }
    if (ts.isIdentifier(node) && (node.text === "__STATS__" || (rejectCounters && node.text === "stats"))) {
      fail(`${file} still carries research instrumentation`);
    }
    if (ts.isIdentifier(node) && node.text === "__DEV__") fail(`${file} carries an unreplaced __DEV__`);
    if (ts.isIdentifier(node) && node.text === "Flag") fail(`${file} still carries the flag enum`);
    if ((ts.isPropertyAccessExpression(node) && counterNames.has(node.name.text)) ||
        (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && counterNames.has(node.argumentExpression.text)) ||
        (ts.isPropertyAssignment(node) && counterNames.has(node.name.getText(tree)))) {
      fail(`${file} still carries a research counter`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
const expected = [
  "index.cjs", "index.cjs.map", "index.d.cts", "index.d.ts",
  "index.development.cjs", "index.development.cjs.map", "index.development.js", "index.development.js.map",
  "index.js", "index.js.map",
];
if (readdirSync(path.join(root, "dist")).sort().join() !== expected.join()) fail("unexpected files in dist");
for (const file of ["dist/index.js", "dist/index.cjs", "dist/index.development.js", "dist/index.development.cjs", ".cache/release/inspect.js"]) {
  checkStandalone(file, file.endsWith("inspect.js"));
}

// Machine shape of the release: no identity function (a type assertion that
// leaked into runtime as a call), and one allocation site per object shape,
// so V8 sees one Node map and one Edge map.
function checkShape(file) {
  const tree = ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const sites = { node: 0, edge: 0 };
  const returned = (body) => {
    if (ts.isIdentifier(body)) return body.text;
    if (ts.isParenthesizedExpression(body)) return returned(body.expression);
    if (ts.isBlock(body) && body.statements.length === 1 && ts.isReturnStatement(body.statements[0]) && body.statements[0].expression) return returned(body.statements[0].expression);
    return undefined;
  };
  function visit(node) {
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.body &&
        node.parameters.length === 1 && ts.isIdentifier(node.parameters[0].name) && returned(node.body) === node.parameters[0].name.text) {
      fail(`${file} carries an identity function: ${node.getText(tree).slice(0, 60)}`);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set(node.properties.map((p) => p.name?.getText(tree)));
      if (["flags", "value", "ver", "fn", "firstDep", "firstSub", "slot", "gen"].every((k) => keys.has(k))) sites.node++;
      if (["from", "to", "ver", "gen", "prevDep", "nextDep", "prevSub", "nextSub"].every((k) => keys.has(k))) sites.edge++;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (sites.node !== 1 || sites.edge !== 1) fail(`${file}: ${sites.node} Node and ${sites.edge} Edge allocation sites, expected one each`);
}
for (const file of ["dist/index.js", "dist/index.development.js", ".cache/release/inspect.js"]) checkShape(file);
console.log("release shape: no identity functions, one Node and one Edge allocation site");
for (const file of ["index.d.ts", "index.d.cts"]) {
  const tree = ts.createSourceFile(file, readFileSync(path.join(root, "dist", file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (tree.statements.some((node) => ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier))) fail(`${file} references another module`);
}
console.log(`standalone bundles: ${gzipSync(readFileSync(path.join(root, "dist/index.js"))).length} bytes gzip (development build ${gzipSync(readFileSync(path.join(root, "dist/index.development.js"))).length})`);

// A consumer project in strict mode, against the shipped declarations.
const tmp = mkdtempSync(path.join(tmpdir(), "reflex-quant-types-"));
try {
  const consumers = [];
  for (const [extension, entry] of [["mts", "index.js"], ["cts", "index.cjs"]]) {
    const consumer = path.join(tmp, `use.${extension}`);
    consumers.push(consumer);
    writeFileSync(consumer, [
      `import { signal, computed, effect, get, peek, set, update, dispose, typeOf, type Signal, type Computed, type Effect, type Readable } from ${JSON.stringify(path.join(root, "dist", entry).replaceAll("\\", "/"))};`,
      "const a: Signal<number> = signal(1);",
      "const b: Computed<string> = computed(() => String(get(a)));",
      "const e: Effect = effect(() => {});",
      "const signalKind: 'signal' = typeOf(a);",
      "const computedKind: 'computed' = typeOf(b);",
      "const effectKind: 'effect' = typeOf(e);",
      "const either: Signal<number> | Computed<string> | Effect = Math.random() ? a : Math.random() ? b : e;",
      "const eitherKind: 'signal' | 'computed' | 'effect' = typeOf(either);",
      "const mixedSignals: Signal<number> | Signal<string> = Math.random() ? a : signal('x');",
      "const mixedKind: 'signal' | 'computed' | 'effect' = typeOf(mixedSignals);",
      "// @ts-expect-error only reactive handles are accepted",
      "typeOf(42);",
      "export { signalKind, computedKind, effectKind, eitherKind, mixedKind };",
      "const s: string = get(b);",
      "set(a, 2);",
      "dispose(effect(() => void get(b)));",
      "// @ts-expect-error a computed cannot be set",
      "set(b, 'x');",
      "// Reading is covariant: a Signal<number> is a Readable<number | string>.",
      "const r: Readable<number | string> = a;",
      "// @ts-expect-error a signal is written, so it is invariant",
      "const w: Signal<number | string> = a;",
      "export { r, w };",
      "// Seeded computed: prev is T, not T | undefined.",
      "const total: Computed<number> = computed((prev) => prev + get(a), 0);",
      "const p: number = peek(total);",
      "update(a, (v) => v + 1);",
      "// @ts-expect-error update needs a signal",
      "update(total, (v) => v);",
      "// @ts-expect-error without a seed, prev may be undefined",
      "computed((prev: number) => prev + 1);",
      "export { p };",
      "export { s };",
    ].join("\n"));
  }
  const tsc = createRequire(path.join(root, "package.json")).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--skipLibCheck", "false", ...consumers], { stdio: "inherit" });
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
console.log(`release check ok: esm + cjs smoke (production and development), declarations, ${files.length} files, ${(packed.size / 1024).toFixed(1)} KB packed`);
