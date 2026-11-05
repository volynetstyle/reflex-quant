// Reactive kernel: nodes, edges, tracking, push, pull, failure.
//
// A node is a signal (fn === null), a computed, or a watcher (WATCH). An edge
// is one relation in two doubly linked lists: `to.deps` in the order `to`
// last read its sources (prev/next) and `from.subs` in birth order
// (prevSub/nextSub). Change is a version fact: a node bumps `ver` when its
// value changes; an edge keeps the `ver` its reader saw.
//
// Written for V8: one node shape and one edge shape, each built at a single
// site; numeric fields are SMI counters (masked); conditions are explicit
// comparisons, so no ToBoolean runs on mixed values; no recursion, no array
// methods, and no allocation besides nodes and new edges.

declare const __STATS__: boolean;

/** A source below may have changed. For a watcher: validate before running. */
export const STALE = 1;
/** Must run: first run, failed run, or a direct source changed. */
export const DIRTY = 2;
/** Its run is on the stack. */
export const BUSY = 4;
/** Its run put its edges into the sources' slots. */
const INDEX = 8;
/** A watcher: handed to the host, never read. */
export const WATCH = 16;
/** A watcher woken by signals only: its computed sources are clean, so no validation. */
export const WOKEN = 32;
// Bits from 64 up belong to the host.

/** edge.ver of an edge the indexed run has not read yet. */
const UNREAD = -1;
/** Counters wrap inside the SMI range. */
const MASK = 0x3fffffff;
/** Scan budget before indexing: a constant keeps a run linear. */
const SCAN = 8;

export interface Node {
  flags: number;
  value: unknown;
  /** Bumps on every Object.is-visible change of value. */
  ver: number;
  fn: ((prev: unknown) => unknown) | null;
  /** Sources, in read order. */
  deps: Edge | null;
  /** The running pass's last accepted source edge. */
  last: Edge | null;
  subs: Edge | null;
  lastSub: Edge | null;
  /** While a reader indexes: this node's edge into that reader. */
  slot: Edge | null;
  /** Successful runs; edges born since the last one are tentative. */
  gen: number;
}

export interface Edge {
  from: Node;
  to: Node;
  /** from.ver when `to` read it; UNREAD while indexed and not yet read. */
  ver: number;
  /** to.gen + 1 at birth: tentative while it still equals to.gen + 1. */
  gen: number;
  prev: Edge | null;
  next: Edge | null;
  prevSub: Edge | null;
  nextSub: Edge | null;
}

export const stats = {
  reads: 0,
  hits: 0,
  repeats: 0,
  scans: 0,
  lookups: 0,
  dups: 0,
  moves: 0,
  links: 0,
  unlinks: 0,
  indexes: 0,
  indexed: 0,
  runs: 0,
  marks: 0,
  checks: 0,
};

let active: Node | null = null;
/**
 * One LIFO work stack shared by all walks: sibling edges to resume (mark),
 * edges to climb back through (pull), and (source, cell) pairs an indexed run
 * displaced. Every walk pops back to its own base before returning.
 */
const stack: (Node | Edge | null)[] = [];
let top = 0;
let wake: (w: Node) => void = () => {};

/** The host is told about every watcher that becomes STALE or WOKEN. */
export function onWake(fn: (w: Node) => void): void {
  wake = fn;
}

/** Nothing running, the work stack empty (tests). */
export function idle(): boolean {
  return active === null && top === 0;
}

