// =============================================================================
// Reactive kernel: a guided tour
// =============================================================================
//
// This file is meant to be read top to bottom. It keeps every observable
// behaviour of the production kernel (the differential corpus checks that)
// but none of its performance engineering: recursion instead of explicit
// stacks, one exact index instead of bounded scans, no counters. Where the
// production code would be faster, a note says so; nothing here depends on
// it.
//
// -----------------------------------------------------------------------------
// 1. The model
// -----------------------------------------------------------------------------
//
// There are three kinds of node:
//
//   signal    holds a value that the outside world writes   (fn === null)
//   computed  derives a value from what it reads           (fn !== null)
//   watcher   runs a side effect from what it reads         (WATCH flag)
//
// A node that reads another is its *consumer*; the node read is its
// *source*. Each (source, consumer) pair that currently matters is one
// *edge*. An edge sits in two lists at once:
//
//   consumer.deps   its sources, in the order the last run read them
//   source.subs     its consumers, in the order they first subscribed
//
//        signal A ──edge──▶ computed B ──edge──▶ watcher C
//                    │                     │
//          A.subs ───┘           B.deps ───┘  (and B.subs, C.deps)
//
// -----------------------------------------------------------------------------
// 2. The whole idea, in four sentences
// -----------------------------------------------------------------------------
//
//   Push says "maybe".
//     A write marks everything downstream STALE. Nothing is recomputed yet;
//     the mark only means "a source below may have changed".
//
//   Versions say "actually".
//     Every node has a version `ver`, bumped when its value really changes.
//     Every edge remembers the source version its consumer last saw. A STALE
//     node compares the two, source by source, and runs only if one differs.
//     Equal values stop propagation here (cutoff), and glitches cannot
//     happen: a node is brought up to date only after its sources are.
//
//   An execution makes a new observation.
//     Running a node re-reads its sources. The reads are matched in order
//     against the previous run's edges, under a cursor: same order means no
//     work, a new source means a new edge, a source not read again is cut.
//
//   A generation commits dependency history.
//     Every node counts its successful runs in `gen`. An edge born during a
//     run is *tentative* until that run succeeds. If the run throws, the
//     tentative edges it read stay (they are what the failure depended on),
//     but no version comparison trusts them: the node simply owes a run.
//
// -----------------------------------------------------------------------------
// 3. The invariants the rest of the file relies on
// -----------------------------------------------------------------------------
//
//   I1  One edge per (source, consumer) pair, in both lists.
//   I2  A STALE node has STALE consumers (or is a watcher the host knows
//       about). So marking can stop at the first node already STALE.
//   I3  A node that is not STALE, DIRTY or BUSY is up to date: its value is
//       what its function would return now.
//   I4  At rest, no node is BUSY and no source holds a slot (section 7).
//
// =============================================================================

// -----------------------------------------------------------------------------
// 4. State
// -----------------------------------------------------------------------------
//
// Four causal states plus one kind. Each is a bit in `flags`.

/** "A source below may have changed." Set by push; resolved by pull. */
export const STALE = 1;
/** "Must run, no questions": first run, a failed run, or a change proved. */
export const DIRTY = 2;
/** "Its run is on the call stack." Reading a BUSY node is a cycle. */
export const BUSY = 4;
/** "Its run has put its edges into the sources' slots" (section 7). */
const INDEX = 8;
/** Not a state but a kind: a watcher is handed to the host, never read. */
export const WATCH = 16;
// Bits from 32 up belong to the host (host.ts).

/** An edge's `ver` while its consumer is indexed and has not re-read it yet. */
const UNREAD = -1;

export interface Node {
  flags: number;
  /** For a watcher: the cleanup its last run returned. */
  value: unknown;
  /** Bumps on every change of `value` that Object.is can see. */
  ver: number;
  /** The function a computed or watcher runs; null for a signal or once disposed. */
  fn: ((prev: unknown) => unknown) | null;
  /** First edge to a source, in read order. */
  deps: Edge | null;
  /** During a run: the cursor, the last source edge this run has accepted. */
  last: Edge | null;
  /** First edge to a consumer, in birth order. */
  subs: Edge | null;
  lastSub: Edge | null;
  /** While some consumer is indexed: that consumer's edge from this node. */
  slot: Edge | null;
  /** Number of successful runs. */
  gen: number;
}

