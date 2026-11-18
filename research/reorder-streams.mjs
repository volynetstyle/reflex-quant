// Count JS field operations on the exact already-built probe fixtures. The
// accessors deliberately change object shapes and run only outside timing.
import assert from "node:assert/strict";
import { scenarios } from "../bench/cost/locality.mjs";
import * as raw from "../.cache/cost/quant-internals/index.mjs";

function count(id) {
  const nodes = [], consumers = [];
  let moves = 0, tailMoves = 0;
  const q = {
    ...raw,
    signal(value) { const s = raw.signal(value); nodes.push(s); return s; },
    computed(fn) { const c = raw.computed(fn); consumers.push(c); return c; },
    move(c, e, last, next) {
      moves++;
      // A tail moves its predecessor into c.lastDep. Count those stores
      // through the accessor below, without instrumenting the predicate.
      raw.move(c, e, last, next);
    },
  };
  const scenario = scenarios.find((s) => s.id === id);
  const step = scenario.setup(q);
  moves = 0;
  const reads = {}, writes = {};
  const edgeOwner = new Map(nodes.map((s) => [s.firstSub, s]));
  function watch(obj, field, group) {
    let value = obj[field];
    const key = group + "." + field;
    Object.defineProperty(obj, field, {
      get() {
        reads[key] = (reads[key] ?? 0) + 1;
        return value;
      },
      set(v) {
        writes[key] = (writes[key] ?? 0) + 1;
        if (key === "source.slot") {
          if (v !== null) { assert.equal(edgeOwner.get(v), obj); assert.equal(value, null); }
          else assert.equal(edgeOwner.get(value), obj);
        } else if (key === "consumer.lastDep") tailMoves++;
        value = v;
      },
    });
  }
  for (const [e, s] of edgeOwner) {
    for (const f of ["slot", "firstSub", "ver", "value"]) watch(s, f, "source");
    for (const f of ["from", "to", "ver", "nextDep", "prevDep", "nextSub", "prevSub"]) watch(e, f, "edge");
  }
  for (const c of consumers) for (const f of ["firstDep", "lastDep"]) watch(c, f, "consumer");
  for (let i = 4; i < 8; i++) step(i);
  if (id.includes(".slots@")) assert.equal(writes["source.slot"], 8 * scenario.n);
  if (id.startsWith("splice.")) {
    assert.equal(writes["edge.ver"], 4 * scenario.n);
    assert.equal(writes["edge.nextDep"] + writes["edge.prevDep"] + (writes["consumer.firstDep"] ?? 0) + tailMoves, 6 * moves);
  }
  return { id, passes: 4, moves, tailMoves, reads, writes };
}
const ids = ["walk.ss.slots", "walk.rr.slots", "walk.rr.chain", "walk.rr.vector",
  "splice.known", "splice.indirect", "splice.tile1", "splice.tile32"];
const rows = ids.map((id) => count(id + "@4096"));
const splices = rows.filter((r) => r.id.startsWith("splice."));
for (const r of splices) {
  assert.equal(r.moves, splices[0].moves);
  assert.deepEqual(r.writes, splices[0].writes);
}
console.log(JSON.stringify(rows, null, 2));
