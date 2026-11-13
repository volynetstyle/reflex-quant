// Checks the reorder stand's models (src/scripts/reorder.ts) against the real libraries with their
// research counters: quant-stats (kernel counters) and alien-stats (alien-signals 3.2.1 with link
// counters). Needs the bench bundles: `node bench/build.mjs` at the package root.
// For random read sequences (permutations, repeats, new and dropped sources) one computed reads
// them; per pass, relations created and removed must match the model exactly. For quant every
// kind of read must match its kernel counter too: hits, repeats (repeats + dups), new relations
// (links), moves, skips + defers (scans), tails, and whether the pass marked its suffix (sweeps); no pass
// indexes, since no source has a second reader.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { alienPass, quantPass } from "../src/scripts/reorder.ts";

const root = path.resolve(import.meta.dirname, "../..");
const load = (n) => import(pathToFileURL(path.join(root, ".cache/bench", n, "index.mjs")).href);
const Q = await load("quant-stats"), A = await load("alien-stats");

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
// Two regimes: short lists (the scans see everything) and long ones (past the scan budget of 8,
// where passes mark their suffix and reads move through the lookup).
const POOL = Array.from({ length: 48 }, (_, k) => `s${k}`);
const REGIMES = [{ pool: 16, max: 12 }, { pool: 48, max: 40 }];
let regime = REGIMES[0];
const int = (n) => Math.floor(rnd() * n);
const pick = () => {
  const n = 1 + int(regime.max), out = [];
  for (let k = 0; k < n; k++) out.push(rnd() < 0.15 && out.length ? out[int(out.length)] : POOL[int(regime.pool)]);
  return out;
};
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = int(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };
// Local edits of the previous order: the moves the tiers are for.
const edits = [
  (a) => [...a.slice(1), a[0]],                                                       // rotate
  (a) => { const b = [...a]; b.splice(int(b.length), 1); return b; },                 // drop one
  (a) => { const b = [...a]; b.splice(int(b.length), 2 + int(4)); return b; },        // drop a block
  (a) => { const b = [...a], i = int(b.length - 1); [b[i], b[i + 1]] = [b[i + 1], b[i]]; return b; }, // adjacent swap
  (a) => { const b = [...a], [x] = b.splice(int(b.length), 1); b.splice(int(b.length + 1), 0, x); return b; }, // move one
  (a) => [...a].reverse(),
];
const nextOf = (prev) => {
  const r = rnd();
  if (r < 0.3 || prev.length < 2) return shuffle(prev);
  if (r < 0.5) return pick();
  return edits[int(edits.length)](prev).filter((x) => x !== undefined);
};

function real(api, keys) {
  const src = Object.fromEntries(POOL.map((k) => [k, api.signal(0)]));
  const order = api.signal(0);
  let reads = [];
  const c = api.computed(() => { order.get(); for (const k of reads) src[k].get(); return reads.length; });
  return (next) => {
    reads = next;
    const before = { ...api.stats };
    order.set(order.get() + 1);   // invalidate
    c.get();                      // run: reads `order`, then the sequence
    const d = Object.fromEntries(Object.keys(api.stats).map((k) => [k, api.stats[k] - before[k]]));
    return d;
  };
}

let checked = 0, bad = 0;
const seen = { hit: 0, repeat: 0, new: 0, move: 0, skip: 0, defer: 0, tail: 0, mark: 0 };
for (let trial = 0; trial < 800; trial++) {
  regime = REGIMES[trial & 1];
  const q = real(Q), a = real(A);
  let qList = [], aList = [];
  let prev = pick();
  // first pass establishes the list
  q(prev); a(prev); qList = quantPass([], prev).list; aList = alienPass([], prev).list;
  for (let pass = 0; pass < 6; pass++) {
    const next = nextOf(prev);
    if (next.length === 0) next.push(POOL[0]);
    const rq = q(next), ra = a(next);
    // the computed also reads `order` first, which is always a cursor hit / reused link
    const mq = quantPass(qList, next), ma = alienPass(aList, next);
    const real = [rq.hits - 1, rq.repeats + rq.dups, rq.links, rq.moves, rq.scans, rq.tails, rq.sweeps, rq.indexes, rq.unlinks];
    const model = [mq.counts.hit, mq.counts.repeat, mq.counts.new, mq.counts.move, mq.counts.skip + mq.counts.defer, mq.counts.tail, mq.marked ? 1 : 0, 0, mq.removed];
    const okQ = real.every((x, k) => x === model[k]);
    const okA = ra.linksCreated === ma.created && ra.linksUnlinked === ma.removed;
    checked++;
    for (const k of Object.keys(mq.counts)) seen[k] += mq.counts[k];
    seen.mark += mq.marked ? 1 : 0;
    if (!okQ || !okA) {
      bad++;
      if (bad <= 5) console.log(`mismatch: ${prev.join("")} -> ${next.join("")}`,
        okQ ? "" : `quant hit/repeat/new/move/skip+defer/tail/mark/index/removed real ${real.join("/")} model ${model.join("/")}`,
        okA ? "" : `alien real ${ra.linksCreated}/${ra.linksUnlinked} model ${ma.created}/${ma.removed}`);
    }
    qList = mq.list; aList = ma.list; prev = next;
  }
}
// Every kind must occur, or the check would not cover it.
const missing = Object.entries(seen).filter(([, n]) => n === 0).map(([k]) => k);
if (missing.length) console.log(`no ${missing.join(", ")} read in ${checked} passes: the generator does not cover them`);
console.log(bad ? `${bad} of ${checked} passes differ` : `all ${checked} passes match: relations created and removed (both); hit, repeat, new, move, skip, defer, tail and mark per read (quant)`);
console.log(`quant reads: ${Object.entries(seen).map(([k, n]) => `${k} ${n}`).join(", ")}`);
process.exit(bad || missing.length ? 1 : 0);
