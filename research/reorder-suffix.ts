// This fragment is inserted into the experimental kernel by reorder-build.
// It shares the existing membership, link, slot and nesting primitives.
interface Suffix {
  edges: Edge[];
  remaining: number;
  front: number;
}
let suffix: Suffix | null = null;

function openSuffix(c: Node, last: Edge | null, next: Edge): void {
  const edges: Edge[] = [];
  for (let e: Edge | null = next; e !== null; e = e.nextDep) {
    edges.push(e);
    e.ver = UNREAD;
  }
  if (__STATS__) {
    stats.sweeps++;
    stats.indexed += edges.length;
    stats.snapshots++;
    stats.savedEdges += edges.length;
  }
  suffix = { edges, remaining: edges.length, front: 0 };
  if (last === null) c.firstDep = null;
  else last.nextDep = null;
  c.lastDep = last;
}

function appendSeen(c: Node, s: Node, e: Edge, last: Edge | null): void {
  if (e.ver !== UNREAD) {
    if (__STATS__) stats.dups++;
    return;
  }
  if (__STATS__) stats.appends++;
  e.ver = s.ver;
  e.prevDep = last;
  e.nextDep = null;
  if (last === null) c.firstDep = e;
  else last.nextDep = e;
  c.lastDep = e;
  cursor = e;
  suffix!.remaining--;
}

// Materialize exactly the unread part in old order. The existing close,
// fail, detach and slot-index operations can now all use their usual list.
function closeSuffix(c: Node, last: Edge | null): void {
  const frame = suffix!;
  suffix = null;
  if (frame.remaining === 0) return;
  if (__STATS__) stats.restoreVisits += frame.edges.length;
  let tail = last;
  for (const e of frame.edges) {
    if (e.ver !== UNREAD) continue;
    if (__STATS__) stats.restoredEdges++;
    if (tail === null) c.firstDep = e;
    else tail.nextDep = e;
    e.prevDep = tail;
    tail = e;
  }
  tail!.nextDep = null;
  c.lastDep = tail;
}

function readSuffix(c: Node, s: Node, last: Edge | null): void {
  const frame = suffix!;
  const expected = frame.edges[frame.front];
  if (expected !== undefined && expected.from === s) {
    frame.front++;
    if (__STATS__) stats.snapshotHits++;
    return appendSeen(c, s, expected, last);
  }
  const first = s.firstSub;
  if (first === null || alien(first, c)) return link(c, s, last, null);
  const found = pair(first, c);
  if (found === null) return link(c, s, last, null);
  if (found !== undefined) return appendSeen(c, s, found, last);
  closeSuffix(c, last);
  const next = last === null ? c.firstDep : last.nextDep;
  index(c, next);
  slot(c, s, last, next);
}
