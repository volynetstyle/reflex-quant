import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareRank } from "../bench/cost/exact.mjs";

const variant = process.argv[2] ?? "tail";
const q = await import(pathToFileURL(path.resolve(`.cache/reorder-exact/${variant}/raw-stats/index.mjs`)));
const api = {
  signal(value) {
    const n = q.signal(value);
    return { n, get: () => q.get(n), set: (value) => q.set(n, value) };
  },
  computed(fn) {
    const n = q.computed(fn);
    return { n, get: () => q.get(n) };
  },
};
const width = 256;

function verifyRank(g, fanout, step) {
  const order = g.orders[step & 3], c = g.reader.n;
  let dep = c.firstDep, prev = null;
  const nodes = [g.tick.n, ...order.map((i) => g.sources[i].n)];
  for (const s of nodes) {
    assert.equal(dep?.from, s);
    assert.equal(dep?.prevDep, prev);
    assert.equal(dep?.to, c);
    assert.equal(s.slot, variant === "resident" && step === 4 && c.fn !== g.body ? dep : null);
    prev = dep;
    dep = dep.nextDep;
  }
  assert.equal(dep, null);
  assert.equal(c.lastDep, prev);
  for (let i = 0; i < g.sources.length; i++) {
    const source = g.sources[i].n;
    let rank = 0, count = 0;
    for (let e = source.firstSub; e !== null; e = e.nextSub) {
      count++;
      if (e.to === c) rank = count;
    }
    assert.equal(count, fanout);
    assert.equal(rank, g.ranks[i]);
  }
}

const tail = variant !== "skipped";
const trained = variant === "transaction" || variant === "resident";
const window = variant === "tail-window" || trained;
const ranks = [
  [9, 9, !tail], [16, 9, true], [64, 33, true],
  [64, 63, !window], [64, "ends", !tail], [64, "random", true],
];
for (const [fanout, position, indexed] of ranks) {
  const g = prepareRank(api, width, fanout, position);
  const c = g.reader.n, body = c.fn;
  g.body = body;
  const captures = q.stats.capturedEdges;
  verifyRank(g, fanout, 0);
  for (let step = 1; step < 5; step++) {
    const before = q.stats.indexes;
    g.step(step);
    verifyRank(g, fanout, step);
    assert.equal(q.stats.indexes > before, indexed, `${fanout}/${position}/${step}`);
    if (trained && step < 3) assert.equal(c.fn, body);
  }
  if (trained && indexed) {
    assert.equal(q.stats.capturedEdges - captures, width + 1);
    assert.notEqual(c.fn, body);
    // The first ordered pass after promotion retires the wrapper.
    g.step(8);
    assert.equal(c.fn, body);
    verifyRank(g, fanout, 8);
  }
}

if (trained) {
  for (const n of [8192, 8193]) {
    const g = prepareRank(api, n, 4, 2);
    const c = g.reader.n;
    const capture = q.stats.captureVisits;
    for (let i = 1; i <= 3; i++) g.step(i);
    assert.equal(q.stats.captureVisits - capture, n === 8192 ? 8193 : 0);
    q.dispose(c);
  }
}

