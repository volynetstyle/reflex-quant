// Alternate kernel fragment for reorder-build. During promotion nextDep is
// the accepted order; old prevDep links remain immutable until close.
let suffix: Edge | null = null;
let suffixTail: Edge | null = null;
let suffixLeft = 0;

function openSuffix(c: Node, last: Edge | null, next: Edge): void {
  suffix = next;
  suffixTail = c.lastDep;
  let count = 0;
  for (let e: Edge | null = next; e !== null; e = e.nextDep) {
    e.ver = UNREAD;
    count++;
  }
  suffixLeft = count;
  if (__STATS__) {
    stats.sweeps++;
    stats.indexed += count;
    stats.threadStarts++;
  }
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
  if (last === null) c.firstDep = e;
  else last.nextDep = e;
  e.nextDep = null;
  c.lastDep = e;
  cursor = e;
  suffixLeft--;
}

function closeSuffix(c: Node, last: Edge | null): void {
  const boundary = suffix!.prevDep;
  let rest: Edge | null = null;
  if (suffixLeft !== 0) {
    // Old tail → boundary visits every old suffix edge once. Prepending
    // the unread edges reconstructs their original forward order.
    for (let e = suffixTail; e !== boundary; e = e!.prevDep) {
      if (__STATS__) stats.restoreVisits++;
      if (e!.ver !== UNREAD) continue;
      if (__STATS__) stats.restoredEdges++;
      e!.nextDep = rest;
      rest = e;
    }
  }
  if (last === null) c.firstDep = rest;
  else last.nextDep = rest;
  let prev = boundary;
  for (let e = prev === null ? c.firstDep : prev.nextDep; e !== null; e = e.nextDep) {
    if (__STATS__) stats.repairVisits++;
    e.prevDep = prev;
    prev = e;
  }
  c.lastDep = prev;
  suffix = null;
  suffixTail = null;
  suffixLeft = 0;
}

function readSuffix(c: Node, s: Node, last: Edge | null): void {
  const firstOld = suffix!;
  if (firstOld.from === s) {
    if (__STATS__) stats.snapshotHits++;
    return appendSeen(c, s, firstOld, last);
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