export interface Edge {
  from: Node;
  to: Node;
  /** The `from.ver` that `to` saw when it last read `from`. */
  ver: number;
  /** `to.gen + 1` at birth: tentative while that run has not succeeded. */
  gen: number;
  /** Neighbours in `to.deps`. */
  prev: Edge | null;
  next: Edge | null;
  /** Neighbours in `from.subs`. */
  prevSub: Edge | null;
  nextSub: Edge | null;
  /** The slot this edge covered when it was put into `from.slot`. */
  slotPrev: Edge | null;
}

/** The node whose run is executing now: reads are recorded on it. */
let active: Node | null = null;

/** How the kernel tells the host "this watcher may need to run". */
let wake: (w: Node) => void = () => {};

export function onWake(fn: (w: Node) => void): void {
  wake = fn;
}

/** Nothing is running (used by tests). */
export function idle(): boolean {
  return active === null;
}

/**
 * A signal starts clean (flags 0); a computed starts DIRTY (it has never
 * run); a watcher starts STALE | DIRTY (host.ts).
 */
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

// -----------------------------------------------------------------------------
// 5. Push: a write says "maybe"
// -----------------------------------------------------------------------------
//
// A write changes the value and the version, then marks the consumers below
// STALE. It does not compute anything: the graph may never be read again,
// and a consumer may turn out not to care (cutoff, section 6).

export function write(s: Node, value: unknown): void {
  // Writing the same value is not a change: versions stay, nobody is marked.
  if (Object.is(s.value, value)) return;
  s.value = value;
  s.ver++;
  mark(s.subs);
}

/**
 * Mark every consumer reachable from this subscriber list STALE.
 *
 * Stops at a node already STALE (I2: everything below it is already
 * marked), so each node is visited once per wave. A watcher is not
 * descended into; it is handed to the host, which will validate and maybe
 * run it.
 *
 * A BUSY node is marked like any other. Its run may already have read the
 * changed source, or not; it cannot know which. After the run, the STALE
 * mark makes the next read compare versions, and the versions decide.
 *
 * (Production: the same walk as a loop over an explicit stack, so depth is
 * not limited by the JS call stack.)
 */
function mark(e: Edge | null): void {
  for (; e !== null; e = e.nextSub) {
    const n = e.to;
    if ((n.flags & STALE) !== 0) continue;
    n.flags |= STALE;
    if ((n.flags & WATCH) !== 0) wake(n);
    else mark(n.subs);
  }
}

// -----------------------------------------------------------------------------
// 6. Pull: versions say "actually"
// -----------------------------------------------------------------------------
//
// Reading a computed first makes it up to date (I3), and only then returns
// its value. Three cases:
//
//   DIRTY   it must run: run it.
//   STALE   it may have to: check its sources in read order; the first one
//           whose version differs from the edge's makes it run. If none
//           differs, the STALE mark was a false alarm: nothing runs.
//   neither it is up to date.
//
// Checking a source may first require bringing that source up to date: the
// same procedure, one level down. That recursion is what orders updates
// from the top of the graph to the bottom and makes them glitch-free.

/** Bring `n` up to date: run it if it must, or if a source actually changed. */
function refresh(n: Node): void {
  const f = n.flags;
  // We are inside n's own run and asked for n again: a cycle.
  if ((f & BUSY) !== 0) throw new Error("Cycle detected");
  if ((f & DIRTY) === 0) {
    if ((f & STALE) === 0) return;
    // Clear STALE before checking, not after: a write that happens during
    // the check marks n again and is not lost.
    n.flags = f & ~STALE;
    let any: boolean;
    try {
      any = changed(n);
    } catch (error) {
      // A source failed while we were checking. We learned nothing about n,
      // so n must run next time: DIRTY. Every node on the way up does the
      // same as the error passes through it.
      n.flags |= DIRTY;
      throw error;
    }
    if (!any) return;
  }
  exec(n);
}

/**
 * Did any source of `n` change since `n` last read it? In read order, and
 * the first change decides: the sources after it are not refreshed, because
 * the run that follows may not read them at all (it is the run, not this
 * check, that decides what `n` depends on now).
 */
function changed(n: Node): boolean {
  for (let e = n.deps; e !== null; e = e.next) {
    const s = e.from;
    if ((s.flags & (STALE | DIRTY)) !== 0) refresh(s);
    if (s.ver !== e.ver) return true;
  }
  return false;
}

