// Reactive kernel: tracking, propagation, validation and execution.
// Detached edges must not retain pointers into live lists.
// See research/LOG.md for representation rationale.

import {
  Flag,
  KEEP,
  CounterLimit,
  SCAN,
  SETTLE,
  TAIL,
  TRIM,
  UNREAD,
  cutDeps,
  moveDep,
  settleDeps,
  skipDep,
  unlinkSub,
} from "./graph";
import type { Edge, Flags, Node, WorkStack } from "./graph";
import { stats } from "./instrumentation";

export { createNode } from "./graph";
export { stats } from "./instrumentation";

const compare = Object.is;

/** The running consumer, or null outside a tracking pass. */
let active: Node | null = null;
/** Last accepted edge of the running pass; saved with `active` on nesting. */
let cursor: Edge | null = null;
/**
 * One LIFO work stack shared by all walks: sibling edges to resume (mark),
 * edges to climb back through (pull), and slot cells an indexed run displaced.
 * Every walk pops back to its own base before returning. Once the stack is
 * empty, an oversized buffer is cut back (`trim`).
 */
const stack: WorkStack = new Array(256).fill(null);
/** First free index of `stack`. */
let top = 0;
/** Longest the work stack has been when `trim` cut it (research). */
let peak = 0;
let wake: (w: Node) => void = () => {};

/**
 * The host is told about every watcher a write or mark reaches. It owns the
 * deduplication (a queued watcher is not queued again), so a watcher left
 * STALE by a failed check is delivered again by the next push.
 */
export function onWake(fn: (w: Node) => void): void {
  wake = fn;
}

/** No tracked consumer or occupied work-stack slot (tests; untracked suspends cursor). */
export function idle(): boolean {
  return active === null && top === 0;
}

/**
 * Deepest work-stack top reached so far (research). Walks null the slots
 * they pop and only `trim` shrinks the array, so the high-water mark is its
 * length or the longest length `trim` cut.
 */
export function stackHighWater(): number {
  return stack.length > peak ? stack.length : peak;
}

/** Slots the work stack holds now (tests). */
export function stackLength(): number {
  return stack.length;
}

/**
 * When empty, cut a stack that a deep walk grew past TRIM back to KEEP slots,
 * so one deep walk does not hold its depth in memory for good. Setting the
 * length right-trims V8's backing store in place: no allocation, and the
 * array stays packed.
 *
 * Only walks that push check at their exits: mark, verify (also on failure),
 * and unindex. An empty stack has no entries to preserve even if a user
 * callback or a graph cursor is suspended in local variables. `active`
 * is a tracking context, not a call-depth counter (untracked clears it).
 * The length test comes first: a small buffer pays no load of `top`.
 */
function trim(): void {
  if (stack.length > TRIM && top === 0) {
    if (__STATS__ && stack.length > peak) peak = stack.length;

    stack.length = KEEP;
  }
}

// ------------------------------------------------------------------- write

export function write(s: Node, value: unknown): void {
  if (compare(s.value, value)) return;

  s.value = value;
  s.ver = (s.ver + 1) & CounterLimit.Mask;

  for (let e = s.firstSub; e !== null; e = e.nextSub) {
    const n = e.to;
    const f = n.flags;

    if (__STATS__) stats.marks++;

    if ((f & Flag.Busy) !== 0) {
      // Running: it may not have read s yet, so versions decide.
      if ((f & Flag.Stale) === 0) {
        n.flags = f | Flag.Stale;

        if ((f & Flag.Watch) !== 0) wake(n);
        else {
          const subs = n.firstSub;

          if (subs !== null) mark(subs);
        }
      }
    } else if ((f & Flag.Watch) !== 0) {
      n.flags = f | Flag.Dirty | Flag.Woken;

      wake(n);
    } else if ((f & Flag.Stale) !== 0) {
      n.flags = f | Flag.Dirty;
    } else {
      n.flags = f | Flag.Dirty | Flag.Stale;

      const subs = n.firstSub;

      if (subs !== null) mark(subs);
    }
  }
}

