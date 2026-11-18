// Physical interventions on raw Quant nodes. All permutations, oracle checks
// and scratch storage are outside the timed step. Birth rank is a placement
// proxy: V8 is free to relocate objects during promotion.
import assert from "node:assert/strict";
import { permutation, range } from "../scaling.mjs";

const sizes = [512, 1024, 2048, 4096, 8192];
const ordered = (n, random, seed) => random ? permutation(n, seed) : range(n);

// Visit edge and source birth ranks independently while keeping logical ID i
// at position i. Each edge still belongs to its original source.
function fixture(q, n, randomEdges, randomSources) {
  const edgeRank = ordered(n, randomEdges, 1777);
  const sourceRank = ordered(n, randomSources, 8339);
  const values = new Array(n);
  for (let i = 0; i < n; i++) values[sourceRank[i]] = i;
  const sources = values.map((value) => q.signal(value));
  const birth = new Array(n);
  for (let i = 0; i < n; i++) birth[edgeRank[i]] = sources[sourceRank[i]];
  const c = q.computed(() => {
    let sum = 0;
    for (const s of birth) sum += q.get(s);
    return sum;
  });
  assert.equal(q.get(c), n * (n - 1) / 2);
  const edges = [];
  for (let e = c.firstDep; e; e = e.nextDep) edges.push(e);
  const visit = edgeRank.map((rank) => edges[rank]);
  for (let i = 0; i < n; i++) {
    visit[i].prevDep = visit[i - 1] ?? null;
    visit[i].nextDep = visit[i + 1] ?? null;
    assert.equal(visit[i].from.value, i);
    assert.equal(visit[i].from.firstSub, visit[i]);
  }
  c.firstDep = visit[0];
  c.lastDep = visit[n - 1];
  return { c, visit };
}

function walk(q, n, layout, operation) {
  const { c, visit } = fixture(q, n, layout[0] === "r", layout[1] === "r");
  // Two enumerators touch identical edges in identical logical order.
  const step = {
    chain: (i) => {
      for (let e = c.firstDep; e; e = e.nextDep) e.ver = i;
      return c.lastDep.ver;
    },
    vector: (i) => {
      for (let k = 0; k < visit.length; k++) visit[k].ver = i;
      return c.lastDep.ver;
    },
    slots: (i) => {
      for (let e = c.firstDep; e; e = e.nextDep) e.from.slot = e;
      for (let e = c.firstDep; e; e = e.nextDep) e.from.slot = null;
      return c.lastDep.from.slot === null ? i : -i;
    },
  }[operation];
  assert.equal(step(31), 31);
  for (const e of visit) {
    assert.equal(e.ver, operation === "slots" ? 0 : 31);
    assert.equal(e.from.slot, null);
  }
  return step;
}

// All cells carry the same four source AND edge schedules. Only the locator
// changes. tile1/tile32 also use exactly the same two-loop scratch program.
function splice(q, n, mode) {
  const { c, visit } = fixture(q, n, false, false);
  const sources = visit.map((e) => e.from);
  for (const e of visit) e.from.slot = e;
  const orders = range(4).map((k) => permutation(n, 0x9e3779b9 + k));
  const direct = orders.map((order) => order.map((k) => visit[k]));
  const nodes = orders.map((order) => order.map((k) => sources[k]));
  const scratch = new Array(32).fill(null);
  const tile = mode === "tile32" ? 32 : 1;
  const move = q.move;
  function immediate(i) {
    const ps = nodes[i & 3], es = direct[i & 3];
    let last = null;
    for (let k = 0; k < n; k++) {
      const s = ps[k];
      const e = mode === "known" ? es[k] : s.slot;
      e.ver = s.ver;
      const next = last === null ? c.firstDep : last.nextDep;
      if (e !== next) move(c, e, last, next);
      last = e;
    }
    return c.firstDep.from.value;
  }
  function tiled(i) {
    const ps = nodes[i & 3];
    let last = null;
    for (let base = 0; base < n; base += tile) {
      const end = Math.min(tile, n - base);
      for (let j = 0; j < end; j++) {
        const s = ps[base + j];
        const e = s.slot;
        e.ver = s.ver;
        scratch[j] = e;
      }
      for (let j = 0; j < end; j++) {
        const e = scratch[j];
        const next = last === null ? c.firstDep : last.nextDep;
        if (e !== next) move(c, e, last, next);
        last = e;
      }
    }
    return c.firstDep.from.value;
  }
  const step = mode.startsWith("tile") ? tiled : immediate;
  for (let i = 0; i < 4; i++) {
    assert.equal(step(i), orders[i][0]);
    let prev = null, e = c.firstDep;
    for (const id of orders[i]) {
      assert.equal(e, visit[id]);
      assert.equal(e.prevDep, prev);
      assert.equal(e.ver, e.from.ver);
      prev = e;
      e = e.nextDep;
    }
    assert.equal(e, null);
    assert.equal(prev, c.lastDep);
  }
  return step;
}

// Same N distinct lines and same offsets modulo 4 KiB. One address per
// 64-byte line versus one per 4 KiB page. This changes page footprint AND
// prefetch opportunities; it is a translation-pressure control, not a PMU.
function pages(n, sparse) {
  const data = new Int32Array(n * (sparse ? 1024 : 16));
  const indices = permutation(n, 54843).map((id) => {
    const pos = sparse ? id * 1024 + (id % 64) * 16 : id * 16;
    data[pos] = id;
    return pos;
  });
  const step = () => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[indices[i]];
    return sum;
  };
  assert.equal(step(), n * (n - 1) / 2);
  return step;
}

export const scenarios = sizes.flatMap((n) => [
  ...["ss", "sr", "rs", "rr"].flatMap((layout) =>
    (layout === "ss" || layout === "rr" ? ["slots", "chain", "vector"] : ["slots"]).map((op) =>
      ({ id: `walk.${layout}.${op}@${n}`, n, setup: (q) => walk(q, n, layout, op) }))),
  ...["known", "indirect", "tile1", "tile32"].map((mode) =>
    ({ id: `splice.${mode}@${n}`, n, setup: (q) => splice(q, n, mode) })),
  ...["packed", "sparse"].map((mode) =>
    ({ id: `pages.${mode}@${n}`, n, setup: () => pages(n, mode === "sparse") })),
]);