export function node(fn: Node["fn"], value: unknown, flags: number): Node {
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

// ------------------------------------------------------------------- write

export function write(s: Node, value: unknown): void {
  if (Object.is(s.value, value)) return;

  s.value = value;
  s.ver = (s.ver + 1) & MASK;

  for (let e = s.subs; e !== null; e = e.nextSub) {
    const n = e.to;
    const f = n.flags;

    if (__STATS__) stats.marks++;

    if ((f & BUSY) !== 0) {
      // Running: it may not have read s yet, so versions decide.
      if ((f & STALE) === 0) {
        n.flags = f | STALE;

        if ((f & WATCH) !== 0) wake(n);
        else if (n.subs !== null) mark(n.subs);
      }
    } else if ((f & WATCH) !== 0) {
      n.flags = f | DIRTY | WOKEN;

      if ((f & (STALE | WOKEN)) === 0) wake(n);
    } else if ((f & STALE) !== 0) {
      n.flags = f | DIRTY;
    } else {
      n.flags = f | DIRTY | STALE;

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
      // A STALE node has STALE subscribers, or is a watcher the host has.
      if ((f & STALE) === 0) {
        n.flags = f | STALE;

        if ((f & WATCH) !== 0) {
          if ((f & WOKEN) === 0) wake(n);
        } else if (n.subs !== null) {
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
  if ((n.flags & (STALE | DIRTY | BUSY)) !== 0) pull(n);

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

  if ((f & BUSY) !== 0) throw new Error("Cycle detected");

  if ((f & DIRTY) !== 0) return exec(root);

  verify(root, f);
}

/** The walk of `pull` for a STALE, not DIRTY, not BUSY node; kept apart so `pull` stays small. */
function verify(root: Node, f: number): void {
  root.flags = f & ~STALE;
  const base = top;
  let n = root;
  let e = root.deps;

  try {
    for (;;) {
      while (e !== null) {
        const s: Node = e.from;
        const sf = s.flags;

        if (__STATS__) stats.checks++;

        if ((sf & (STALE | DIRTY)) !== 0) {
          if ((sf & BUSY) !== 0) throw new Error("Cycle detected");

          if ((sf & DIRTY) === 0) {
            s.flags = sf & ~STALE;
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
    n.flags |= DIRTY;

    while (top > base) {
      (stack[--top] as Edge).to.flags |= DIRTY;
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
  if ((w.flags & DIRTY) === 0) {
    for (; e !== null; e = e.next) {
      const s = e.from;

      if (__STATS__) stats.checks++;

      if ((s.flags & (STALE | DIRTY)) !== 0 && e.gen !== tentative) pull(s);

      if (s.ver !== e.ver) {
        w.flags |= DIRTY;
        e = e.next;
        break;
      }
    }
  }

  for (; e !== null; e = e.next) {
    if (__STATS__) stats.checks++;

    const s = e.from;

    if ((s.flags & (STALE | DIRTY)) !== 0 && e.gen !== tentative) pull(s);
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
  n.flags = (n.flags & ~(STALE | DIRTY)) | BUSY;
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

  if ((f & INDEX) !== 0) unindex(n, base);

  n.flags = f & ~(BUSY | INDEX);

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
  if ((n.flags & INDEX) !== 0) unindex(n, base);

  n.flags &= ~(BUSY | INDEX);

  if (n.fn === null) return detach(n);

  n.flags |= DIRTY;
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

  if ((n.flags & BUSY) === 0) detach(n);
}

function detach(n: Node): void {
  cut(n, null);
  n.flags &= ~(STALE | DIRTY | WOKEN);
}

// ---------------------------------------------------------------- tracking

/** A read that is not the next edge in read order. Every answer is exact. */
function miss(c: Node, s: Node, last: Edge | null, next: Edge | null): void {
  if (last !== null && last.from === s) {
    if (__STATS__) stats.repeats++;

    last.ver = s.ver;
    return;
  }

  if ((c.flags & INDEX) === 0) {
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

/** Put every edge of `c` into its source's slot; mark the unread ones. */
function index(c: Node, next: Edge | null): void {
  if (__STATS__) stats.indexes++;

  c.flags |= INDEX;
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

/** Move an unread edge (strictly after `next`) up to the cursor. */
function move(c: Node, e: Edge, last: Edge | null, next: Edge): void {
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

/** A new edge at the cursor, appended to the source's subscribers. */
function link(
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

/** Remove every edge of `c` after `last` (all of them when null). */
function cut(c: Node, last: Edge | null): void {
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
function unsub(e: Edge): void {
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
