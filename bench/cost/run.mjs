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
//                constant-factor mechanism removed (bench/cost/build.mjs);
//                `identity` is the same bytes as quant: the noise of a cell
//   surface      A/B of the public write and read paths (surfaceVariants in
//                bench/cost/build.mjs): leaf get/set, and the mechanisms
//                where a write has work to deliver, so a win on the empty
//                path cannot hide a loss on the full one
//   reorder      representation candidates for global reorders
//                (reorderVariants in bench/cost/build.mjs) on reorders and
//                on the local paths they must not slow, with quant's and each
//                variant's structural work per step
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
import { reorderVariants, surfaceVariants, variants } from "./build.mjs";
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
const cell = (label, bundle, id, flags = [], suite = "cost") => ({ label, bundle, id, flags, suite, key: `${label}|${id}|${flags.join(" ")}` });
/** Global reorders, where a variant should win, and local paths, where it must not lose. */
const REORDER_WORK = [
  ...["lb.shuffle@256", "lb.shuffle@1024", "lb.shuffle@4096", "lb.reverse@256", "lb.reverse@1024", "lb.reverse@4096", "regime.shuffle@8192", "lb.insert-one@1024"].map((id) => [id, "cost"]),
  ...["long-reorder.256", "shared-chaotic.64x32", "reorder.reverse-8", "reorder.rotate-256", "value-sort.256x32", "replace-half.256", "edit.insert-one-256", "branch.switch-100"].map((id) => [id, "scenarios"]),
  ...["track.stable-64", "track.swap-32", "track.duplicate-64"].map((id) => [id, "mechanisms"]),
];
/** Mechanisms (bench/mechanisms.mjs) for the surface A/B: empty and full write paths. */
const SURFACE_WORK = ["read.signal", "write.no-subscribers", "write.same-value", "effect.rerun-1", "effect.through-computed", "batch.coalesce-64", "push.effects-1000"];
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
      ["reads", "index", "lookup", "move", "lookup-move", "mark", "subs", "subs-move", "full"].flatMap((phase) =>
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
  reorder: {
    strict: true,
    structureBundles: { quant: "bench/quant-stats", ...Object.fromEntries(Object.keys(reorderVariants).map((v) => [v, `cost/rv-${v}-stats`])) },
    cells: () =>
      REORDER_WORK.flatMap(([id, suite]) => [
        cell("quant", RUNTIMES.quant, id, [], suite),
        cell("identity", "cost/lb-identity", id, [], suite),
        ...Object.keys(reorderVariants).map((v) => cell(v, `cost/rv-${v}`, id, [], suite)),
        cell("reflex", RUNTIMES.reflex, id, [], suite),
        cell("alien", RUNTIMES.alien, id, [], suite),
      ]),
    report: reorderReport,
  },
  surface: {
    strict: true,
    cells: () =>
      Object.keys(surfaceVariants).flatMap((v) => [
        ...["leaf.write.E-set", "leaf.read.E-get"].map((id) => cell(v, `cost/surface-${v}`, id)),
        ...SURFACE_WORK.map((id) => cell(v, `cost/surface-${v}-api`, id, [], "mechanisms")),
      ]),
    report: surfaceReport,
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
const runCell = (c, extra = []) => json(worker, [path.join(root, ".cache", c.bundle), c.id, "--suite", c.suite, ...c.flags, ...extra]);

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
if (cells.length === 0) throw new Error(`${probeName}: no cells matched ${only}`);

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
  // A candidate that changes an answer is a bug, not a lower bound.
  if (excluded.length && probe.strict) throw new Error(`${probeName}: a candidate changes answers: ${excluded.map((x) => `${x.label} ${x.id}`).join(", ")}`);
}
if (args.includes("--verify-only")) {
  // Independent probes have different answers by design, but every cell must
  // still execute. Otherwise this mode silently skips leaf and decompose.
  if (probe.independent) {
    for (const c of cells) runCell(c, ["--verify"]);
  }
  console.log(`${probeName}: ${cells.length} cells verified; ${excluded.length} excluded`);
  if (excluded.length && probeName !== "lower-bound") process.exitCode = 1;
  process.exit();
}

// 2. Structure (deterministic; once per scenario).
const structure = {};
if (probe.structure) {
  for (const id of new Set(cells.filter((c) => c.label === "quant").map((c) => c.id))) structure[id] = json(structureWorker, [id]);
}
if (probe.structureBundles) {
  for (const c of cells) {
    const bundle = probe.structureBundles[c.label];
    if (bundle === undefined || structure[`${c.label}|${c.id}`]) continue;
    structure[`${c.label}|${c.id}`] = json(structureWorker, [c.id, "--bundle", path.join(root, ".cache", bundle), "--suite", c.suite]);
  }
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
      rounds: s.ns,
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
  const phases = ["reads", "index", "lookup", "move", "lookup-move", "mark", "subs", "subs-move", "full"];
  const lines = [
    "ns per N. full is the release's pass (one reader: a marked pass, LOG 28). Indexed parts: reads + index + lookup + move;",
    "marked parts: reads + mark + subs + move; interaction = full − marked parts; pair = (together) − (lookup + move).",
    "",
  ];
  lines.push(...head(["N", ...phases, "indexed parts", "marked parts", "interaction", "slot pair", "subs pair"]));
  for (const n of DECOMPOSE_SIZES) {
    const t = Object.fromEntries(phases.map((p) => [p, at(p, `decompose.${p}@${n}`)?.ns / n]));
    const indexed = t.reads + t.index + t.lookup + t.move;
    const marked = t.reads + t.mark + t.subs + t.move;
    lines.push(row([n, ...phases.map((p) => num(t[p])), num(indexed), num(marked), num(t.full - marked), num(t["lookup-move"] - t.lookup - t.move), num(t["subs-move"] - t.subs - t.move)]));
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

function reorderReport() {
  const vs = Object.keys(reorderVariants);
  const labels = ["quant", "identity", ...vs, "reflex", "alien"];
  const ids = [...new Set(cells.map((c) => c.id))];
  const per = (id) => (Number.isFinite(sizeOf(id)) ? sizeOf(id) : 1);
  const unit = (id) => (Number.isFinite(sizeOf(id)) ? "ns/N" : "ns/step");
  const lines = ["Time (ns per N for sized ids, ns per step otherwise); then ratios to quant. identity is the same bytes as quant: its ratio is the noise of one cell.", ""];
  lines.push(...head(["scenario", "unit", ...labels]));
  for (const id of ids) lines.push(row([id, unit(id), ...labels.map((l) => num(at(l, id)?.ns / per(id)))]));
  lines.push("", ...head(["scenario", "quant range", "identity", ...vs, "reflex", ...vs.map((v) => `${v} / reflex`)]));
  for (const id of ids) {
    const q = at("quant", id);
    lines.push(
      row([
        id,
        q ? `${num(q.min / per(id))}..${num(q.max / per(id))}` : "—",
        ...["identity", ...vs, "reflex"].map((l) => num(at(l, id)?.ns / q?.ns)),
        ...vs.map((v) => num(at(v, id)?.ns / at("reflex", id)?.ns)),
      ]),
    );
  }
  lines.push("", "Structural work per step (quant | variants): lookups, moves, index + mark walks, edges walked.", "");
  lines.push(...head(["scenario", ...["quant", ...vs].map((l) => `${l}: lookups / moves / walks / walked`)]));
  for (const id of ids) {
    const cellsOf = ["quant", ...vs].map((l) => {
      const p = structure[`${l}|${id}`]?.perStep;
      return p ? `${num(p.lookups, 1)} / ${num(p.moves, 1)} / ${num(p.indexes, 1)} + ${num(p.sweeps ?? 0, 1)} / ${num(p.indexed, 1)}` : "—";
    });
    lines.push(row([id, ...cellsOf]));
  }
  lines.push("", "Variants:", "", ...Object.entries(reorderVariants).map(([v, [what]]) => `- ${v}: ${what}`), "");
  return lines;
}

function surfaceReport() {
  const labels = Object.keys(surfaceVariants);
  const ids = [...new Set(cells.map((c) => c.id))];
  const unit = (id) => (id.startsWith("leaf.") || id === "read.signal" || id === "write.no-subscribers" || id === "write.same-value" ? OPS : 1);
  const lines = ["ns per operation for the 1000-operation steps (leaf, read.signal, write.*), ns per step otherwise; range is min..max of the round medians.", ""];
  lines.push(...head(["scenario", ...labels]));
  for (const id of ids) lines.push(row([id, ...labels.map((l) => num(at(l, id)?.ns / unit(id)))]));
  lines.push("", "Ratio to current, and the range of current itself (its spread is the noise floor):", "");
  lines.push(...head(["scenario", "current range", ...labels.slice(1)]));
  for (const id of ids) {
    const base = at("current", id);
    lines.push(row([id, base ? `${num(base.min / unit(id))}..${num(base.max / unit(id))}` : "—", ...labels.slice(1).map((l) => num(at(l, id)?.ns / base?.ns))]));
  }
  lines.push("", "Candidates:", "", ...Object.entries(surfaceVariants).map(([v, [what]]) => `- ${v}: ${what}`), "");
  return lines;
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