/**
 * A watcher's check differs from a computed's in one way: it refreshes
 * *every* committed source, not only up to the first change. A watcher's
 * run is a side effect that cannot be undone, so every source that is going
 * to throw must throw before it, not after.
 *
 * Tentative edges (read by a failed run) are not refreshed: while they
 * exist the watcher already owes a run (DIRTY), so they have nothing to
 * decide; they are only there so that a change to them wakes it.
 *
 * (Production adds a shortcut for a watcher woken by signals alone.)
 */
export function check(w: Node): void {
  const tentative = w.gen + 1;
  let owed = (w.flags & DIRTY) !== 0;
  for (let e = w.deps; e !== null; e = e.next) {
    const s = e.from;
    if ((s.flags & (STALE | DIRTY)) !== 0 && e.gen !== tentative) refresh(s);
    if (!owed && s.ver !== e.ver) {
      owed = true;
      w.flags |= DIRTY;
    }
  }
}

/**
 * The one read path, for signals and computeds alike (a signal's flags are
 * 0, so it is never refreshed): bring the node up to date, record the read
 * on the running consumer, return the value.
 */
export function read(n: Node): unknown {
  if ((n.flags & (STALE | DIRTY | BUSY)) !== 0) refresh(n);
  if (active !== null) track(active, n);
  return n.value;
}

/** Run `fn` without recording its reads on the current consumer. */
export function untracked<T>(fn: () => T): T {
  const prev = active;
  active = null;
  try {
    return fn();
  } finally {
    active = prev;
  }
}

// -----------------------------------------------------------------------------
// 7. Run: an execution makes a new observation
// -----------------------------------------------------------------------------
//
// A run calls the node's function with `active` set to the node, so every
// read inside lands in `track` (section 8). The run either succeeds or
// throws, and the two endings are deliberately asymmetric:
//
//   success  commit: edges not read this time are cut, the generation
//            closes (all edges become committed), and the version bumps if
//            the value changed.
//   failure  nothing is committed. The node keeps its old value and owes a
//            run (DIRTY). Its edges are the *wake set*: committed edges and
//            everything this run read, so that any of them changing can
//            retry it.

/** Run `n.fn` as a tracking pass; commit value and edges on success. */
export function exec(n: Node): void {
  const prev = active;
  // Cleared before the run, for the same reason as in refresh: a write
  // during the run marks the node again, and that mark must survive.
  n.flags = (n.flags & ~(STALE | DIRTY)) | BUSY;
  n.last = null; // the cursor starts before the first edge
  active = n;
  let value: unknown;
  try {
    value = n.fn!(n.value);
  } catch (error) {
    active = prev;
    fail(n);
    throw error;
  }
  active = prev;
  settle(n);
  // Disposed during its own run (section 9): it ends now, nothing commits.
  if (n.fn === null) return detach(n);
  // Commit. Everything after the cursor was not read by this run: cut it.
  cut(n, n.last);
  n.gen++;
  if (!Object.is(value, n.value)) {
    n.value = value;
    n.ver++;
  }
}

/** The run is over, either way: give the slots back, leave BUSY. */
function settle(n: Node): void {
  if ((n.flags & INDEX) !== 0) unindex(n);
  n.flags &= ~(BUSY | INDEX);
}

/**
 * A failed run. Keep: committed edges, and every edge this run read (they
 * are before the cursor). Drop: unread edges that are still tentative, i.e.
 * left behind by an *earlier* failed run. Without that, repeated failures
 * reading different sources would grow the wake set forever.
 */
function fail(n: Node): void {
  settle(n);
  if (n.fn === null) return detach(n);
  n.flags |= DIRTY;
  const tentative = n.gen + 1;
  const last = n.last;
  for (let e = last === null ? n.deps : last.next; e !== null; ) {
    const after: Edge | null = e.next;
    if (e.gen === tentative) {
      const before = e.prev;
      if (before !== null) before.next = after;
      else n.deps = after;
      if (after !== null) after.prev = before;
      unsub(e);
    }
    e = after;
  }
}

