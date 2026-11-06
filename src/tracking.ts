// Exact dependency tracking: resolve a read outside the stable cursor path.
// Slot walks and edge creation remain in the kernel because they mutate its shared stack.
import { Flag, SCAN, UNREAD } from "./flags";
import type { Edge, Node } from "./model";
import { move } from "./graph";
import { index, link } from "./kernel";
import { stats } from "./instrumentation";

/** A read that is not the next edge in read order. Every answer is exact. */
export function miss(
  c: Node,
  s: Node,
  last: Edge | null,
  next: Edge | null,
): void {
  if (last !== null && last.from === s) {
    if (__STATS__) stats.repeats++;

    last.ver = s.ver;
    return;
  }

  if ((c.flags & Flag.Indexed) === 0) {
    // A source without subscribers is absent.
    if (s.subs === null) return link(c, s, last, next, false);
    // An edge found by a scan is the pair's only one; absence needs one side
    // scanned completely (this reader's list, or the source's subscribers).
    let e = next !== null ? next.next : null;
    let budget = SCAN;

    while (e !== null && e.from !== s && --budget !== 0) e = e.next;

    if (e !== null && e.from === s) {
      if (__STATS__) stats.scans++;

      e.ver = s.ver;
      return move(c, e, last, next!);
    }
    let p = last !== null ? last.prev : null;
    budget = SCAN;

    while (p !== null && p.from !== s && --budget !== 0) p = p.prev;

    if (p !== null && p.from === s) {
      if (__STATS__) stats.dups++;

      p.ver = s.ver;
      return;
    }

    if ((e === null && p === null) || absent(s, c) === true)
      return link(c, s, last, next, false);
    index(c, next);
  }

  if (__STATS__) stats.lookups++;

  const cell = s.slot;

  if (cell !== null && cell.to === c) {
    if (cell.ver !== UNREAD) {
      if (__STATS__) stats.dups++;

      cell.ver = s.ver;
      return;
    }

    if (__STATS__) stats.moves++;

    cell.ver = s.ver;
    return move(c, cell, last, next!);
  }
  link(c, s, last, next, true);
}

/** No edge to `c` among the source's few subscribers. */
function absent(s: Node, c: Node): boolean {
  let budget = SCAN;

  for (let e = s.subs; e !== null; e = e.nextSub)
    if (e.to === c || --budget === 0) return false;

  return true;
}
