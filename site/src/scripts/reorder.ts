// What happens to one consumer's dependency list when it reads its sources in a new order.
// Two models, both checked against the real, instrumented libraries by scripts/validate-reorder.mjs:
//
//   quant  The list is kept in read order. A read that matches the relation under the cursor is a
//          hit; any other read of a known source moves that relation to the cursor (found by scan,
//          lookup or index: the model does not say which); an unknown source gets a new relation.
//          After the pass, relations not read are removed. So a permutation creates and removes none.
//   alien  alien-signals 3.2.1, link() and purgeDeps(): a read reuses the next link only if it is
//          the very next one; otherwise a new link is inserted after the tail. Links left after the
//          tail at the end of the pass are unlinked, including the old links of re-read sources.

export type Ev = { src: string; kind: "hit" | "move" | "new" | "repeat"; list: string[] };
export type Pass = { list: string[]; created: number; removed: number; hits: number; moved: number; events: Ev[]; dropped: string[] };

export function quantPass(prev: readonly string[], reads: readonly string[]): Pass {
  const list = [...prev], events: Ev[] = [];
  let c = 0, created = 0, hits = 0, moved = 0;
  for (const s of reads) {
    const at = list.indexOf(s);
    let kind: Ev["kind"];
    if (at === c) { kind = "hit"; hits++; c++; }
    else if (at >= 0 && at < c) kind = "repeat";               // already read in this pass
    else if (at > c) { list.splice(at, 1); list.splice(c++, 0, s); kind = "move"; moved++; }
    else { list.splice(c++, 0, s); kind = "new"; created++; }
    events.push({ src: s, kind, list: [...list] });
  }
  const dropped = list.splice(c);
  return { list, created, removed: dropped.length, hits, moved, events, dropped };
}

export function alienPass(prev: readonly string[], reads: readonly string[]): Pass {
  // A link is [source, readThisPass]; the list may hold two links to one source until the purge.
  const list: [string, boolean][] = prev.map((s) => [s, false]), events: Ev[] = [];
  let t = -1, created = 0, hits = 0;
  for (const s of reads) {
    let kind: Ev["kind"];
    if (t >= 0 && list[t][0] === s) kind = "repeat";                      // same as the previous read
    else if (t + 1 < list.length && list[t + 1][0] === s) { list[++t][1] = true; kind = "hit"; hits++; }
    else if (list.some(([x, r]) => x === s && r)) kind = "repeat";        // linked earlier this pass
    else { list.splice(++t, 0, [s, true]); kind = "new"; created++; }
    events.push({ src: s, kind, list: list.map(([x]) => x) });
  }
  const dropped = list.splice(t + 1).map(([x]) => x);
  return { list: list.map(([x]) => x), created, removed: dropped.length, hits, moved: 0, events, dropped };
}
