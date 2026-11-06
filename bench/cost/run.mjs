// Cost-model probes: where the CPU bills for the architecture.
//
//   node bench/build.mjs && node bench/cost/build.mjs
//   node bench/cost/run.mjs <probe> [--rounds 5] [--only <regex>] [--out <file>] [--verify-only]
//
//   regime       shuffle / reverse at N = 512..8192 on quant, Reflex, alien:
//                ns per N, local growth exponent, collections while sampling;
//                quant's structural work per N, work-stack high-water, heap
//   layout       one shuffle program, four placements: control (allocation
//                order, promoted by a full GC), young (no GC before sampling),
//                scattered (retained padding between nodes and edges),
//                scavenged (promoted through scavenges)
//   decompose    quant: one shuffle pass vs its parts (reads, index + unindex,
//                lookups, moves) and their interaction
//   leaf         get / set by stage, next to the adapters and alien-signals
//   lower-bound  reverse / shuffle / insert-one on quant variants with one
//                constant-factor mechanism removed (bench/cost/build.mjs)
//
// Protocol of bench/run.mjs: every cell (bundle, scenario, flags) runs in a
// fresh process per round, cells in a random order per round, and the value
// is the median over rounds. Cells that run the same scenario on different
// bundles must agree on the 64-step checksum first; a lower-bound variant
// that disagrees is excluded, not timed. Timing counts on CI only; the
// structural columns are machine-independent.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import path from "node:path";
import { variants } from "./build.mjs";
import { DECOMPOSE_SIZES, LAYOUT_SIZES, LOWER_SIZES, OPS, REGIME_SIZES } from "./scenarios.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const probeName = args[0];
const rounds = Number(option("--rounds", 5));
const only = new RegExp(option("--only", "."));
const outFile = option("--out", path.join(root, `.cache/cost/${probeName}.json`));
const worker = path.join(root, "bench/worker.mjs");
const structureWorker = path.join(root, "bench/cost/structure-worker.mjs");

const RUNTIMES = { quant: "bench/quant", reflex: "bench/reflex", alien: "bench/alien" };
const INTERNALS = "cost/quant-internals";
const cell = (label, bundle, id, flags = []) => ({ label, bundle, id, flags, key: `${label}|${id}|${flags.join(" ")}` });
const sizeOf = (id) => Number(id.split("@")[1]);
const perRuntime = (id) => Object.entries(RUNTIMES).map(([r, b]) => cell(r, b, id));

const probes = {
  regime: {
    gc: true,
    structure: true,
    cells: () => ["shuffle", "reverse"].flatMap((f) => REGIME_SIZES.flatMap((n) => perRuntime(`regime.${f}@${n}`))),
    report: regimeReport,
  },
  layout: {
    gc: true,
    cells: () =>
      LAYOUT_SIZES.flatMap((n) =>
        Object.entries(RUNTIMES).flatMap(([r, b]) => [
          cell(`${r}:control`, b, `layout.control@${n}`),
          cell(`${r}:young`, b, `layout.control@${n}`, ["--no-gc"]),
          cell(`${r}:scattered`, b, `layout.scattered@${n}`),
          cell(`${r}:scavenged`, b, `layout.scavenged@${n}`),
        ]),
      ),
    report: layoutReport,
  },
  decompose: {
    independent: true,
    cells: () =>
      ["reads", "index", "lookup", "move", "lookup-move", "full"].flatMap((phase) =>
        DECOMPOSE_SIZES.map((n) => cell(phase, INTERNALS, `decompose.${phase}@${n}`)),
      ),
    report: decomposeReport,
  },
  leaf: {
    independent: true,
    cells: () => [
      ...["read.A-value", "read.B-flags", "read.C-active", "read.D-kernel", "read.E-get"].map((s) => cell(`quant ${s}`, INTERNALS, `leaf.${s}`)),
      ...Object.entries(RUNTIMES).map(([r, b]) => cell(`${r} read.adapter`, b, "leaf.read.adapter")),
      cell("alien read.bare", RUNTIMES.alien, "leaf.read.bare"),
      ...["write.A-is", "write.B-version", "write.C-subs", "write.D-kernel", "write.E-set"].map((s) => cell(`quant ${s}`, INTERNALS, `leaf.${s}`)),
      ...Object.entries(RUNTIMES).map(([r, b]) => cell(`${r} write.adapter`, b, "leaf.write.adapter")),
      cell("alien write.bare", RUNTIMES.alien, "leaf.write.bare"),
    ],
    report: leafReport,
  },
  "lower-bound": {
    cells: () =>
      ["reverse", "shuffle", "insert-one"].flatMap((f) =>
        LOWER_SIZES.flatMap((n) => {
          const id = `lb.${f}@${n}`;
          return [
            cell("quant", RUNTIMES.quant, id),
            ...Object.keys(variants).map((v) => cell(v, `cost/lb-${v}`, id)),
            cell("reflex", RUNTIMES.reflex, id),
            cell("alien", RUNTIMES.alien, id),
          ];
        }),
      ),
    report: lowerReport,
  },
};