/** Mark everything below the subscriber list `first` STALE, depth first. */
function mark(first: Edge): void {
  const base = top;
  let e: Edge | null = first;

  for (;;) {
    while (e !== null) {
      const n: Node = e.to;
      const f = n.flags;

      if (__STATS__) stats.marks++;
      // A watcher has no subscribers; the host deduplicates, so it is always told.
      if ((f & Flag.Watch) !== 0) {
        n.flags = f | Flag.Stale;
        wake(n);
      } else if ((f & Flag.Stale) === 0) {
        n.flags = f | Flag.Stale;

        const subs = n.firstSub;

        if (subs !== null) {
          const next = e.nextSub;

          if (next !== null) stack[top++] = next;

          e = subs;
          continue;
        }
      }
      e = e.nextSub;
    }

    if (top === base) {
      trim();
      return;
    }

    e = stack[--top] as Edge;
    stack[top] = null;
  }
}

// -------------------------------------------------------------------- read

/** Bring `n` up to date if it is a stale computed, then track it. */
export function read(n: Node): unknown {
  const value = peek(n);
  const c = active;

  if (c !== null) {
    if (__STATS__) stats.reads++;

    const last = cursor;
    const next = last === null ? c.firstDep : last.nextDep;

    if (next !== null && next.from === n) {
      if (__STATS__) stats.hits++;

      cursor = next;
      next.ver = n.ver;
    } else if (last !== null) {
      // The cursor's own source again: a repeat keeps its first observation
      // (P5); anything else is resolved by `miss`.
      if (last.from !== n) miss(c, n, last, next);
      else if (__STATS__) stats.repeats++;
    } else if (next !== null) miss(c, n, last, next);
    // No relation yet: the first read of a first run links at once.
    else link(c, n, null, null);
  }
  return value;
}

/** `read` without its tracking half: bring `n` up to date, record no relation. */
export function peek(n: Node): unknown {
  if ((n.flags & Flag.Pull) !== 0) pull(n);

  return n.value;
}

/**
 * Pull a computed up to date. Existential, in read order: sources are
 * checked first to last and the first changed one makes the node run. A
 * STALE source is descended into (the stack keeps the edge to climb back
 * through); a DIRTY one runs. A throw leaves every node on the walk DIRTY.
 * A node whose run is on the stack is a cycle. A development build also
 * diagnoses a node whose validation is on the stack (CHECKING): C1 is a
 * precondition, so its committed value never answers such a demand there.
 */
function pull(root: Node): void {
  const f = root.flags;

  if ((f & Flag.Active) !== 0) throw new Error("Cycle detected");

  if ((f & Flag.Dirty) !== 0) return exec(root);

  verify(root, f);
}

/**
 * The walk of `pull` for a STALE node that is not DIRTY, BUSY or CHECKING;
 * kept apart so `pull` stays small. A node disposed during the walk is not
 * run (W3), nor left DIRTY.
 *
 * Development builds diagnose C1: a node on the walk is CHECKING until it is
 * clean or runs, and a source on the stack (BUSY or CHECKING) is a cycle
 * even when no push marked it again, since its version is not yet a fact.
 * CHECKING is set by the store that clears STALE and cleared by `exec` as it
 * sets BUSY; only a node found clean pays a store of its own. Production
 * builds compile all of it away.
 */
function verify(root: Node, f: Flags): void {
  root.flags = __DEV__ ? (f & ~Flag.Stale) | Flag.Checking : f & ~Flag.Stale;
  const base = top;
  let n = root;
  let e = root.firstDep;

  try {
    for (;;) {
      settled: {
        while (e !== null) {
          const s: Node = e.from;
          const sf = s.flags;

          if (__STATS__) stats.checks++;

          if ((sf & (__DEV__ ? Flag.Pull : Flag.Pending)) !== 0) {
            if ((sf & Flag.Active) !== 0) throw new Error("Cycle detected");

            if ((sf & Flag.Dirty) === 0) {
              s.flags = __DEV__
                ? (sf & ~Flag.Stale) | Flag.Checking
                : sf & ~Flag.Stale;
              stack[top++] = e;
              n = s;
              e = s.firstDep;
              continue;
            }
            exec(s);
          }

          if (s.ver !== e.ver) {
            if (n.fn !== null) exec(n);
            break settled;
          }
          e = e.nextDep;
        }
        // Every source unchanged: clean, and no longer on the walk.
        if (__DEV__) n.flags &= ~Flag.Checking;
      }

      // Climb; a parent whose child changed runs as well.
      for (;;) {
        if (top === base) {
          trim();

          return;
        }

        const up = stack[--top] as Edge;
        stack[top] = null;
        n = up.to;

        if (up.from.ver === up.ver) {
          e = up.nextDep;
          break;
        }

        if (n.fn !== null) exec(n);
      }
    }
  } catch (error) {
    if (n.fn !== null)
      n.flags = __DEV__
        ? (n.flags | Flag.Dirty) & ~Flag.Checking
        : n.flags | Flag.Dirty;

    while (top > base) {
      const p = (stack[--top] as Edge).to;

      if (p.fn !== null)
        p.flags = __DEV__
          ? (p.flags | Flag.Dirty) & ~Flag.Checking
          : p.flags | Flag.Dirty;
      stack[top] = null;
    }
    trim();
    throw error;
  }
}

