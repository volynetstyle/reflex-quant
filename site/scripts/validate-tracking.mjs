// Checks the tracking lab (src/scripts/tracking.ts) against the kernel. It builds src/ with the
// research counters compiled in, runs every lab scenario and random programs through `record`,
// and for every tracked read compares the counters the lab's `explain` predicts (hits, repeats,
// scans, tails, lookups, moves, links, mark and index walks, edges walked) with the counters the
// read actually added. It also checks the lab's model of the cursor (the accepted prefix of a
// running pass holds exactly the sources read so far, in order), that an indexed pass finds all
// its cells in place after a nested run (T3), and each scenario step's `expect`.
//
//   node scripts/validate-tracking.mjs [--print <scenario>]
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { record } from "../src/scripts/tracking.ts";
import { SCENARIOS } from "../src/scripts/tracking-scenarios.ts";

const root = path.resolve(import.meta.dirname, "../..");
const out = path.join(root, ".cache/site-tracking");
mkdirSync(out, { recursive: true });
const entry = path.join(out, "entry.mjs");
const posix = (p) => p.split(path.sep).join("/");
writeFileSync(entry, `export * from "${posix(path.join(root, "src/index.ts"))}";\nexport { stats } from "${posix(path.join(root, "src/instrumentation.ts"))}";\n`);
const esbuild = createRequire(path.join(root, "package.json"))("esbuild");
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", target: "es2022",
  define: { __STATS__: "true", __DEV__: "false" }, outfile: path.join(out, "quant-stats.mjs"), logLevel: "error",
});
const Q = await import(pathToFileURL(path.join(out, "quant-stats.mjs")).href);

// The lab follows the kernel of the version the site ships.
const shipped = JSON.parse(readFileSync(path.join(root, "site/node_modules/reflex-quant/package.json"), "utf8")).version;
const source = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
if (shipped !== source) {
  console.log(`site ships reflex-quant ${shipped}, the kernel checked here is ${source}`);
  process.exit(1);
}

const KEYS = ["hits", "repeats", "dups", "links", "scans", "tails", "moves", "lookups", "sweeps", "indexes", "indexed"];
let lastDelta = null;
const api = {
  ...Q,
  get(x) {
    const before = { ...Q.stats };
    const v = Q.get(x);
    lastDelta = Object.fromEntries(KEYS.map((k) => [k, Q.stats[k] - before[k]]));
    return v;
  },
};

let reads = 0, bad = 0;
const kinds = {}, proofs = {}, walks = { mark: 0, index: 0, displaced: 0 };
const fail = (msg) => { bad++; if (bad <= 8) console.log(msg); };
const onRead = (where) => (c, s, ex, read) => {
  reads++;
  kinds[ex.kind] = (kinds[ex.kind] ?? 0) + 1;
  proofs[ex.proof] = (proofs[ex.proof] ?? 0) + 1;
  if (ex.walk) walks[ex.walk]++;
  if (ex.displaced) walks.displaced++;
  const want = Object.fromEntries(KEYS.map((k) => [k, ex.counters[k] ?? 0]));
  if (KEYS.some((k) => want[k] !== lastDelta[k]))
    fail(`${where}: ${ex.kind}/${ex.proof} predicts ${JSON.stringify(want)}, kernel did ${JSON.stringify(lastDelta)}`);
  // The accepted prefix is exactly the sources read so far, in first-read order.
  let e = c.firstDep;
  for (const r of read) {
    if (e === null || e.from !== r) { fail(`${where}: accepted prefix differs from the reads`); break; }
    e = e.nextDep;
  }
  // An indexed pass (its cursor's source slot is the cursor) has every edge in its slot.
  let cur = c.firstDep;
  for (let k = 1; k < read.length; k++) cur = cur.nextDep;
  if (cur && cur.from.slot === cur)
    for (let u = c.firstDep; u; u = u.nextDep) if (u.from.slot !== u) { fail(`${where}: an indexed pass lost a slot cell`); break; }
};

