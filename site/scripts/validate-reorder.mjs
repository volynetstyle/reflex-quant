// Checks the reorder stand's models (src/scripts/reorder.ts) against the real libraries with their
// research counters: quant-stats (kernel counters) and alien-stats (alien-signals 3.2.1 with link
// counters). Needs the bench bundles: `node bench/build.mjs` at the package root.
// For random read sequences (permutations, repeats, new and dropped sources) one computed reads
// them; per pass, relations created and removed must match the model exactly, and for quant the
// cursor hits too.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { alienPass, quantPass } from "../src/scripts/reorder.ts";

const root = path.resolve(import.meta.dirname, "../..");
const load = (n) => import(pathToFileURL(path.join(root, ".cache/bench", n, "index.mjs")).href);
const Q = await load("quant-stats"), A = await load("alien-stats");

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const POOL = "ABCDEFGHIJKLMNOP".split("");
const pick = () => {
  const n = 1 + Math.floor(rnd() * 12), out = [];
  for (let k = 0; k < n; k++) out.push(rnd() < 0.15 && out.length ? out[Math.floor(rnd() * out.length)] : POOL[Math.floor(rnd() * POOL.length)]);
  return out;
};
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

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
for (let trial = 0; trial < 400; trial++) {
  const q = real(Q), a = real(A);
  let qList = [], aList = [];
  let prev = pick();
  // first pass establishes the list
  q(prev); a(prev); qList = quantPass([], prev).list; aList = alienPass([], prev).list;
  for (let pass = 0; pass < 6; pass++) {
    const next = rnd() < 0.5 ? shuffle(prev) : pick();
    const rq = q(next), ra = a(next);
    // the computed also reads `order` first, which is always a cursor hit / reused link
    const mq = quantPass(qList, next), ma = alienPass(aList, next);
    const okQ = rq.links === mq.created && rq.unlinks === mq.removed && rq.hits - 1 === mq.hits;
    const okA = ra.linksCreated === ma.created && ra.linksUnlinked === ma.removed;
    checked++;
    if (!okQ || !okA) {
      bad++;
      if (bad <= 5) console.log(`mismatch: ${prev.join("")} -> ${next.join("")}`,
        okQ ? "" : `quant real new/removed/hits ${rq.links}/${rq.unlinks}/${rq.hits - 1} model ${mq.created}/${mq.removed}/${mq.hits}`,
        okA ? "" : `alien real ${ra.linksCreated}/${ra.linksUnlinked} model ${ma.created}/${ma.removed}`);
    }
    qList = mq.list; aList = ma.list; prev = next;
  }
}
console.log(bad ? `${bad} of ${checked} passes differ` : `all ${checked} passes match: relations created and removed (both), cursor hits (quant)`);
process.exit(bad ? 1 : 0);
