// The external audit of 1.2.0 as a regression corpus: fetch its repro
// scripts at a pinned commit, run each against release-style PROD and DEV
// bundles of `src/`, and compare exit codes with the verdicts recorded in
// LOG ("Audit Q2 and Q3: contract boundaries").
//
//   node research/audit-corpus.mjs [--src <dir>]
//
// Source: PeshoVurtoleta/reflex-quant, research/audit-2026-11-19 at
// AUDIT_COMMIT. Git fetches the commit by SHA, so the scripts are exactly
// the ones the audit ran. They are written to .cache/audit-corpus/ and are
// never part of this repository.
//
// Script exit codes: 1 = reproduced, 0 = not reproduced, 2 = error or a
// failed control. Expected verdicts:
//   fixed     must exit 0 (the defect is repaired)
//   boundary  must exit 1 (the contract places the behaviour outside an
//             obligation; the script keeps reporting it)
//   outside   0 or 1 accepted (native stack exhaustion, outside the
//             contract; the outcome depends on the engine), 2 still fails
// This runner exits 1 if any script disagrees, and 0 otherwise.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const AUDIT_REPO = "https://github.com/PeshoVurtoleta/reflex-quant.git";
const AUDIT_COMMIT = "5d292745966d4893863aa98a5e35c0d7cfb07c4b";
const REPRO = "research/audit-2026-11-19/repro";

const root = path.resolve(import.meta.dirname, "..");
const cache = path.join(root, ".cache/audit-corpus");
const require = createRequire(path.join(root, "package.json"));

const srcAt = process.argv.indexOf("--src");
const src = srcAt < 0 ? path.join(root, "src") : path.resolve(process.argv[srcAt + 1]);

/** finding directory -> verdict; `scripts` overrides one script. */
const verdicts = {
  "Q1-dispose-during-check": "fixed",
  "Q2-failed-effect-rerun-in-drain": "boundary", // W5 rollback at drain end
  "Q4-self-dispose-run-discarded": "fixed",
  "RQ1-lost-delivery-stale-node": "fixed",
  "RQ2-prod-only-duplicate-run": "fixed",
  "RQ3-p4-recheck-skipped": "fixed",
  "RQ4-dirty-recursion-s7": "fixed",
  "RQ5-version-wrap": "fixed",
  "RQ6-stack-overflow-wedges": "outside",
};
const scripts = {
  // RQ1 shape a: a failed watcher validation is a barrier (D7).
  "ledger-a-failed-check-deaf.mjs": "boundary",
  "neon-lost-delivery.mjs": "boundary",
  "root-lost-delivery.mjs": "boundary",
  // Exit code is RQ1c's (fixed after the attach handoff), but the script
  // also prints Q3's single observation, now a P3/D6 boundary; the glitch
  // line keeps it at 1.
  "neon-verify-stale-glitch.mjs": "boundary",
};

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
}

function fetchCorpus() {
  try {
    git("cat-file", "-e", `${AUDIT_COMMIT}^{commit}`);
  } catch {
    git("fetch", "--no-tags", "--quiet", AUDIT_REPO, AUDIT_COMMIT);
  }
  const files = git("ls-tree", "-r", "--name-only", AUDIT_COMMIT, REPRO)
    .split("\n")
    .filter((f) => f.endsWith(".mjs"));
  const dir = path.join(cache, "repro");
  rmSync(dir, { recursive: true, force: true });
  const out = [];
  for (const file of files) {
    // Scripts that import a bare path fail on Windows; give them a file URL.
    const text = git("show", `${AUDIT_COMMIT}:${file}`).replaceAll(
      "await import(build",
      'await import((await import("node:url")).pathToFileURL(build).href',
    );
    const rel = path.relative(REPRO, file);
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
    out.push({ finding: rel.split(/[\\/]/)[0], name: path.basename(rel), path: target });
  }
  return out;
}

/**
 * The audit's scripts call the unified `get` of 1.2.0. Since 2.0 a signal is
 * read with `read` and a computed with `compute`; this entry gives the pinned
 * scripts their `get` on top of both, choosing by handle kind, so the corpus
 * keeps testing semantics rather than the API's spelling. With sources that
 * still export `get` (an older `--src`), theirs is used.
 */
const compatibility = (index) => `export * from ${JSON.stringify(index)};
import * as q from ${JSON.stringify(index)};
export const get = q.get ?? ((h) => (q.typeOf(h) === "computed" ? q.compute(h) : q.read(h)));
`;

async function bundle(dev) {
  const esbuild = require("esbuild");
  const outfile = path.join(cache, "build", dev ? "dev.js" : "prod.js");
  await esbuild.build({
    stdin: {
      contents: compatibility(path.join(src, "index.ts").replaceAll("\\", "/")),
      resolveDir: src,
      loader: "js",
    },
    bundle: true,
    platform: "neutral",
    target: "es2022",
    format: "esm",
    minify: !dev,
    define: { __STATS__: "false", __DEV__: dev ? "true" : "false" },
    logLevel: "warning",
    outfile,
  });
  return outfile;
}

const corpus = fetchCorpus();
const builds = { prod: await bundle(false), dev: await bundle(true) };
let failures = 0;

for (const { finding, name, path: script } of corpus) {
  const verdict = scripts[name] ?? verdicts[finding];
  if (verdict === undefined) throw new Error(`no verdict for ${finding}/${name}`);
  const codes = {};
  for (const [mode, build] of Object.entries(builds)) {
    const r = spawnSync(process.execPath, [script, build], { cwd: cache, encoding: "utf8", timeout: 300_000 });
    codes[mode] = r.status ?? "killed";
  }
  const ok = Object.values(codes).every((c) =>
    verdict === "fixed" ? c === 0 : verdict === "boundary" ? c === 1 : c === 0 || c === 1,
  );
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${verdict.padEnd(8)} prod ${codes.prod} dev ${codes.dev}  ${finding}/${name}`);
}

console.log(`${corpus.length} scripts at ${AUDIT_COMMIT.slice(0, 7)}, node ${process.versions.node}: ${failures} disagree`);
process.exitCode = failures === 0 ? 0 : 1;