// ---- the scenarios the page shows
const print = process.argv.includes("--print") ? process.argv[process.argv.indexOf("--print") + 1] : null;
for (const sc of SCENARIOS) {
  const { frames, steps } = record(api, { lists: sc.lists, sources: sc.sources, onRead: onRead(sc.id) }, sc.build);
  steps.forEach((st, k) => {
    const got = frames.filter((f) => f.type === "read" && f.step === k)
      .map((f) => (sc.lists.length > 1 ? `${f.consumer}.${f.explain.kind}` : f.explain.kind)).join(" ");
    if (st.expect !== undefined && st.expect !== got) fail(`${sc.id} step ${k} (${st.label}): expected "${st.expect}", got "${got}"`);
  });
  if (print === sc.id) {
    for (const f of frames) {
      const l = (n) => f.snap.lists.find((x) => x.name === n);
      const draw = (x) => x.edges.map((e, i) => `${i === x.cursor ? "▸" : ""}${e.src}#${e.id}${e.unread ? "u" : ""}${e.skipped ? "s" : ""}${e.tentative ? "t" : ""}${e.slot ? "*" : ""}`).join(" ") + (x.cursor === x.edges.length ? " ▸" : "");
      if (f.type === "step") console.log(`\n== ${f.label}`);
      else if (f.type === "read") console.log(`  ${f.consumer} reads ${f.src}: ${f.explain.kind}/${f.explain.proof}${f.explain.at ? "@" + f.explain.at : ""}${f.explain.walk ? ` ${f.explain.walk}(${f.explain.walked})` : ""}${f.explain.displaced ? ` displaced ${f.explain.displaced}` : ""}${f.over ? ` over ${f.over}` : ""}   ${draw(l(f.consumer))}`);
      else if (f.type === "end") console.log(`  ${f.consumer} ${f.ok ? "commits" : "fails: " + f.error}; removed [${f.removed}] born [${f.born}]   ${draw(l(f.consumer))}`);
      else if (f.type === "run") console.log(`  ${f.consumer} runs   ${draw(l(f.consumer))}`);
      if (f.type !== "step" && f.snap.sources.length) console.log(`     slots: ${f.snap.sources.map((s) => `${s.name}:${s.slot ? s.slot.owner + "#" + s.slot.id : "-"}`).join(" ")}`);
    }
  }
}
const scenarioReads = reads;

// ---- random programs: shared sources, computeds reading computeds (nested runs), throws
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const int = (n) => Math.floor(rnd() * n);
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = int(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };
for (let program = 0; program < 160; program++) {
  const NS = 24, NC = 12;
  const plans = [];
  record(api, { lists: [], onRead: onRead(`program ${program}`) }, (lab) => {
    const S = Array.from({ length: NS }, (_, i) => lab.signal(`s${i}`, i));
    const tick = lab.signal("tick", 0);
    const C = [];
    const pick = (k) => {
      const n = 1 + int(program & 1 ? 40 : 12), out = [];
      for (let i = 0; i < n; i++) {
        if (out.length && rnd() < 0.12) out.push(out[int(out.length)]);           // a repeat
        else if (k > 0 && rnd() < 0.1) out.push(NS + int(k));                     // an earlier computed
        else out.push(int(NS));
      }
      if (rnd() < 0.08) out.splice(int(out.length + 1), 0, "throw");
      return out;
    };
    const edit = (a) => {
      const r = rnd(), b = a.filter((x) => x !== "throw");
      if (b.length < 2 || r < 0.25) return shuffle(b);
      if (r < 0.4) return [...b.slice(1), b[0]];
      if (r < 0.55) { b.splice(int(b.length), 1 + int(3)); return b; }
      if (r < 0.7) { const i = int(b.length - 1); [b[i], b[i + 1]] = [b[i + 1], b[i]]; return b; }
      if (r < 0.8) return b.reverse();
      return b;
    };
    for (let k = 0; k < NC; k++) {
      plans[k] = pick(k);
      C[k] = lab.computed(`c${k}`, (r) => {
        let t = r(tick);
        for (const x of plans[k]) {
          if (x === "throw") throw new Error("planned");
          t += r(x < NS ? S[x] : C[x - NS]);
        }
        return t;
      });
    }
    return Array.from({ length: 10 }, (_, round) => ({
      label: `round ${round}`,
      run: () => {
        for (let k = 0; k < NC; k++) if (rnd() < 0.7) plans[k] = rnd() < 0.3 ? pick(k) : edit(plans[k]);
        lab.api.set(tick, round + 1);
        for (const k of shuffle([...Array(NC).keys()])) try { lab.api.get(C[k]); } catch { /* planned */ }
      },
    }));
  });
}

const all = ["hit", "repeat", "new", "skip", "defer", "tail", "move"];
const allProofs = ["cursor", "own", "empty", "slot", "nobody", "others", "marked", "one-past", "tail", "ahead", "behind", "ends", "subs"];
const missing = [...all.filter((k) => !kinds[k]), ...allProofs.filter((p) => !proofs[p]), ...["mark", "index", "displaced"].filter((w) => !walks[w])];
if (missing.length) { console.log(`never exercised: ${missing.join(", ")}`); bad++; }
console.log(bad ? `${bad} problems` : `all ${reads} tracked reads match the kernel's counters (${scenarioReads} in the ${SCENARIOS.length} lab scenarios, the rest in 160 random programs); every scenario step reads as its expect says`);
console.log(`kinds: ${all.map((k) => `${k} ${kinds[k] ?? 0}`).join(", ")}`);
console.log(`proofs: ${allProofs.map((p) => `${p} ${proofs[p] ?? 0}`).join(", ")}; walks: mark ${walks.mark}, index ${walks.index}, with displaced cells ${walks.displaced}`);
process.exit(bad ? 1 : 0);