/**
 * Universal check of a watcher: pull every committed source, so a throwing
 * one surfaces before any irreversible step. Marks DIRTY on change. Tentative
 * edges (reads of a failed run) only wake; they exist only while a run is
 * owed, and then versions need no comparison.
 */
export function check(w: Node): void {
  const tentative = (w.gen + 1) & CounterLimit.Mask;
  let e = w.firstDep;

  // Until a run is owed, versions decide; then only the pulls remain. A
  // development build pulls a source on the stack too, so the C1 diagnosis
  // fails here, before the cleanup (P4).
  if ((w.flags & Flag.Dirty) === 0) {
    for (; e !== null; e = e.nextDep) {
      const s = e.from;

      if (__STATS__) stats.checks++;

      if (
        (s.flags & (__DEV__ ? Flag.Pull : Flag.Pending)) !== 0 &&
        e.gen !== tentative
      )
        pull(s);

      if (s.ver !== e.ver) {
        w.flags |= Flag.Dirty;
        e = e.nextDep;
        break;
      }
    }
  }

  for (; e !== null; e = e.nextDep) {
    if (__STATS__) stats.checks++;

    const s = e.from;

    if (
      (s.flags & (__DEV__ ? Flag.Pull : Flag.Pending)) !== 0 &&
      e.gen !== tentative
    )
      pull(s);
  }
}

export function untracked<T>(fn: () => T): T {
  const prev = active;
  active = null;

  try {
    return fn();
  } finally {
    active = prev;
  }
}

// --------------------------------------------------------------------- run

/** Run `n.fn` as a tracking pass; commit value and edges on success. */
export function exec(n: Node): void {
  const prev = active;
  const prevCursor = cursor;
  const base = top;

  if (__STATS__) stats.runs++;
  // Cleared before the run: a push during it marks the node again. In a
  // development build a computed's validation ends here, BUSY taking over
  // from CHECKING; on a watcher the bit is WOKEN, which this run discharges.
  n.flags =
    (n.flags & ~(__DEV__ ? Flag.PendingMarked : Flag.Pending)) | Flag.Busy;
  active = n;
  cursor = null;
  let value: unknown;

  try {
    value = n.fn!(n.value);
  } catch (error) {
    const last = cursor as Edge | null;
    active = prev;
    cursor = prevCursor;
    fail(n, base, last);
    throw error;
  }
  const last = cursor as Edge | null;
  active = prev;
  cursor = prevCursor;
  const f = n.flags;

  if (last !== null && last.from.slot === last) unindex(n, base);

  n.flags = f & ~Flag.Busy;

  if (n.fn === null) return detach(n);
  // Commit only after a successful run. Dropping the unread suffix removes
  // sources that this pass no longer depends on.
  if ((last === null ? n.firstDep : last.nextDep) !== null) cutDeps(n, last);

  n.gen = (n.gen + 1) & CounterLimit.Mask;

  // Every edge is committed now; see SETTLE.
  if ((n.gen & SETTLE) === 0) settleDeps(n);

  if (compare(value, n.value) === false) {
    n.value = value;
    n.ver = (n.ver + 1) & CounterLimit.Mask;
  }
}

/**
 * A failed run: keep committed edges and this run's reads as the wake set,
 * drop unread edges earlier failed runs left behind, owe a run.
 */
function fail(n: Node, base: number, last: Edge | null): void {
  if (last !== null && last.from.slot === last) unindex(n, base);

  n.flags &= ~Flag.Busy;

  if (n.fn === null) return detach(n);

  n.flags |= Flag.Dirty;
  const tentative = (n.gen + 1) & CounterLimit.Mask;
  for (let e = last === null ? n.firstDep : last.nextDep; e !== null;) {
    const after: Edge | null = e.nextDep;

    if (e.gen === tentative) {
      const before = e.prevDep;

      if (before !== null) before.nextDep = after;
      else n.firstDep = after;

      if (after !== null) after.prevDep = before;
      else n.lastDep = before;

      unlinkSub(e);
      e.prevDep = null;
      e.nextDep = null;
    }
    e = after;
  }
}

