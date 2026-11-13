// What happens to one consumer's dependency list when it reads its sources in a new order.
// Two models, both checked against the real, instrumented libraries by scripts/validate-reorder.mjs:
//
//   quant  The kernel's tracking tiers (src/kernel.ts, `read`, `miss`, `near`; LOG 47) for one
//          consumer whose sources nobody else reads. The list is kept in read order; the cursor
//          stands after the relations this pass has read. A read is, in this order:
//            hit     the relation under the cursor;
//            repeat  the relation behind the cursor, or one the prefix scan or a lookup finds
//                    already read: nothing moves;
//            new     a source with no relation: a new one at the cursor;
//            move    in a marked pass, the relation found through the source's subscribers,
//                    moved to the cursor;
//            tail    one of the last 2 relations (an edge deferred earlier, or a source moved to
//                    the front), moved to the cursor;
//            defer   a relation up to 8 past the cursor's: the relation under the cursor goes to
//                    the end of the list (read later or never), and the found one, unless it was
//                    right behind it, moves to the cursor.
//          A read the scans do not settle marks the pass: from then on every out-of-place read is a
//          move. After the pass, relations not read are removed.
//   alien  alien-signals 3.2.1, link() and purgeDeps(): a read reuses the next link only if it is
//          the very next one; otherwise a new link is inserted after the tail. Links left after the
//          tail at the end of the pass are unlinked, including the old links of re-read sources.

export type Kind = "hit" | "repeat" | "new" | "move" | "defer" | "tail";
export type Ev = { src: string; kind: Kind; list: string[]; cursor: number; deferred?: string };
export type Pass = {
  list: string[];
  created: number;
  removed: number;
  hits: number;
  /** Relations reused out of place: move + defer + tail. */
  moved: number;
  /** Per kind, as the kernel counts them (validate-reorder.mjs). */
  counts: Record<Kind, number>;
  /** The pass marked its unread suffix. */
  marked: boolean;
  events: Ev[];
  dropped: string[];
};

/** The kernel's scan budgets (graph.ts SCAN, TAIL). */
const SCAN = 8, TAIL = 2;

/** One pass of quant over a consumer whose sources nobody else reads. */
export function quantPass(prev: readonly string[], reads: readonly string[]): Pass {
  const list = [...prev], events: Ev[] = [];
  const counts: Record<Kind, number> = { hit: 0, repeat: 0, new: 0, move: 0, defer: 0, tail: 0 };
  let c = 0, marked = false;
  const toCursor = (at: number) => { const [s] = list.splice(at, 1); list.splice(c, 0, s); };
  const toEnd = (at: number) => { const [s] = list.splice(at, 1); list.push(s); return s; };

  for (const s of reads) {
    let kind: Kind, deferred: string | undefined;
    const at = list.indexOf(s);

    if (c < list.length && list[c] === s) { kind = "hit"; c++; }
    else if (c > 0 && list[c - 1] === s) kind = "repeat";
    else if (at < 0) { list.splice(c++, 0, s); kind = "new"; }
    else if (marked && c < list.length) {
      // The pair through the source's subscribers: an unread relation moves, a read one repeats.
      if (at > c) { toCursor(at); c++; kind = "move"; } else kind = "repeat";
    } else {
      const n = list.length;
      // Positions the kernel compares: the last 2 down to the cursor's, up to 8 past the
      // cursor's, then up to 8 behind the cursor.
      const tailFrom = Math.max(c + 1, n - TAIL);
      if (c < n && at >= tailFrom) { toCursor(at); c++; kind = "tail"; }
      else if (c < n && at > c && at <= c + SCAN) { deferred = toEnd(c); if (at > c + 1) toCursor(at - 1); c++; kind = "defer"; }
      else if (at < c && at >= c - 1 - SCAN) kind = "repeat";
      else {
        // Not settled by the scans: the lookup finds the relation, and marks the unread suffix.
        if (c < n) marked = true;
        if (at > c) { toCursor(at); c++; kind = "move"; } else kind = "repeat";
      }
    }
    counts[kind]++;
    events.push({ src: s, kind, list: [...list], cursor: c, ...(deferred ? { deferred } : {}) });
  }
  const dropped = list.splice(c);
  return {
    list, created: counts.new, removed: dropped.length, hits: counts.hit,
    moved: counts.move + counts.defer + counts.tail, counts, marked, events, dropped,
  };
}

export function alienPass(prev: readonly string[], reads: readonly string[]): Pass {
  // A link is [source, readThisPass]; the list may hold two links to one source until the purge.
  const list: [string, boolean][] = prev.map((s) => [s, false]), events: Ev[] = [];
  const counts: Record<Kind, number> = { hit: 0, repeat: 0, new: 0, move: 0, defer: 0, tail: 0 };
  let t = -1;
  for (const s of reads) {
    let kind: Kind;
    if (t >= 0 && list[t][0] === s) kind = "repeat";                      // same as the previous read
    else if (t + 1 < list.length && list[t + 1][0] === s) { list[++t][1] = true; kind = "hit"; }
    else if (list.some(([x, r]) => x === s && r)) kind = "repeat";        // linked earlier this pass
    else { list.splice(++t, 0, [s, true]); kind = "new"; }
    counts[kind]++;
    events.push({ src: s, kind, list: list.map(([x]) => x), cursor: t + 1 });
  }
  const dropped = list.splice(t + 1).map(([x]) => x);
  return {
    list: list.map(([x]) => x), created: counts.new, removed: dropped.length, hits: counts.hit,
    moved: 0, counts, marked: false, events, dropped,
  };
}
