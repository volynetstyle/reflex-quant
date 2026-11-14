// Isolated try-site ablations and the semantics-preserving check-safe candidate.
// Single worker, shuffled variants, cooldown between workers. --pick narrows
// the variants; --verify-only checks results without collecting timings.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import path from "node:path";
import * as esbuild from "esbuild";
import ts from "typescript";
import { format } from "prettier";
import { suites } from "../bench/suites.mjs";
import {
  representationVariants,
  representationWorkloads,
} from "./representation-variants.mjs";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".cache/try-sites");
const args = process.argv.slice(2);
const value = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const rounds = Number(value("--rounds", "2"));
const cooldown = Number(value("--cooldown", "2000"));
const label = value("--label", "local");
const seedInput = Number(value("--seed", "625341585"));
if (
  !Number.isInteger(rounds) ||
  rounds < 1 ||
  !Number.isFinite(cooldown) ||
  cooldown < 0 ||
  !/^[a-z0-9-]+$/.test(label) ||
  !Number.isInteger(seedInput)
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
let variants = [{ name: "baseline", ids: [] }];
for (const site of sites)
  variants.push({ name: `single-${site.id}`, ids: [site.id] });
for (let n = 1; n <= 10; n++)
  variants.push({
    name: `cumulative-${n}`,
    ids: sites.slice(0, n).map((s) => s.id),
  });
variants.push({ name: "baseline-control", ids: [] });
variants.push({ name: "check-safe", ids: [] });
variants.push(...representationVariants);
const pick = value("--pick", "all");
if (pick !== "all") {
  const names = pick.split(",");
  if (
    new Set(names).size !== names.length ||
    names[0] !== "baseline" ||
    names.some((name) => !variants.some((v) => v.name === name))
  )
    throw new Error("invalid --pick (put baseline first)");
  variants = names.map((name) => variants.find((v) => v.name === name));
}
const artifacts = [];
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
        cursor = ts.isSourceFile(node) ? 0 : node.getStart(source);
      ts.forEachChild(node, (child) => {
        const start = child.getStart(source);
        result += text.slice(cursor, start) + render(child);
        cursor = child.end;
      });
      return result + text.slice(cursor, node.end);
    };
    let result = render(source);
    if (variant.transform) {
      const transformed = variant.transform(file, result);
      if (transformed !== result)
        result = await format(transformed, {
          ...JSON.parse(
            readFileSync(path.join(root, ".prettierrc.json"), "utf8"),
          ),
          parser: "typescript",
        });
    }
    if (file === "host.ts" && variant.name === "check-safe") {
      const site = sites.find((s) => s.id === 4);
      if (site.function !== "deliver" || site.file !== "host.ts")
        throw new Error("site 4 moved");
      let boundary;
      const find = (node) => {
        if (ts.isTryStatement(node) && node.getStart(source) === site.start)
          boundary = node;
        ts.forEachChild(node, find);
      };
      find(source);
      const original = boundary.getText(source);
      if (result.split(original).length !== 2)
        throw new Error("non-unique deliver boundary");
      result = result.replace(original, "checkSafe(w);");
      const anchor = "function deliver(w: Node, flags: Flags): void {";
      if (result.split(anchor).length !== 2)
        throw new Error("non-unique deliver declaration");
      const deliver = source.statements.find(
        (node) =>
          ts.isFunctionDeclaration(node) && node.name?.text === "deliver",
      );
      const insert = deliver.getFullStart();
      const helper = `\n\nfunction checkSafe(w: Node): void {\n${original.replace(/\r?\n {4}/g, "\n").replace(/^/gm, "  ")}\n}`;
      result = result.slice(0, insert) + helper + result.slice(insert);
    }
    if (
      ts.createSourceFile(file, result, ts.ScriptTarget.Latest, true)
        .parseDiagnostics.length
    )
      throw new Error(`invalid ${variant.name}/${file}`);
    writeFileSync(path.join(src, file), result);
  }
  writeFileSync(
    path.join(out, variant.name, "tsconfig.json"),
    JSON.stringify(
      { extends: "../../../tsconfig.json", include: ["src"] },
      null,
      2,
    ) + "\n",
  );
  const buildBundle = async (stats) =>
    esbuild.build({
      entryPoints: [
        path.join(
          root,
          stats ? "bench/adapters/quant-stats.mjs" : "bench/adapters/quant.mjs",
        ),
      ],
      bundle: true,
      format: "esm",
      platform: "neutral",
      minifySyntax: true,
      minifyWhitespace: true,
      minifyIdentifiers: true,
      target: "es2022",
      define: { __STATS__: String(stats), __DEV__: "false" },
      plugins: [
        {
          name: "runtime",
          setup(build) {
            build.onResolve(
              { filter: /^\.\.\/\.\.\/src\/[^/]+\.ts$/ },
              (args) => ({
                path: path.join(src, path.basename(args.path)),
              }),
            );
          },
        },
      ],
      outfile: path.join(out, variant.name, stats ? "stats.mjs" : "index.mjs"),
      sourcemap: "external",
      logLevel: "warning",
    });
  await buildBundle(false);
  if (args.includes("--structure-only")) await buildBundle(true);
  const bundle = readFileSync(path.join(out, variant.name, "index.mjs"));
  artifacts.push({
    name: variant.name,
    sha256: createHash("sha256").update(bundle).digest("hex"),
    bytes: bundle.length,
  });
}
if (
  variants.some((v) => v.name === "baseline-control") &&
  artifacts.find((v) => v.name === "baseline").sha256 !==
    artifacts.find((v) => v.name === "baseline-control").sha256
)
  throw new Error("A/A control differs from baseline");
