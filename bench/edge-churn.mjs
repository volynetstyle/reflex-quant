// Isolated Edge allocation/list probe. No reactive runtime or dependencies.
// node bench/edge-churn.mjs [--rounds 5] [--only <regex>] [--out <file>]
// Each case runs in a fresh process per round. Times are ns per edge, including
// array writes, loop/control overhead, and the cleanup described below.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { strict as assert } from "node:assert";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (args[i + 1] === undefined || args[i + 1].startsWith("--")) throw new Error(`missing value for ${name}`);
  return args[i + 1];
};
const size = 128;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

if (args.includes("--worker")) {
  const fields = Number(option("--fields", "8"));
  const mode = option("--mode", "full");
  if (![7, 8, 9].includes(fields) || !["allocate", "source", "consumer", "full", "pool", "replace", "replace-pool", "replace-defer", "replace-old-store", "replace-pool-defer"].includes(mode)) throw new Error("invalid worker case");
  const isReplace = mode.startsWith("replace");
  const isReplacePool = mode === "replace-pool" || mode === "replace-pool-defer";
  // The 7-field shape omits gen and is a layout probe, not a proposed
  // equivalent implementation. The 9-field shape adds an initialized Smi.
  const make = fields === 7
    ? (s, c, prev, next, tail) => ({ from: s, to: c, ver: s.ver, prev, next, prevSub: tail, nextSub: null })
    : fields === 8
      ? (s, c, prev, next, tail) => ({ from: s, to: c, ver: s.ver, gen: (c.gen + 1) & 0x3fffffff, prev, next, prevSub: tail, nextSub: null })
      : (s, c, prev, next, tail) => ({ from: s, to: c, ver: s.ver, gen: (c.gen + 1) & 0x3fffffff, prev, next, prevSub: tail, nextSub: null, extra: 0 });
  const sources = Array.from({ length: size }, (_, i) => ({ ver: i, subs: null, lastSub: null }));
  const consumer = { gen: 0, deps: null, last: null };
  // Escaping edges through this array prevents allocation-only from measuring
  // scalar replacement and provides the same array stores in every case.
  const edges = new Array(size);
  if (mode === "pool") for (let i = 0; i < size; i++) edges[i] = make(sources[i], consumer, null, null, null);

  // Two disjoint source sets alternate behind one retained prefix edge.
  // New links are inserted before the old suffix, then that suffix is cut.
  const replaceSources = Array.from({ length: size * 2 }, (_, i) => ({ ver: i, subs: null, lastSub: null }));
  const prefix = make({ ver: 0 }, consumer, null, null, null);
  const replaceEdges = [new Array(size), new Array(size)];
  let side = 0;
  if (isReplace) {
    consumer.deps = prefix;
    for (let group = 0; group < 2; group++) {
      if (group === 1 && !isReplacePool) continue;
      let last = prefix;
      for (let i = 0; i < size; i++) {
        const s = replaceSources[group * size + i];
        const e = make(s, consumer, last, null, null);
        if (isReplacePool) replaceEdges[group][i] = e;
        if (group === 0) { last.next = e; s.subs = e; s.lastSub = e; }
        last = e;
      }
      if (group === 0) consumer.last = last;
    }
  }

  function replace() {
    side ^= 1;
    const next = prefix.next;
    let last = prefix;
    for (let i = 0; i < size; i++) {
      const s = replaceSources[side * size + i];
      const tail = s.lastSub;
      const e = isReplacePool ? replaceEdges[side][i] : make(s, consumer, last, next, tail);
      if (isReplacePool) {
        e.from = s; e.to = consumer; e.ver = s.ver;
        if (fields !== 7) e.gen = (consumer.gen + 1) & 0x3fffffff;
        e.prev = last; e.next = next; e.prevSub = tail; e.nextSub = null;
        if (fields === 9) e.extra = 0;
      }
      last.next = e;
      if (mode === "replace-old-store") next.prev = prefix;
      else if (mode !== "replace-defer" && mode !== "replace-pool-defer") next.prev = e;
      if (tail !== null) tail.nextSub = e;
      else s.subs = e;
      s.lastSub = e;
      consumer.last = e;
      last = e;
    }
    // Diagnostic variants temporarily leave next.prev stale (or point it at
    // the retained prefix). Repair it before leaving this synthetic loop.
    if (mode === "replace-defer" || mode === "replace-pool-defer" || mode === "replace-old-store") next.prev = last;
    last.next = null;
    for (let e = next; e !== null; e = e.next) {
      const s = e.from, before = e.prevSub, after = e.nextSub;
      if (before !== null) before.nextSub = after;
      else s.subs = after;
      if (after !== null) after.prevSub = before;
      else s.lastSub = before;
    }
    return next.ver;
  }

  function step() {
    let last = null;
    for (let i = 0; i < size; i++) {
      const s = sources[i];
      const source = mode === "source" || mode === "full" || mode === "pool";
      const deps = mode === "consumer" || mode === "full" || mode === "pool";
      const tail = source ? s.lastSub : null;
      const e = mode === "pool" ? edges[i] : make(s, consumer, deps ? last : null, null, tail);
      if (mode === "pool") {
        e.from = s; e.to = consumer; e.ver = s.ver;
        if (fields !== 7) e.gen = (consumer.gen + 1) & 0x3fffffff;
        e.prev = last; e.next = null; e.prevSub = tail; e.nextSub = null;
        if (fields === 9) e.extra = 0;
      }
      edges[i] = e;
      if (deps) {
        if (last !== null) last.next = e;
        else consumer.deps = e;
        consumer.last = e;
        last = e;
      }
      if (source) {
        if (tail !== null) tail.nextSub = e;
        else s.subs = e;
        s.lastSub = e;
      }
    }
    // Like cut/unsub, detach the consumer chain and unlink each source. The
    // source-only case pays the same unsubscribe cleanup as the full case.
    if (mode === "consumer" || mode === "full" || mode === "pool") consumer.deps = null;
    if (mode === "source" || mode === "full" || mode === "pool") {
      for (let i = 0; i < size; i++) {
        const e = edges[i], s = e.from, before = e.prevSub, after = e.nextSub;
        if (before !== null) before.nextSub = after;
        else s.subs = after;
        if (after !== null) after.prevSub = before;
        else s.lastSub = before;
      }
    }
    return edges[size - 1].ver;
  }

  // Check actual shape and the post-step topology before taking timings.
  const run = isReplace ? replace : step;
  assert.equal(run(), isReplace ? 0 : size - 1);
  if (isReplace) {
    assert.equal(Object.keys(prefix.next).length, fields);
    for (let pass = 0; pass < 3; pass++) {
      assert.equal(consumer.deps, prefix);
      let e = prefix.next;
      let previous = prefix;
      for (let i = 0; i < size; i++) {
        assert.equal(e.prev, previous);
        assert.equal(replaceSources[side * size + i].subs, e);
        assert.equal(replaceSources[(side ^ 1) * size + i].subs, null);
        previous = e;
        e = e.next;
      }
      assert.equal(e, null);
      assert.equal(consumer.last, previous);
      run();
    }
  } else {
    assert.equal(Object.keys(edges[0]).length, fields);
    assert.equal(consumer.deps, null);
    for (const s of sources) { assert.equal(s.subs, null); assert.equal(s.lastSub, null); }
    if (mode === "consumer" || mode === "full" || mode === "pool") {
      for (let i = 0; i < size; i++) {
        assert.equal(edges[i].prev, i === 0 ? null : edges[i - 1]);
        assert.equal(edges[i].next, i === size - 1 ? null : edges[i + 1]);
      }
    }
  }
  let sink = 0;
  const now = () => process.hrtime.bigint();
  let iterations = 0;
  for (const start = now(); now() - start < 300_000_000n || iterations < 2_000; iterations++) sink ^= run();
  let batch = 1;
  for (;;) {
    const start = now();
    for (let i = 0; i < batch; i++) sink ^= run();
    if (now() - start > 10_000_000n || batch >= 1 << 20) break;
    batch *= 2;
  }
  globalThis.gc?.();
  const samples = [];
  for (let sample = 0; sample < 21; sample++) {
    const start = now();
    for (let i = 0; i < batch; i++) sink ^= run();
    samples.push(Number(now() - start) / batch / size);
  }
  console.log(JSON.stringify({ fields, mode, nsPerEdge: median(samples), batch, sink }));
} else {
  const rounds = Number(option("--rounds", "5"));
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be a positive integer");
  const only = new RegExp(option("--only", "."));
  const cases = [7, 8, 9].flatMap((fields) => ["allocate", "source", "consumer", "full", "pool", "replace", "replace-pool", "replace-defer", "replace-old-store", "replace-pool-defer"].map((mode) => ({ fields, mode, id: `${fields}.${mode}` }))).filter((c) => only.test(c.id));
  if (!cases.length) throw new Error("no cases selected");
  let seed = 0x2545f491;
  const random = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
  const results = Object.fromEntries(cases.map((c) => [c.id, []]));
  for (let round = 0; round < rounds; round++) {
    const order = [...cases];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const c of order) {
      const output = execFileSync(process.execPath, ["--expose-gc", import.meta.filename, "--worker", "--fields", String(c.fields), "--mode", c.mode], { encoding: "utf8", timeout: 120_000 });
      results[c.id].push(JSON.parse(output.trim()).nsPerEdge);
    }
    process.stderr.write(`round ${round + 1}/${rounds}\n`);
  }
  const env = { node: process.version, v8: process.versions.v8, cpu: cpus()[0]?.model, cores: cpus().length, os: `${platform()} ${release()} ${arch()}`, rounds, edgesPerStep: size };
  const rows = cases.map((c) => ({ ...c, median: median(results[c.id]), min: Math.min(...results[c.id]), max: Math.max(...results[c.id]), rounds: results[c.id] }));
  const out = option("--out", null);
  if (out !== null) writeFileSync(out, JSON.stringify({ env, rows }, null, 2) + "\n");
  console.log(`${env.node} / V8 ${env.v8}; ${env.cpu}; ${env.os}; ${rounds} rounds`);
  console.log("| fields | case | median ns/edge | round range ns/edge |");
  console.log("| ---: | --- | ---: | ---: |");
  for (const r of rows) console.log(`| ${r.fields} | ${r.mode} | ${r.median.toFixed(2)} | ${r.min.toFixed(2)}–${r.max.toFixed(2)} |`);
}