/** Detach `n` from its sources for good; inside its own run, at its end. */
export function dispose(n: Node): void {
  if (n.fn === null) return;

  n.fn = null;

  if ((n.flags & Flag.Busy) === 0) detach(n);
}

function detach(n: Node): void {
  cutDeps(n, null);
  n.flags &= ~Flag.PendingMarked;
}

// ---------------------------------------------------------------- tracking

/** Put every edge of `c` into its source's slot; mark the unread ones. */
export function index(c: Node, next: Edge | null): void {
  if (__STATS__) stats.indexes++;

  let unread = false;

  for (let e = c.firstDep; e !== null; e = e.nextDep) {
    if (__STATS__) stats.indexed++;

    if (e === next) unread = true;

    if (unread) e.ver = UNREAD;

    claim(e.from, e);
  }
}

/**
 * Point the source's slot at `e`, keeping a displaced cell to give back.
 * A cell's immutable `from` is its source, so the cell alone is enough.
 */
export function claim(s: Node, e: Edge): void {
  const cell = s.slot;

  if (cell !== null) stack[top++] = cell;
  s.slot = e;
}

/** Clear the run's slots, give back the cells it displaced. */
function unindex(n: Node, base: number): void {
  for (let e = n.firstDep; e !== null; e = e.nextDep) e.from.slot = null;

  while (top > base) {
    const cell = stack[--top] as Edge;
    stack[top] = null;
    cell.from.slot = cell;
  }
  trim();
}

/** A new edge at the cursor, appended to the source's subscribers. */
export function link(
  c: Node,
  s: Node,
  last: Edge | null,
  next: Edge | null,
): void {
  if (__STATS__) stats.links++;

  const first = s.firstSub;
  const tail = first !== null ? first.prevSub : null;
  const e: Edge = {
    from: s,
    to: c,
    ver: s.ver,
    gen: (c.gen + 1) & CounterLimit.Mask,
    prevDep: last,
    nextDep: next,
    prevSub: tail,
    nextSub: null,
  };

  if (last !== null) last.nextDep = e;
  else c.firstDep = e;

  if (next !== null) next.prevDep = e;
  else c.lastDep = e;

  if (first !== null) {
    tail!.nextSub = e;
    first.prevSub = e;
  } else {
    s.firstSub = e;
    e.prevSub = e;
  }
  cursor = e;
}

// Exact dependency tracking: resolve a read outside the stable cursor path.
// Proofs come cheapest first: in `read`, the edge after the cursor, the
// cursor's own (a repeat) and an empty list (the first relation); then a
// source nobody reads or whose at most two subscribers are other readers,
// bounded scans of this reader's list, and the source's first subscribers.
// Only a source with more subscribers than the budget needs the slot index. Slot walks and edge creation remain in the kernel because
// they mutate its shared stack.

/**
 * A read that is neither the next edge in read order, nor the cursor's, nor
 * the first relation of an empty list. Every answer is exact. A repeated read
 * keeps the version of the pass's first observation (P5): a change between
 * the two reads stays visible to the next validation.
 */
function miss(c: Node, s: Node, last: Edge | null, next: Edge | null): void {
  // An indexed pass owns its cursor's source slot. Nested passes restore it.
  if (last !== null && last.from.slot === last) return slot(c, s, last, next);
  const first = s.firstSub;

  // Absent, whatever the unread suffix mode: a source nobody reads, or one
  // whose first and last subscribers, all it has, are other readers.
  if (first === null || alien(first, c)) return link(c, s, last, next);

  // Marking, moves and links preserve a continuous UNREAD suffix.
  if (next !== null && next.ver === UNREAD)
    return settle(c, s, last, next, pair(first, c));

  near(c, s, last, next, first);
}