const probe = probes[probeName];
if (probe === undefined) throw new Error(`usage: run.mjs <${Object.keys(probes).join("|")}> [--rounds n] [--only regex] [--out file]`);

const json = (script, extra) =>
  JSON.parse(
    execFileSync(process.execPath, ["--expose-gc", script, ...extra], { encoding: "utf8", timeout: 180_000, maxBuffer: 1 << 24 })
      .trim()
      .split("\n")
      .pop(),
  );
const runCell = (c, extra = []) => json(worker, [path.join(root, ".cache", c.bundle), c.id, "--suite", "cost", ...c.flags, ...extra]);

let seed = 0x2545f491;
const random = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
const shuffle = (list) => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};
const median = (xs) => {
  const s = xs.filter((x) => x !== undefined).sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

let cells = probe.cells().filter((c) => only.test(c.id));

// 1. Same program, same answers: per scenario, every bundle against the first.
const excluded = [];
if (!probe.independent) {
  const sums = new Map();
  for (const c of cells) {
    const k = `${c.bundle}|${c.id}`;
    if (!sums.has(k)) sums.set(k, runCell({ ...c, flags: [] }, ["--verify"]).checksum);
  }
  const reference = new Map();
  for (const c of cells) if (!reference.has(c.id)) reference.set(c.id, sums.get(`${c.bundle}|${c.id}`));
  cells = cells.filter((c) => {
    const ok = sums.get(`${c.bundle}|${c.id}`) === reference.get(c.id);
    if (!ok && !excluded.some((x) => x.bundle === c.bundle && x.id === c.id)) excluded.push({ label: c.label, bundle: c.bundle, id: c.id });
    return ok;
  });
  if (excluded.length) process.stderr.write(`excluded (checksum differs): ${excluded.map((x) => `${x.label} ${x.id}`).join(", ")}\n`);
}
if (args.includes("--verify-only")) {
  console.log(`${probeName}: ${cells.length} cells agree; ${excluded.length} excluded`);
  if (excluded.length && probeName !== "lower-bound") process.exitCode = 1;
  process.exit();
}

// 2. Structure (deterministic; once per scenario).
const structure = {};
if (probe.structure) {
  for (const id of new Set(cells.filter((c) => c.label === "quant").map((c) => c.id))) structure[id] = json(structureWorker, [id]);
}

// 3. Timing.
const samples = {};
for (let round = 0; round < rounds; round++) {
  for (const c of shuffle([...cells])) {
    const m = runCell(c, probe.gc ? ["--gc"] : []);
    const s = (samples[c.key] ??= { ns: [], gcPer1k: [], gcCostShare: [], newSpace: [], oldSpace: [] });
    s.ns.push(m.nsPerStep);
    if (m.gc) {
      s.gcPer1k.push((m.gc.events / m.steps) * 1000);
      s.gcCostShare.push((m.gc.costUs * 1000) / (m.nsPerStep * m.steps));
      s.newSpace.push(m.heap.newSpace);
      s.oldSpace.push(m.heap.oldSpace);
    }
  }
  process.stderr.write(`round ${round + 1}/${rounds}\n`);
}
const summary = Object.fromEntries(
  Object.entries(samples).map(([k, s]) => [
    k,
    {
      ns: median(s.ns),
      min: Math.min(...s.ns),
      max: Math.max(...s.ns),
      gcPer1k: median(s.gcPer1k),
      gcCostShare: median(s.gcCostShare),
      newSpace: median(s.newSpace),
      oldSpace: median(s.oldSpace),
    },
  ]),
);
const at = (label, id, flags = []) => summary[`${label}|${id}|${flags.join(" ")}`];

// 4. Report.
const fmt = (ns) => (!Number.isFinite(ns) ? "—" : ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : ns >= 1e3 ? `${(ns / 1e3).toFixed(2)} µs` : `${ns.toFixed(1)} ns`);
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const mb = (b) => (Number.isFinite(b) ? (b / 2 ** 20).toFixed(2) : "—");
const row = (cols) => `| ${cols.join(" | ")} |`;
const head = (cols) => [row(cols), row(cols.map((_, i) => (i === 0 ? "---" : "---:")))];

function regimeReport() {
  const lines = [];
  for (const family of ["shuffle", "reverse"]) {
    const ids = REGIME_SIZES.map((n) => `regime.${family}@${n}`).filter((id) => at("quant", id) || structure[id]);
    if (!ids.length) continue;
    lines.push(`### ${family}`, "", "ns per N, the local growth exponent between neighbouring N (1 = linear), collections per 1000 steps while sampling.", "");
    const rts = Object.keys(RUNTIMES);
    lines.push(...head(["N", ...rts.map((r) => `${r} ns/N`), ...rts.map((r) => `${r} exp`), ...rts.map((r) => `${r} GC/1k`)]));
    ids.forEach((id, k) => {
      const n = sizeOf(id);
      const exp = rts.map((r) => {
        if (k === 0) return "—";
        const prev = ids[k - 1];
        return num(Math.log(at(r, id)?.ns / at(r, prev)?.ns) / Math.log(n / sizeOf(prev)));
      });
      lines.push(row([n, ...rts.map((r) => num(at(r, id)?.ns / n)), ...exp, ...rts.map((r) => num(at(r, id)?.gcPer1k, 1))]));
    });
    lines.push("", `quant structure per step (counters / N), work-stack high-water, heap:`, "");
    lines.push(...head(["N", "reads", "cursor hits", "lookups", "moves", "indexed", "new edges", "removed", "stack hwm", "graph B/N", "new space MB", "old space MB"]));
    for (const id of ids) {
      const n = sizeOf(id);
      const s = structure[id];
      const p = s?.perStep ?? {};
      const t = at("quant", id);
      lines.push(row([n, num(p.reads / n), num(p.hits / n), num(p.lookups / n), num(p.moves / n), num(p.indexed / n), num(p.links / n), num(p.unlinks / n), s?.stackHighWater ?? "—", num(s?.graphBytes / n, 0), mb(t?.newSpace), mb(t?.oldSpace)]));
    }
    lines.push("");
  }
  return lines;
}

function layoutReport() {
  const lines = [];
  const variantsOf = [["control", []], ["young", ["--no-gc"]], ["scattered", []], ["scavenged", []]];
  const idOf = (v, n) => `layout.${v === "young" ? "control" : v}@${n}`;
  for (const r of Object.keys(RUNTIMES)) {
    lines.push(`### ${r}`, "", "ns per N; ratios against control (same program, same code).", "");
    lines.push(...head(["N", ...variantsOf.map(([v]) => v), "young / control", "scattered / control", "scavenged / control", "GC/1k control", "GC/1k young"]));
    for (const n of LAYOUT_SIZES) {
      const t = Object.fromEntries(variantsOf.map(([v, f]) => [v, at(`${r}:${v}`, idOf(v, n), f)]));
      if (!t.control) continue;
      lines.push(
        row([
          n,
          ...variantsOf.map(([v]) => num(t[v]?.ns / n)),
          num(t.young?.ns / t.control.ns),
          num(t.scattered?.ns / t.control.ns),
          num(t.scavenged?.ns / t.control.ns),
          num(t.control.gcPer1k, 1),
          num(t.young?.gcPer1k, 1),
        ]),
      );
    }
    lines.push("");
  }
  return lines;
}

function decomposeReport() {
  const phases = ["reads", "index", "lookup", "move", "lookup-move", "full"];
  const lines = ["ns per N. sum = reads + index + lookup + move; interaction = full − sum; pair = lookup-move − (lookup + move).", ""];
  lines.push(...head(["N", ...phases, "sum", "interaction", "interaction / full", "pair"]));
  for (const n of DECOMPOSE_SIZES) {
    const t = Object.fromEntries(phases.map((p) => [p, at(p, `decompose.${p}@${n}`)?.ns / n]));
    const sum = t.reads + t.index + t.lookup + t.move;
    lines.push(row([n, ...phases.map((p) => num(t[p])), num(sum), num(t.full - sum), num((t.full - sum) / t.full), num(t["lookup-move"] - t.lookup - t.move)]));
  }
  return [...lines, ""];
}

function leafReport() {
  const lines = ["ns per operation (1000 per step). Stages A..E are quant on a raw node; Δ is the cost the stage adds.", ""];
  lines.push(...head(["operation", "ns/op", "Δ"]));
  let prev;
  for (const c of cells) {
    const t = at(c.label, c.id);
    const ns = t?.ns / OPS;
    const staged = /^quant (read|write)\.[A-E]-/.test(c.label);
    const delta = staged && /\.A-/.test(c.label) ? "" : staged ? num(ns - prev) : "";
    if (staged) prev = ns;
    lines.push(row([c.label, num(ns), delta]));
  }
  return [...lines, ""];
}

function lowerReport() {
  const lines = [];
  const labels = ["quant", ...Object.keys(variants), "reflex", "alien"];
  for (const family of ["reverse", "shuffle", "insert-one"]) {
    const ids = LOWER_SIZES.map((n) => `lb.${family}@${n}`).filter((id) => at("quant", id));
    if (!ids.length) continue;
    lines.push(`### ${family}`, "", "ns per N; second table: ratio to quant.", "");
    lines.push(...head(["N", ...labels]));
    for (const id of ids) lines.push(row([sizeOf(id), ...labels.map((l) => num(at(l, id)?.ns / sizeOf(id)))]));
    lines.push("", ...head(["N", ...labels.slice(1)]));
    for (const id of ids) lines.push(row([sizeOf(id), ...labels.slice(1).map((l) => num(at(l, id)?.ns / at("quant", id).ns))]));
    lines.push("");
  }
  lines.push("Variants:", "", ...Object.entries(variants).map(([v, [what]]) => `- ${v}: ${what}`), "");
  return lines;
}

const env = { node: process.version, v8: process.versions.v8, cpu: cpus()[0]?.model, cores: cpus().length, os: `${platform()} ${release()} ${arch()}`, rounds };
const lines = [
  `Node ${env.node} (V8 ${env.v8}), ${env.cpu} x${env.cores}, ${env.os}; ${rounds} rounds; probe ${probeName}`,
  "",
  ...probe.report(),
  ...(excluded.length ? ["Excluded (checksum differs from the reference on that scenario):", "", ...excluded.map((x) => `- ${x.label} on ${x.id}`), ""] : []),
];
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ env, probe: probeName, cells, summary, structure, excluded }, null, 2) + "\n");
writeFileSync(outFile.replace(/\.json$/, ".md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