writeFileSync(
  path.join(out, "sites.json"),
  JSON.stringify({ sites, variants, artifacts }, null, 2),
);
console.log(JSON.stringify(sites));
if (args.includes("--prepare-only")) process.exit();
if (args.includes("--structure-only")) {
  const structure = {};
  for (const variant of variants) {
    const api = await import(
      pathToFileURL(path.join(out, variant.name, "stats.mjs")).href
    );
    structure[variant.name] = [];
    for (const suite of ["mechanisms", "scenarios"])
      for (const scenario of suites[suite]) {
        const step = scenario.setup(api);
        for (let i = 1; i <= 64; i++) step(i);
        const before = { ...api.stats };
        let checksum = 7;
        for (let i = 65; i <= 320; i++)
          checksum = (Math.imul(checksum, 31) + (Number(step(i)) | 0)) | 0;
        structure[variant.name].push({
          suite,
          id: scenario.id,
          checksum,
          counters: Object.fromEntries(
            Object.keys(api.stats).map((key) => [
              key,
              api.stats[key] - before[key],
            ]),
          ),
          stackHighWater: api.stackHighWater(),
        });
      }
    if (
      JSON.stringify(structure[variant.name]) !==
      JSON.stringify(structure.baseline)
    )
      throw new Error(`${variant.name}: structural work differs from baseline`);
  }
  writeFileSync(
    path.join(out, "structure.json"),
    JSON.stringify(structure, null, 2) + "\n",
  );
  console.log(
    `Exact structural counters and answers match across ${variants.length} variants and 44 scenarios.`,
  );
  process.exit();
}
const ids = [
  "push.chain-cutoff-100",
  "push.effects-1000",
  "pull.recompute-chain-100",
  "pull.diamond-1000",
];
const filter = value("--scenario", "all");
const suite = value("--suite", "mechanisms");
if (!["mechanisms", "scenarios"].includes(suite))
  throw new Error("invalid --suite");
const area = value("--area", "none");
if (area !== "none" && !representationWorkloads[area])
  throw new Error("invalid --area");
const scenarios =
  area !== "none"
    ? representationWorkloads[area].map(([suite, id]) => ({
        ...suites[suite].find((s) => s.id === id),
        suite,
      }))
    : suites[suite]
        .filter((s) =>
          filter === "all"
            ? args.includes("--all-workloads") ||
              suite === "scenarios" ||
              ids.includes(s.id)
            : s.id === filter,
        )
        .map((s) => ({ ...s, suite }));
const only = new RegExp(value("--only", "."));
for (let i = scenarios.length - 1; i >= 0; i--)
  if (!only.test(scenarios[i].id)) scenarios.splice(i, 1);
if (!scenarios.length) throw new Error(`unknown scenario ${filter}`);
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
        scenario.suite,
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
if (args.includes("--verify-only")) process.exit();
let seed = seedInput >>> 0;
const random = () =>
  (seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) /
  2 ** 32;
const samples = {};
const measurements = [];
const affinity =
  platform() === "linux"
    ? readFileSync("/proc/self/status", "utf8").match(
        /^Cpus_allowed_list:\s*(.*)$/m,
      )?.[1]
    : null;
let workerAffinity = null;
if (args.includes("--require-affinity")) {
  if (!/^\d+$/.test(affinity ?? ""))
    throw new Error(`expected single-CPU affinity, got ${affinity}`);
  workerAffinity = execFileSync(
    process.execPath,
    [
      "-e",
      "console.log(require('node:fs').readFileSync('/proc/self/status','utf8').split('\\n').find(l=>l.startsWith('Cpus_allowed_list:')).split(':')[1].trim())",
    ],
    { encoding: "utf8" },
  ).trim();
  if (workerAffinity !== affinity)
    throw new Error(
      `worker affinity mismatch: ${workerAffinity} vs ${affinity}`,
    );
}
const env = {
  node: process.version,
  v8: process.versions.v8,
  esbuild: esbuild.version,
  commit: process.env.GITHUB_SHA ?? null,
  cpu: cpus()[0]?.model,
  os: `${platform()} ${release()} ${arch()}`,
  affinity,
  workerAffinity,
  seed: seedInput,
  suite,
  area,
  primary: area === "none" ? null : representationWorkloads[area][0][1],
};
for (let round = 0; round < rounds; round++) {
  const pairs = scenarios.flatMap((scenario) =>
    variants.map((variant) => ({ scenario, variant })),
  );
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  for (const [i, { scenario, variant }] of pairs.entries()) {
    const started = new Date().toISOString();
    const result = measure(variant, scenario);
    ((samples[scenario.id] ??= {})[variant.name] ??= []).push(result.nsPerStep);
    measurements.push({
      round,
      order: i,
      scenario: scenario.id,
      variant: variant.name,
      started,
      ...result,
    });
    if ((i + 1) % 10 === 0)
      console.log(`round ${round + 1}/${rounds}: ${i + 1}/${pairs.length}`);
    await new Promise((resolve) => setTimeout(resolve, cooldown));
  }
  writeFileSync(
    path.join(out, `${label}.json`),
    JSON.stringify(
      {
        env,
        node: process.version,
        rounds,
        cooldown,
        sites,
        variants,
        artifacts,
        samples,
        measurements,
      },
      null,
      2,
    ),
  );
}
