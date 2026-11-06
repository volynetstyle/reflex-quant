// Intrusive graph operations independent of the execution context.
import type { Edge, Flags, Node } from "./model";
import { stats } from "./instrumentation";

export function node(fn: Node["fn"], value: unknown, flags: Flags): Node {
  return {
    flags,
    value,
    ver: 0,
    fn,
    deps: null,
    last: null,
    subs: null,
    lastSub: null,
    slot: null,
    gen: 0,
  };
}

/** Move an unread edge (strictly after `next`) up to the cursor. */
export function move(c: Node, e: Edge, last: Edge | null, next: Edge): void {
  const before = e.prev!;
  const after = e.next;
  before.next = after;

  if (after !== null) after.prev = before;

  e.prev = last;
  e.next = next;

  if (last !== null) last.next = e;
  else c.deps = e;
  next.prev = e;
  c.last = e;
}

/** Remove every edge of `c` after `last` (all of them when null). */
export function cut(c: Node, last: Edge | null): void {
  let e = last === null ? c.deps : last.next;

  if (e === null) return;

  if (last === null) c.deps = null;
  else last.next = null;
  // The cut head's back pointer would tie this garbage to the live list, and
  // so to garbage cut later: old garbage keeps newer garbage alive.
  e.prev = null;

  for (; e !== null; e = e.next) unsub(e);
}

/** Take an edge out of its source's subscriber list. */
export function unsub(e: Edge): void {
  if (__STATS__) stats.unlinks++;

  const s = e.from;
  const before = e.prevSub;
  const after = e.nextSub;

  if (before !== null) before.nextSub = after;
  else s.subs = after;

  if (after !== null) after.prevSub = before;
  else s.lastSub = before;
  // Subscribers are in birth order, so an old removed edge would point at a
  // much younger one and keep it (and its watcher) alive across scavenges.
  e.prevSub = null;
  e.nextSub = null;
}
