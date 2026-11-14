// Local, intentionally contract-breaking try-site ablations.
// Single worker, shuffled variants, cooldown between workers.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import ts from "typescript";
import { suites } from "../bench/suites.mjs";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".cache/try-sites");
const args = process.argv.slice(2);
const value = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const rounds = Number(value("--rounds", "2"));
const cooldown = Number(value("--cooldown", "2000"));
const label = value("--label", "local");
if (
  !Number.isInteger(rounds) ||
  rounds < 1 ||
  !Number.isFinite(cooldown) ||
  cooldown < 0 ||
  !/^[a-z0-9-]+$/.test(label)
)
  throw new Error("invalid options");
const files = ["kernel.ts", "host.ts", "index.ts"];
const parsed = new Map();
const sites = [];
for (const file of files) {
  const text = readFileSync(path.join(root, "src", file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    ts.forEachChild(node, visit); // Nested sites are removed before their parents cumulatively.
    if (ts.isTryStatement(node)) {
      const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
      let parent = node.parent;
      while (parent && !ts.isFunctionDeclaration(parent))
        parent = parent.parent;
      const id = sites.length + 1;
      sites.push({
        id,
        file,
        line: pos.line + 1,
        function: parent?.name?.text,
        start: node.getStart(source),
      });
    }
  };
  visit(source);
  parsed.set(file, { source, text });
}
if (sites.length !== 10)
  throw new Error(`expected 10 sites, got ${sites.length}`);
const variants = [{ name: "baseline", ids: [] }];
for (const site of sites)
  variants.push({ name: `single-${site.id}`, ids: [site.id] });
for (let n = 1; n <= 10; n++)
  variants.push({
    name: `cumulative-${n}`,
    ids: sites.slice(0, n).map((s) => s.id),
  });
for (const variant of variants) {
  const src = path.join(out, variant.name, "src");
  mkdirSync(src, { recursive: true });
  cpSync(path.join(root, "src"), src, { recursive: true });
  for (const file of files) {
    const { source, text } = parsed.get(file);
    const selected = new Set(
      sites
        .filter((s) => s.file === file && variant.ids.includes(s.id))
        .map((s) => s.start),
    );
    const render = (node) => {
      if (ts.isTryStatement(node) && selected.has(node.getStart(source))) {
        if (node.finallyBlock) {
          if (
            node.tryBlock.getText(source).replace(/\s/g, "") !==
              "{returnfn();}" ||
            node.finallyBlock.getText(source).replace(/\s/g, "") !==
              "{active=prev;}"
          )
            throw new Error("unexpected finally");
          return "{ const result = fn(); active = prev; return result; }";
        }
        return render(node.tryBlock);
      }
      let result = "",
        cursor = node.getStart(source);
      ts.forEachChild(node, (child) => {
        const start = child.getStart(source);
        result += text.slice(cursor, start) + render(child);
        cursor = child.end;
      });
      return result + text.slice(cursor, node.end);
    };
    const result = render(source);
    if (
      ts.createSourceFile(file, result, ts.ScriptTarget.Latest, true)
        .parseDiagnostics.length
    )
      throw new Error(`invalid ${variant.name}/${file}`);
    writeFileSync(path.join(src, file), result);
  }
  await esbuild.build({
    entryPoints: [path.join(root, "bench/adapters/quant.mjs")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    minifySyntax: true,
    minifyWhitespace: true,
    minifyIdentifiers: true,
    target: "es2022",
    define: { __STATS__: "false", __DEV__: "false" },
    plugins: [
      {
        name: "runtime",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/\.\.\/src\/index\.ts$/ }, () => ({
            path: path.join(src, "index.ts"),
          }));
        },
      },
    ],
    outfile: path.join(out, variant.name, "index.mjs"),
    logLevel: "warning",
  });
}
writeFileSync(
  path.join(out, "sites.json"),
  JSON.stringify({ sites, variants }, null, 2),
);
console.log(JSON.stringify(sites));
if (args.includes("--prepare-only")) process.exit();
const ids = [
  "push.chain-cutoff-100",
  "push.effects-1000",
  "pull.recompute-chain-100",
  "pull.diamond-1000",
];
const filter = value("--scenario", "all");
if (filter !== "all" && !ids.includes(filter))
  throw new Error(`unknown scenario ${filter}`);
const scenarios = suites.mechanisms.filter((s) => ids.includes(s.id));
if (filter !== "all")
  scenarios.splice(
    0,
    scenarios.length,
    ...scenarios.filter((s) => s.id === filter),
  );
const worker = path.join(root, "bench/worker.mjs");
const measure = (variant, scenario, verify = false) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--expose-gc",
        worker,
        path.join(out, variant.name),
        scenario.id,
        "--suite",
        "mechanisms",
        ...(verify ? ["--verify"] : []),
      ],
      { encoding: "utf8", timeout: 120000 },
    )
      .trim()
      .split("\n")
      .pop(),
  );
for (const scenario of scenarios) {
  const base = measure(variants[0], scenario, true).checksum;
  for (const v of variants.slice(1))
    if (measure(v, scenario, true).checksum !== base)
      throw new Error(`checksum ${scenario.id} ${v.name}`);
}
console.log("Verified all checksums");
let seed = 0x2545f491;
const random = () =>
  (seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) /
  2 ** 32;
const samples = {};
for (let round = 0; round < rounds; round++) {
  const pairs = scenarios.flatMap((scenario) =>
    variants.map((variant) => ({ scenario, variant })),
  );
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  for (const [i, { scenario, variant }] of pairs.entries()) {
    ((samples[scenario.id] ??= {})[variant.name] ??= []).push(
      measure(variant, scenario).nsPerStep,
    );
    if ((i + 1) % 10 === 0)
      console.log(`round ${round + 1}/${rounds}: ${i + 1}/${pairs.length}`);
    await new Promise((resolve) => setTimeout(resolve, cooldown));
  }
  writeFileSync(
    path.join(out, `${label}.json`),
    JSON.stringify(
      { node: process.version, rounds, cooldown, sites, variants, samples },
      null,
      2,
    ),
  );
}