if (variant === "resident") {
  function shared() {
    const sources = Array.from({ length: width }, (_, i) => q.signal(i));
    const otherTick = q.signal(0), tick = q.signal(0), extra = q.signal(1000);
    const control = { nested: false, throws: false, adds: false };
    const readAll = (start) => {
      let sum = 0;
      for (let i = 0; i < width; i++) sum += q.get(sources[(start + i) % width]);
      return sum;
    };
    const sum = width * (width - 1) / 2;
    q.get(q.computed(() => readAll(0)));
    const b = q.computed(() => {
      const offset = q.get(otherTick);
      const value = readAll(offset);
      if (offset !== 0) assert.equal(sources[offset].slot?.to, b);
      return value;
    });
    q.get(b);
    const failure = new Error("before the first read");
    const a = q.computed(() => {
      if (control.throws) throw failure;
      const offset = q.get(tick);
      if (control.nested) {
        q.set(otherTick, 96);
        assert.equal(q.untracked(() => q.get(b)), sum);
        assert.equal(sources[96].slot?.to, a, "the active owner gets its displaced cell back");
      }
      return readAll(offset) + (control.adds ? q.get(extra) : 0);
    });
    const body = a.fn;
    q.get(a);
    q.get(q.computed(() => readAll(0)));
    q.get(q.computed(() => readAll(0)));
    function step(offset) { q.set(tick, offset); return q.get(a); }
    for (const offset of [48, 96, 144, 192]) assert.equal(step(offset), sum);
    assert.notEqual(a.fn, body);
    assert.ok(sources.every((s) => s.slot?.to === a));
    function clear() { assert.ok([...sources, tick, otherTick, extra].every((s) => s.slot === null)); }
    return { a, b, sources, control, otherTick, failure, sum, step, clear };
  }

  // A nested index can borrow cells without invalidating the active owner.
  // An idle conflict instead clears the whole cache before the other index.
  const g = shared();
  const reuses = q.stats.residentReuses, evictions = q.stats.residentEvictions;
  g.control.nested = true;
  assert.equal(g.step(16), g.sum);
  assert.equal(q.stats.residentReuses, reuses + 1);
  assert.equal(q.stats.residentEvictions, evictions);
  assert.ok(g.sources.every((s) => s.slot?.to === g.a));
  q.set(g.otherTick, 144);
  assert.equal(q.get(g.b), g.sum);
  g.clear();
  assert.equal(q.stats.residentEvictions, evictions + 1);
  g.control.nested = false;
  assert.equal(g.step(72), g.sum);
  assert.ok(g.sources.every((s) => s.slot?.to === g.a));
  q.dispose(g.a);
  g.clear();

  const failed = shared();
  failed.control.throws = true;
  assert.throws(() => failed.step(72), (error) => error === failed.failure);
  failed.clear();
  failed.control.throws = false;
  assert.equal(q.get(failed.a), failed.sum);
  q.dispose(failed.a);

  const changed = shared();
  changed.control.adds = true;
  assert.equal(changed.step(72), changed.sum + 1000);
  changed.clear();
  q.dispose(changed.a);
}

if (tail) {
  // The target starts at the tail. Nested initialization places a newer
  // subscriber after it while its unread suffix is marked.
  const ps = Array.from({ length: width }, (_, i) => q.signal(i));
  const tick = q.signal(0), middle = width / 2;
  const oldSum = width * (width - 1) / 2;
  const subscribe = () => ps.reduce((total, s) => total + q.get(s), 0);
  for (let i = 0; i < 8; i++) q.get(q.computed(subscribe));
  const child = q.computed(subscribe);
  let changed = false;
  const reader = q.computed(() => {
    if (q.get(tick) === 0) return subscribe();
    let answer = q.get(ps[middle]);
    if (!changed) q.untracked(() => q.get(child));
    for (let i = 0; i < width; i++) if (i !== middle) answer += q.get(ps[i]);
    if (!changed) {
      changed = true;
      q.set(ps[middle], middle + 1000);
    }
    q.get(ps[middle]);
    return answer;
  });
  assert.equal(q.get(reader), oldSum);
  const sweeps = q.stats.sweeps;
  q.set(tick, 1);
  assert.equal(q.get(reader), oldSum);
  assert.ok(q.stats.sweeps > sweeps);
  assert.equal(q.get(reader), oldSum + 1000, "P5 survives endpoint changes and a slot fallback");
  for (const p of ps) assert.equal(p.slot, null);
}

// Negative models of residency under the existing ownership rules.
// Inject only the permission to leave exact pair addresses in slot.
const a = q.signal(10), b = q.signal(20), turn = q.signal(false);
const c = q.computed(() => q.get(turn) ? q.get(b) + q.get(a) : q.get(a) + q.get(b));
assert.equal(q.get(c), 30);
for (let e = c.firstDep; e !== null; e = e.nextDep) e.from.slot = e;
q.set(turn, true);
assert.equal(q.get(c), 30);
assert.equal(b.firstSub, null, "the old slot falsely certified an indexed execution");
q.set(b, 100);
assert.equal(q.get(c), 30, "blind residency loses the wake on b");

const live = q.signal(1);
const terminal = q.computed(() => q.get(live));
q.get(terminal);
live.slot = terminal.firstDep;
q.dispose(terminal);
assert.equal(live.firstSub, null);
assert.equal(live.slot?.to, terminal, "a retained slot roots the detached reader");
live.slot = null;

console.log(`${variant}: subscriber ranks, order, slot cleanup, and the resident counterexamples verified`);