/** A miss that neither source proves absent nor a marked pass looks up. */
function near(
  c: Node,
  s: Node,
  last: Edge | null,
  next: Edge | null,
  first: Edge,
): void {
  // Bounded scans of this reader's list: the unread suffix from its end and
  // after `next` (a match is the pair's only edge), the accepted prefix (a
  // match is a repeat). Absence needs one side scanned completely: this
  // reader's list, or the source's subscribers.
  let e: Edge | null = null;

  if (next !== null) {
    // The end holds the edges reads skipped (below), the latest last: read
    // after all (a swap, a reversal), or a source moved to the front.
    let budget = TAIL;
    e = c.lastDep!;

    while (e !== next && e.from !== s && --budget !== 0) e = e.prevDep!;

    if (e.from === s) {
      if (__STATS__) stats.tails++;

      e.ver = s.ver;
      cursor = e;
      return moveDep(c, e, last, next);
    }
    budget = SCAN;
    e = next.nextDep;

    while (e !== null && e.from !== s && --budget !== 0) e = e.nextDep;

    if (e !== null && e.from === s) {
      if (__STATS__) stats.scans++;

      e.ver = s.ver;
      cursor = e;
      // `next` was skipped: read later or never (a deletion, a rotation, a
      // later move). Left in place it would stand before every following
      // read; at the end it does not, and the scan above finds it there.
      return skipDep(c, last, next, e);
    }
  }
  let p = last !== null ? last.prevDep : null;
  let budget = SCAN;

  while (p !== null && p.from !== s && --budget !== 0) p = p.prevDep;

  if (p !== null && p.from === s) {
    if (__STATS__) stats.dups++;

    return;
  }

  if (e === null && p === null) return link(c, s, last, next);

  lookup(c, s, last, next, first);
}

/**
 * The source's first subscribers decide what the reader's list could not.
 * Found as the first one: a lookup through the subscribers costs no load
 * beyond the read itself, so mark the unread suffix and let the rest of the
 * pass find its pairs that way, with no slot to fill or clear. Found deeper:
 * every lookup would walk other readers' edges, so index; either way the
 * found edge is taken at once.
 */
function lookup(
  c: Node,
  s: Node,
  last: Edge | null,
  next: Edge | null,
  first: Edge,
): void {
  const found = pair(first, c);

  if (found !== null && found !== undefined) begin(c, found, first, next);

  settle(c, s, last, next, found);
}

/** A lookup's answer: absent links, found is taken, unknown indexes the pass. */
function settle(
  c: Node,
  s: Node,
  last: Edge | null,
  next: Edge | null,
  found: Edge | null | undefined,
): void {
  if (found === null) return link(c, s, last, next);

  if (found !== undefined) return take(c, found, s, last, next);
  // Past the budget: index the pass, and the slot decides from here on.
  index(c, next);
  slot(c, s, last, next);
}

/** An indexed pass's lookup: the source's slot holds the pair's edge, or the pair is absent. */
function slot(c: Node, s: Node, last: Edge | null, next: Edge | null): void {
  if (__STATS__) stats.lookups++;

  const cell = s.slot;

  if (cell !== null && cell.to === c) return take(c, cell, s, last, next);
  link(c, s, last, next);
  claim(s, cursor as Edge);
}

/**
 * Whether the source's subscriber list, at most two edges long, holds no edge
 * to `c`: its first and last subscribers are one load apart (the first one's
 * prevSub), so this proves absence before the reader's list is scanned.
 */
function alien(first: Edge, c: Node): boolean {
  const tail = first.prevSub!;

  return (
    first.to !== c &&
    tail.to !== c &&
    (tail === first || first.nextSub === tail)
  );
}

/**
 * The pair's edge among the source's first SCAN subscribers: null if the list
 * ends first (absent), undefined if the budget runs out (unknown).
 */
function pair(first: Edge | null, c: Node): Edge | null | undefined {
  if (__STATS__) stats.lookups++;

  let budget = SCAN;

  for (let e = first; e !== null; e = e.nextSub) {
    if (e.to === c) return e;

    if (--budget === 0) return undefined;
  }
  return null;
}

/**
 * The pass's lookup from here on, decided by the found edge's place: the
 * source's first subscriber marks the unread suffix, from `next` on (a walk
 * over edges, not sources); deeper, index.
 */
function begin(c: Node, e: Edge, first: Edge | null, next: Edge | null): void {
  if (next === null) return;

  if (e !== first) return index(c, next);

  if (__STATS__) stats.sweeps++;

  for (let u: Edge | null = next; u !== null; u = u.nextDep) {
    if (__STATS__) stats.indexed++;

    u.ver = UNREAD;
  }
}

/**
 * A found edge: an unread one is observed and moves to the cursor; a repeated
 * read keeps its place and its first observation's version (P5).
 */
function take(
  c: Node,
  e: Edge,
  s: Node,
  last: Edge | null,
  next: Edge | null,
): void {
  if (e.ver !== UNREAD) {
    if (__STATS__) stats.dups++;

    return;
  }
  if (__STATS__) stats.moves++;

  e.ver = s.ver;
  moveDep(c, e, last, next!);
  cursor = e;
}
