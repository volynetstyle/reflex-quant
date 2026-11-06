// Reactive kernel: nodes, edges, tracking, push, pull, failure.
//
// A node is a signal (fn === null), a computed, or a watcher (WATCH). An edge
// is one relation in two doubly linked lists: `to.deps` in the order `to`
// last read its sources (prev/next) and `from.subs` in birth order
// (prevSub/nextSub). Change is a version fact: a node bumps `ver` when its
// value changes; an edge keeps the `ver` its reader saw.
//
// Removal invariant: an edge taken out of a list must not keep a pointer into
// either list, because garbage that points at live or younger edges is kept
// alive by the scavenger once it is old (an old dead edge pins newer ones, and
// through `to` their watchers and closures, until a major GC). Removal is
// therefore two steps: unlink the neighbours, then clear the edge's own
// links. `unsub` clears prevSub/nextSub; `cut` clears the head's `prev`, and
// `fail` clears `prev`/`next`. In `cut` the interior of a removed run keeps
// its `next` chain, which only reaches other garbage of the same cut and
// is read by `unsub` while the run is walked. Any new removal path must
// do the same.
//
// Written for V8: one node shape and one edge shape, each built at a single
// site; numeric fields are SMI counters (masked); conditions are explicit
// comparisons, so no ToBoolean runs on mixed values; no recursion, no array
// methods, and no allocation besides nodes and new edges.

import { Flag, MASK, UNREAD } from "./flags";
import type { Edge, Flags, Node, WorkStack } from "./model";
import { miss } from "./tracking";
import { cut, unsub } from "./graph";
import { stats } from "./instrumentation";

export { node } from "./graph";
export { stats } from "./instrumentation";

/** The running consumer, or null outside a tracking pass. */
let active: Node | null = null;
/**
 * One LIFO work stack shared by all walks: sibling edges to resume (mark),
 * edges to climb back through (pull), and (source, cell) pairs an indexed run
 * displaced. Every walk pops back to its own base before returning.
 */
const stack: WorkStack = [];
/** First free index of `stack`. */
let top = 0;
let wake: (w: Node) => void = () => {};

/**
 * The host is told about every watcher a write or mark reaches. It owns the
 * deduplication (a queued watcher is not queued again), so a watcher left
 * STALE by a failed check is delivered again by the next push.
 */
export function onWake(fn: (w: Node) => void): void {
  wake = fn;
}

/** Nothing running, the work stack empty (tests). */
export function idle(): boolean {
  return active === null && top === 0;
}

// ------------------------------------------------------------------- write

export function write(s: Node, value: unknown): void {
  if (Object.is(s.value, value)) return;

  s.value = value;
  s.ver = (s.ver + 1) & MASK;

  for (let e = s.subs; e !== null; e = e.nextSub) {
    const n = e.to;
    const f = n.flags;

    if (__STATS__) stats.marks++;

    if ((f & Flag.Busy) !== 0) {
      // Running: it may not have read s yet, so versions decide.
      if ((f & Flag.Stale) === 0) {
        n.flags = f | Flag.Stale;

        if ((f & Flag.Watch) !== 0) wake(n);
        else if (n.subs !== null) mark(n.subs);
      }
    } else if ((f & Flag.Watch) !== 0) {
      n.flags = f | Flag.Dirty | Flag.Woken;

      wake(n);
    } else if ((f & Flag.Stale) !== 0) {
      n.flags = f | Flag.Dirty;
    } else {
      n.flags = f | Flag.Dirty | Flag.Stale;

      if (n.subs !== null) mark(n.subs);
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

        if (n.subs !== null) {
          if (e.nextSub !== null) stack[top++] = e.nextSub;

          e = n.subs;
          continue;
        }
      }
      e = e.nextSub;
    }

    if (top === base) return;

    e = stack[--top] as Edge;
    stack[top] = null;
  }
}

// -------------------------------------------------------------------- read

/** Bring `n` up to date if it is a stale computed, then track it. */
export function read(n: Node): unknown {
  if ((n.flags & (Flag.Stale | Flag.Dirty | Flag.Busy)) !== 0) pull(n);

  const c = active;

  if (c !== null) {
    if (__STATS__) stats.reads++;

    const last = c.last;
    const next = last === null ? c.deps : last.next;

    if (next !== null && next.from === n) {
      if (__STATS__) stats.hits++;

      c.last = next;
      next.ver = n.ver;
    } else miss(c, n, last, next);
  }
  return n.value;
}

/**
 * Pull a computed up to date. Existential, in read order: sources are
 * checked first to last and the first changed one makes the node run. A
 * STALE source is descended into (the stack keeps the edge to climb back
 * through); a DIRTY one runs. A throw leaves every node still checking DIRTY.
 */
function pull(root: Node): void {
  const f = root.flags;

  if ((f & Flag.Busy) !== 0) throw new Error("Cycle detected");

  if ((f & Flag.Dirty) !== 0) return exec(root);

  verify(root, f);
}

