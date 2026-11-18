import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { permutation, range } from "../bench/scaling.mjs";

const variant = process.argv[2];
assert.ok(["observe", "thread", "witness"].includes(variant));
const q = await import(pathToFileURL(path.resolve(`.cache/reorder-learning/${variant}/raw-stats/index.mjs`)));
const { stats, signal, computed, get, set, untracked, dispose } = q;
const width = 96;
const orders = range(12).map((i) => permutation(width, 0x138ccb7e + i));
const thrown = new Error("original error");

function heldSources(deep) {
  const sources = range(width).map((id) => signal(id));
  if (deep) {
    for (let i = 0; i < 8; i++) get(computed(() => {
      for (const source of sources) get(source);
    }));
  }
  return sources;
}

function reader(sources) {
  const tick = signal(0);
  const state = { sources, order: orders[0], hook: null, extra: null, value: undefined };
  function body(previous) {
    assert.equal(this, c);
    assert.equal(previous, state.value);
    get(tick);
    let answer = 0;
    for (let i = 0; i < state.order.length; i++) {
      answer = (Math.imul(answer, 31) + get(sources[state.order[i]])) | 0;
      if (i === 16) state.hook?.();
    }
    if (state.extra !== null) answer = (answer + get(state.extra)) | 0;
    state.value = answer;
    return answer;
  }
  // Wrapping must use the language's method-call semantics.
  body.call = () => { throw new Error("ordinary .call property was used"); };
  const c = computed(body);
  state.c = c;
  state.original = body;
  state.tick = tick;
  get(c);
  let version = 0;
  state.run = (order = state.order) => {
    state.order = order;
    set(tick, ++version);
    return get(c);
  };
  return state;
}

function checkGraph(r) {
  const sequence = [r.tick, ...r.order.map((id) => r.sources[id])];
  if (r.extra !== null) sequence.push(r.extra);
  let e = r.c.firstDep, last = null;
  for (const source of sequence) {
    assert.equal(e?.from, source);
    assert.equal(e.to, r.c);
    assert.equal(e.prevDep, last);
    const references = [];
    for (let s = source.firstSub; s; s = s.nextSub) if (s.to === r.c) references.push(s);
    assert.deepEqual(references, [e]);
    assert.equal(source.slot, null);
    last = e;
    e = e.nextDep;
  }
  assert.equal(e, null);
  assert.equal(last, r.c.lastDep);
}

const specialized = () => stats.threadRuns + stats.witnessRuns;
function train(r, qualifies) {
  const promotions = stats.promotions;
  const runs = specialized();
  r.run(orders[1]);
  assert.notEqual(r.c.fn, r.original);
  for (let i = 2; i <= 4; i++) r.run(orders[i]);
  assert.equal(stats.promotions - promotions, 1);
  assert.equal(specialized() - runs, 0);
  r.run(orders[5]);
  assert.equal(specialized() - runs, Number(qualifies));
  checkGraph(r);
}

const privateConsumer = reader(heldSources(false));
train(privateConsumer, variant === "thread");
assert.equal(stats.witnessCellsBuilt, 0);
const deepConsumer = reader(heldSources(true));
train(deepConsumer, variant === "witness");
const beforeQuiet = specialized();
deepConsumer.run();
const afterQuiet = specialized();
assert.equal(afterQuiet - beforeQuiet, Number(variant === "witness"));
deepConsumer.run();
assert.equal(specialized(), afterQuiet);
assert.equal(deepConsumer.c.fn, deepConsumer.original);
checkGraph(deepConsumer);

const one = reader(heldSources(false)), beforeOnce = stats.promotions;
one.run(orders[1]);
one.run();
one.run();
assert.equal(stats.promotions, beforeOnce);
assert.equal(one.c.fn, one.original);
checkGraph(one);

// Detect an actual nested indexed pass over the same sources. Nested forced
// misses must restore the outer slot before evaluating the next outer read.
const shared = heldSources(true);
const inner = reader(shared), outer = reader(shared);
train(inner, variant === "witness");
train(outer, variant === "witness");
outer.hook = () => untracked(() => {
  const saved = shared[0].slot;
  assert.equal(saved?.to, outer.c);
  inner.run(orders[7]);
  assert.equal(shared[0].slot, saved);
});
outer.run(orders[6]);
checkGraph(inner);
checkGraph(outer);

// A specialized membership change falls back to exact cleanup of every slot
// including a newly linked source. Exercise successful and throwing exits.
const foreign = heldSources(true)[0];
const privateFallback = reader(heldSources(false));
train(privateFallback, variant === "thread");
privateFallback.extra = foreign;
privateFallback.run(orders[6]);
checkGraph(privateFallback);
const throwing = reader(heldSources(variant === "witness"));
train(throwing, variant !== "observe");
const beforeFailure = specialized();
const extra = signal(11111);
throwing.hook = () => { get(extra); throw thrown; };
assert.throws(() => throwing.run(orders[8]), (error) => error === thrown);
assert.equal(specialized() - beforeFailure, Number(variant !== "observe"));
assert.equal(throwing.c.fn, throwing.original);
assert.equal(extra.slot, null);
for (const s of throwing.sources) assert.equal(s.slot, null);
throwing.hook = null;
throwing.run(orders[9]);
checkGraph(throwing);
assert.ok(!extra.firstSub);

// The learned wrapper never resurrects a disposed body. Its old relation
// objects must be collectible while the terminal consumer remains live.
function retireWithWeakEdge() {
  const retired = reader(heldSources(variant === "witness"));
  train(retired, variant !== "observe");
  const edge = new WeakRef(retired.c.firstDep);
  retired.hook = () => { dispose(retired.c); throw thrown; };
  assert.throws(() => retired.run(orders[6]), (error) => error === thrown);
  assert.equal(retired.c.fn, null);
  assert.equal(retired.c.firstDep, null);
  return { terminal: retired.c, edge };
}
const retired = retireWithWeakEdge();
if (globalThis.gc) {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.gc();
  }
  assert.equal(retired.edge.deref(), undefined);
  assert.equal(retired.terminal.firstDep, null);
}
console.log(JSON.stringify({
  variant,
  warmupBeforeSpecialization: 4,
  firstStableSpeculation: afterQuiet - beforeQuiet,
  promotions: stats.promotions,
  nestedAndFailureSlotsRestored: true,
  disposedEdgeCollected: Boolean(globalThis.gc),
}));