// -----------------------------------------------------------------------------
// 8. Tracking: matching this run's reads against the last run's edges
// -----------------------------------------------------------------------------
//
// The cursor `c.last` walks `c.deps` as the run reads. Before it: edges this
// run has read. After it: edges it has not read (yet). For every read of a
// source `s` there are three possible truths:
//
//   (a) s is the next edge after the cursor     -> accept it, advance
//   (b) s has an edge, but somewhere else       -> already read: a duplicate
//                                                  not read yet: move it up
//   (c) s has no edge                           -> link a new one at the cursor
//
// (a) is the common case: a run that reads the same sources in the same
// order as last time does no list work at all.
//
// Telling (b) from (c) exactly is the hard part (I1 forbids guessing). The
// answer here: on the first read that is not (a), *index* the consumer. Put
// each of its edges into its source's `slot` and mark the unread ones
// UNREAD. From then on, `s.slot` answers every read of the run in one step:
//
//   s.slot is c's edge, ver === UNREAD   -> (b), not read yet: move it
//   s.slot is c's edge, ver !== UNREAD   -> (b), a duplicate read
//   anything else                        -> (c), no edge: link one
//
// Runs nest (a computed read during a run runs inside it), and an inner run
// may index the same sources. So a slot is a small stack: an edge put into
// `s.slot` remembers the edge it covered in `slotPrev`, and gives it back
// when its run ends. Inner runs end first, so the stack unwinds in order.
// The graph itself holds the stack; nothing else is allocated.
//
// (Production first tries a few cheap exact answers before indexing:
// an immediate repeat, short scans of the list, a source with few
// consumers. Same answers, less work on large reorders.)

/** Record that the running consumer `c` read the source `s`. */
function track(c: Node, s: Node): void {
  const last = c.last;
  const next = last === null ? c.deps : last.next;
  // (a) The same source as last time, at the same place.
  if (next !== null && next.from === s) {
    next.ver = s.ver;
    c.last = next;
    return;
  }
  // (b) or (c): ask the slots.
  if ((c.flags & INDEX) === 0) index(c, next);
  const e = s.slot;
  if (e !== null && e.to === c) {
    const unread = e.ver === UNREAD;
    e.ver = s.ver;
    if (unread) move(c, e, last, next!);
    return;
  }
  link(c, s, last, next);
}

/** Put every edge of `c` into its source's slot; edges after the cursor are UNREAD. */
function index(c: Node, next: Edge | null): void {
  c.flags |= INDEX;
  let unread = false;
  for (let e = c.deps; e !== null; e = e.next) {
    if (e === next) unread = true;
    if (unread) e.ver = UNREAD;
    const s = e.from;
    e.slotPrev = s.slot;
    s.slot = e;
  }
}

/** Give every slot back to whatever this run's edge covered (I4 at rest). */
function unindex(c: Node): void {
  for (let e = c.deps; e !== null; e = e.next) {
    e.from.slot = e.slotPrev;
    e.slotPrev = null;
  }
}

/** Move an unread edge (somewhere after `next`) up to the cursor. */
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

/**
 * A new edge: at the cursor in `c.deps`, at the end of `s.subs` (birth
 * order), and in `s.slot` (the consumer is indexed whenever we get here).
 * Its generation is the one the current run will commit: tentative until
 * then.
 */
function link(c: Node, s: Node, last: Edge | null, next: Edge | null): void {
  const tail = s.lastSub;
  const e: Edge = {
    from: s,
    to: c,
    ver: s.ver,
    gen: c.gen + 1,
    prev: last,
    next,
    prevSub: tail,
    nextSub: null,
    slotPrev: s.slot,
  };
  if (last !== null) last.next = e;
  else c.deps = e;
  if (next !== null) next.prev = e;
  if (tail !== null) tail.nextSub = e;
  else s.subs = e;
  s.lastSub = e;
  s.slot = e;
  c.last = e;
}

/** Remove every edge of `c` after `last` (all of them when null). */
function cut(c: Node, last: Edge | null): void {
  let e = last === null ? c.deps : last.next;
  if (last === null) c.deps = null;
  else last.next = null;
  for (; e !== null; e = e.next) unsub(e);
}

/** Take an edge out of its source's subscriber list. */
function unsub(e: Edge): void {
  const s = e.from;
  const before = e.prevSub;
  const after = e.nextSub;
  if (before !== null) before.nextSub = after;
  else s.subs = after;
  if (after !== null) after.prevSub = before;
  else s.lastSub = before;
}

// -----------------------------------------------------------------------------
// 9. Disposal
// -----------------------------------------------------------------------------
//
// Disposing a node clears its function and removes all its source edges.
// If the node is running, it cannot lose its edges in the middle of its own
// run (the cursor points into them), so disposal only clears `fn` and the
// run detaches at its end (exec and fail check `fn === null`).

export function dispose(n: Node): void {
  if (n.fn === null) return;
  n.fn = null;
  if ((n.flags & BUSY) === 0) detach(n);
}

function detach(n: Node): void {
  cut(n, null);
  n.flags &= ~(STALE | DIRTY);
}