/** The walk of `pull` for a STALE, not DIRTY, not BUSY node; kept apart so `pull` stays small. */
function verify(root: Node, f: Flags): void {
  root.flags = f & ~Flag.Stale;
  const base = top;
  let n = root;
  let e = root.deps;

  try {
    for (;;) {
      while (e !== null) {
        const s: Node = e.from;
        const sf = s.flags;

        if (__STATS__) stats.checks++;

        if ((sf & (Flag.Stale | Flag.Dirty)) !== 0) {
          if ((sf & Flag.Busy) !== 0) throw new Error("Cycle detected");

          if ((sf & Flag.Dirty) === 0) {
            s.flags = sf & ~Flag.Stale;
            stack[top++] = e;
            n = s;
            e = s.deps;
            continue;
          }
          exec(s);
        }

        if (s.ver !== e.ver) {
          exec(n);
          break;
        }
        e = e.next;
      }

      // Climb; a parent whose child changed runs as well.
      for (;;) {
        if (top === base) return;

        const up = stack[--top] as Edge;
        stack[top] = null;
        n = up.to;

        if (up.from.ver === up.ver) {
          e = up.next;
          break;
        }
        exec(n);
      }
    }
  } catch (error) {
    n.flags |= Flag.Dirty;

    while (top > base) {
      (stack[--top] as Edge).to.flags |= Flag.Dirty;
      stack[top] = null;
    }
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
  const tentative = (w.gen + 1) & MASK;
  let e = w.deps;

  // Until a run is owed, versions decide; then only the pulls remain.
  if ((w.flags & Flag.Dirty) === 0) {
    for (; e !== null; e = e.next) {
      const s = e.from;

      if (__STATS__) stats.checks++;

      if ((s.flags & (Flag.Stale | Flag.Dirty)) !== 0 && e.gen !== tentative)
        pull(s);

      if (s.ver !== e.ver) {
        w.flags |= Flag.Dirty;
        e = e.next;
        break;
      }
    }
  }

  for (; e !== null; e = e.next) {
    if (__STATS__) stats.checks++;

    const s = e.from;

    if ((s.flags & (Flag.Stale | Flag.Dirty)) !== 0 && e.gen !== tentative)
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
  const base = top;

  if (__STATS__) stats.runs++;
  // Cleared before the run: a push during it marks the node again.
  n.flags = (n.flags & ~(Flag.Stale | Flag.Dirty)) | Flag.Busy;
  n.last = null;
  active = n;
  let value: unknown;

  try {
    value = n.fn!(n.value);
  } catch (error) {
    active = prev;
    fail(n, base);
    throw error;
  }
  active = prev;
  const f = n.flags;

  if ((f & Flag.Indexed) !== 0) unindex(n, base);

  n.flags = f & ~(Flag.Busy | Flag.Indexed);

  if (n.fn === null) return detach(n);
  // Commit only after a successful run. Dropping the unread suffix removes
  // sources that this pass no longer depends on.
  const last = n.last as Edge | null;

  if ((last === null ? n.deps : last.next) !== null) cut(n, last);

  n.gen = (n.gen + 1) & MASK;

  if (Object.is(value, n.value) === false) {
    n.value = value;
    n.ver = (n.ver + 1) & MASK;
  }
}

/**
 * A failed run: keep committed edges and this run's reads as the wake set,
 * drop unread edges earlier failed runs left behind, owe a run.
 */
function fail(n: Node, base: number): void {
  if ((n.flags & Flag.Indexed) !== 0) unindex(n, base);

  n.flags &= ~(Flag.Busy | Flag.Indexed);

  if (n.fn === null) return detach(n);

  n.flags |= Flag.Dirty;
  const tentative = (n.gen + 1) & MASK;
  const last = n.last;

  for (let e = last === null ? n.deps : last.next; e !== null;) {
    const after: Edge | null = e.next;

    if (e.gen === tentative) {
      const before = e.prev;

      if (before !== null) before.next = after;
      else n.deps = after;

      if (after !== null) after.prev = before;

      unsub(e);
      e.prev = null;
      e.next = null;
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
  cut(n, null);
  n.flags &= ~(Flag.Stale | Flag.Dirty | Flag.Woken);
}

// ---------------------------------------------------------------- tracking

/** Put every edge of `c` into its source's slot; mark the unread ones. */
export function index(c: Node, next: Edge | null): void {
  if (__STATS__) stats.indexes++;

  c.flags |= Flag.Indexed;
  let unread = false;

  for (let e = c.deps; e !== null; e = e.next) {
    if (__STATS__) stats.indexed++;

    if (e === next) unread = true;

    if (unread) e.ver = UNREAD;

    const s = e.from;

    if (s.slot !== null) {
      stack[top++] = s;
      stack[top++] = s.slot;
    }
    s.slot = e;
  }
}

/** Clear the run's slots, give back the cells it displaced. */
function unindex(n: Node, base: number): void {
  for (let e = n.deps; e !== null; e = e.next) e.from.slot = null;

  while (top > base) {
    const cell = stack[--top] as Edge;
    stack[top] = null;
    const s = stack[--top] as Node;
    stack[top] = null;
    s.slot = cell;
  }
}

/** A new edge at the cursor, appended to the source's subscribers. */
export function link(
  c: Node,
  s: Node,
  last: Edge | null,
  next: Edge | null,
  indexed: boolean,
): void {
  if (__STATS__) stats.links++;

  const tail = s.lastSub;
  const e: Edge = {
    from: s,
    to: c,
    ver: s.ver,
    gen: (c.gen + 1) & MASK,
    prev: last,
    next,
    prevSub: tail,
    nextSub: null,
  };

  if (last !== null) last.next = e;
  else c.deps = e;

  if (next !== null) next.prev = e;

  if (tail !== null) tail.nextSub = e;
  else s.subs = e;
  s.lastSub = e;
  c.last = e;

  if (indexed) {
    if (s.slot !== null) {
      stack[top++] = s;
      stack[top++] = s.slot;
    }
    s.slot = e;
  }
}
