// Public D1 discriminator and graph checks through the raw-handle adapter.
// Pass a baseline or candidate quant-internals ESM bundle.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { permutation, range } from "../bench/scaling.mjs";

const q = await import(pathToFileURL(path.resolve(process.argv[2] ?? ".cache/cost/quant-internals/index.mjs")));
const { signal, computed, get, set, effect, dispose } = q;
const firstError = new Error("late source");
let distinctions = 0;

// An earlier changed computed lets the sink execute a new branch. An earlier
// throwing computed ends validation. The sink itself is stale, never directly
// dirtied by either write. No hidden application order is available on demand.
function distinguish(order, a, b) {
  const triggers = order.map(() => signal(0));
  const gates = triggers.map((tick, id) => computed(() => {
    const value = get(tick);
    if (id === b && value) throw firstError;
    return value;
  }));
  let finished = false;
  const sink = computed(() => {
    if (finished) return 99;
    for (const id of order) get(gates[id]);
    return 0;
  });
  assert.equal(get(sink), 0);
  finished = true;
  set(triggers[a], 1);
  set(triggers[b], 1);
  if (order.indexOf(a) < order.indexOf(b)) assert.equal(get(sink), 99);
  else assert.throws(() => get(sink), (error) => error === firstError);
  distinctions++;
}
function orders(prefix, rest) {
  if (!rest.length) {
    for (const a of prefix) for (const b of prefix) if (a !== b) distinguish(prefix, a, b);
    return;
  }
  for (const id of rest) orders([...prefix, id], rest.filter((x) => x !== id));
}
orders([], range(4));

function checkList(c, expected) {
  const seen = new Set();
  let e = c.firstDep, prev = null;
  for (const source of expected) {
    assert.ok(e && !seen.has(e));
    seen.add(e);
    assert.equal(e.from, source);
    assert.equal(e.to, c);
    assert.equal(e.prevDep, prev);
    let matches = 0;
    for (let s = source.firstSub; s; s = s.nextSub) {
      if (s.to === c) { assert.equal(s, e); matches++; }
    }
    assert.equal(matches, 1);
    prev = e;
    e = e.nextDep;
  }
  assert.equal(e, null);
  assert.equal(c.lastDep, prev);
}

// A partial permutation can throw, leave tentative relations, or dispose
// after a nested reader has displaced slots. Check identity, first-version
// observations, both subscriber directions, and exact order on recovery.
const n = 96, ps = range(n + 4).map(signal), tick = signal(0);
let order = range(n), fault = false, hook = () => {};
const c = computed(() => {
  get(tick);
  let hash = 0;
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    hash = (Math.imul(hash, 31) + get(ps[id])) | 0;
    if (i === 11) hook();
  }
  if (fault) throw firstError;
  return hash;
});
const answer = () => order.reduce((h, id) => (Math.imul(h, 31) + ps[id].value) | 0, 0);
const expected = () => [tick, ...new Set(order.map((id) => ps[id]))];
assert.equal(get(c), answer());
const identities = ps.slice(0, n).map((p) => p.firstSub);
const perm = permutation(n, 187);
order = [...perm.slice(0, 34), n, perm[0]];
fault = true;
set(tick, 1);
assert.throws(() => get(c), (e) => e === firstError);
order = [...perm.slice(3, 48), n + 1, perm[4]];
assert.throws(() => get(c), (e) => e === firstError);
assert.equal(ps[n].firstSub, null);
fault = false;
order = [...perm, n + 1, perm[11]];
assert.equal(get(c), answer());
checkList(c, expected());
for (const id of perm) assert.equal(ps[id].firstSub, identities[id]);

// Promote through first subscribers, then encounter a source whose pair is
// behind the bounded subscriber search. The inner pass uses the same sources.
const shared = range(24).map(signal);
const holders = range(10).map(() => computed(() => shared.reduce((sum, s) => sum + get(s), 0)));
for (const h of holders) get(h);
const nestedTick = signal(0);
const inner = computed(() => {
  get(nestedTick);
  const seq = permutation(shared.length, nestedTick.value + 29);
  let sum = 0;
  for (const id of seq) sum += get(shared[id]);
  return sum;
});
get(inner);
ps.push(...shared);
const mixed = [...range(n), ...range(shared.length).map((id) => n + 4 + id)];
order = mixed;
set(tick, 2);
get(c);
order = [...perm.slice(0, 16), n + 4 + 18, ...perm.slice(16), ...mixed.slice(n)];
hook = () => q.untracked(() => { set(nestedTick, 1); get(inner); });
set(tick, 3);
assert.equal(get(c), answer());
checkList(c, expected());
for (const s of ps) assert.equal(s.slot, null);

// Successful observations install new subscriptions immediately. Re-reading
// a source written after its first observation must still owe a second run.
const observed = [], drive = signal(false), ws = range(64).map(signal);
const handle = effect(() => {
  const active = get(drive);
  const seq = active ? perm.filter((id) => id < ws.length) : range(ws.length);
  for (const id of seq) {
    const value = get(ws[id]);
    if (active && id === seq[16] && value === id) set(ws[id], id + 100);
  }
  observed.push(get(ws[seq[16]]));
});
set(drive, true);
assert.equal(observed.length, 3);
assert.equal(observed[1], observed[2]);
dispose(handle);
for (const s of ws) assert.equal(s.firstSub, null);

hook = () => dispose(c);
order = permutation(n, 93);
set(tick, 4);
get(c);
checkList(c, []);
for (const s of ps) {
  assert.equal(s.slot, null);
  for (let e = s.firstSub; e; e = e.nextSub) assert.notEqual(e.to, c);
}
console.log(`${distinctions} order observations and partial, nested, failure, P5 and disposal witnesses passed`);
