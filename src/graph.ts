import { stats } from "./instrumentation";

// Graph types, constants and intrusive list operations.

// The aliases name different facts but do not brand numbers: counters wrap at
// MASK and edge versions can carry UNREAD.
export type Flags = number;
export type Version = number;
export type Generation = number;

/** A computed's or watcher's body; a signal has none. */
export type NodeFn = (prev: unknown) => unknown;
/** A watcher's cleanup, run untracked. */
export type Cleanup = () => unknown;

export interface Node {
  flags: Flags;
  value: unknown;
  /** Bumps on every Object.is-visible change of value. */
  ver: Version;
  /** null for a signal and for a disposed node. */
  fn: NodeFn | null;
  /** First and last dependency edges, in read order. */
  firstDep: Edge | null;
  lastDep: Edge | null;
  /**
   * First subscriber edge, in birth order. Its prevSub is the LAST subscriber,
   * not null: the list is circular backwards only. Walk it forwards (nextSub
   * ends at null); a backward walk must stop at firstSub, or it loops.
   */
  firstSub: Edge | null;
  /** While a reader indexes: this node's edge into that reader. */
  slot: Edge | null;
  /** Successful runs; edges born since the last one are tentative. */
  gen: Generation;
}

export interface Edge {
  readonly from: Node;
  readonly to: Node;
  /** from.ver when `to` read it; UNREAD in the pass's marked unread suffix. */
  ver: Version | typeof UNREAD | typeof SKIPPED;
  /** to.gen + 1 at birth: tentative while it still equals to.gen + 1. */
  gen: Generation;
  /** Neighbours in the consumer's dependency list. */
  prevDep: Edge | null;
  nextDep: Edge | null;
  /**
   * Neighbours in the source's subscriber list. prevSub is the predecessor,
   * except on the source's firstSub, where it is the last subscriber (the
   * tail: link appends there). Null only on a detached edge.
   */
  prevSub: Edge | null;
  nextSub: Edge | null;
}

/** Shared LIFO of the kernel's walks: resume edges and displaced slot cells. */
export type WorkStack = (Edge | null)[];

// Flag layout and constants used by the kernel and host.
export const enum Flag {
  /** A source below may have changed; a watcher must validate. */
  Stale = 1 << 0,
  /** Must run: first run, failed run, or a direct source changed. */
  Dirty = 1 << 1,
  /** Its run is on the stack. */
  Busy = 1 << 2,
  /** A watcher: handed to the host, never read. */
  Watch = 1 << 4,
  /** Woken by signals only; computed sources need no validation. */
  Woken = 1 << 5,
  /**
   * Development builds only (C1 is a precondition): a computed whose
   * validation is on the stack, no longer STALE and not yet clean. WOKEN's
   * bit, so every mask stays a byte: WOKEN is a watcher's, CHECKING a
   * computed's, and no node is both. A production build never sets it, so
   * a mask that tests it is inert there.
   */
  Checking = 1 << 5,
  /** Host policy: scheduled by the reference host. */
  Auto = 1 << 6,
  /** Host policy: already in its queue. */
  Queued = 1 << 7,
  // Combined masks used when testing or clearing flags; all remain within a byte.
  Pending = Stale | Dirty,
  Active = Busy | Checking,
  Pull = Pending | Active,
  // Checking and Woken share a bit on computed nodes and watchers, respectively.
  PendingMarked = Pending | Checking,
  Wake = Stale | Woken,
  AutoQueued = Auto | Queued,
}

/** Counters wrap inside the SMI range. */
export const enum CounterLimit {
  Mask = 0x3fffffff,
}

/** edge.ver of an edge the marked or indexed run has not read yet. */
export const UNREAD = -1;
/**
 * edge.ver of an unread edge a read has skipped once in this pass (`skip` in
 * the kernel). Like UNREAD it only stands where the old version is never
 * read: a read overwrites it, a successful run cuts what is left unread, and
 * a failed one leaves its node DIRTY.
 */
export const SKIPPED = -2;
/**
 * A committed edge keeps its birth generation, and generations wrap: an edge
 * 2^30 - 1 commits old would read as born in the next run (tentative). So a
 * node restamps its edges with its own generation whenever a commit makes
 * `gen & SETTLE` zero, twice a cycle, and no edge falls that far behind.
 */
export const SETTLE = 0x1fffffff;
/** Scan budget of every bounded search: a constant keeps a run linear. */
export const SCAN = 8;
/**
 * Budget of the scan from the end of a reader's list (LOG 47). Skipped edges
 * go to the end in skip order, so the latest is last: a swap, a reversal and
 * a source moved to the front find theirs there. Each absent source pays the
 * whole budget, so it is small.
 */
export const TAIL = 2;
/**
 * Work-stack (and host-queue) slots kept at rest, and the length past which the outermost
 * walk's end cuts the stack back to them. The gap keeps walks only a little
 * deeper than KEEP from cutting and regrowing on every pass.
 */
export const KEEP = 256;
export const TRIM = 512;

// Intrusive graph operations independent of the execution context.

export function createNode(fn: Node["fn"], value: unknown, flags: Flags): Node {
  return {
    flags,
    value,
    ver: 0,
    fn,
    firstDep: null,
    lastDep: null,
    firstSub: null,
    slot: null,
    gen: 0,
  };
}

/** Move an unread edge (strictly after `next`) up to the cursor. */
export function moveDep(c: Node, e: Edge, last: Edge | null, next: Edge): void {
  const before = e.prevDep!;
  const after = e.nextDep;
  before.nextDep = after;

  if (after !== null) after.prevDep = before;
  else c.lastDep = before;

  e.prevDep = last;
  e.nextDep = next;

  if (last !== null) last.nextDep = e;
  else c.firstDep = e;
  next.prevDep = e;
}

/**
 * A read found `e` past `next`, the edge under the cursor: `next` goes to the
 * end of the list (read later or never, see `miss`), and `e`, unless it was
 * right behind `next`, moves to the cursor, after `last`.
 */
export function skipDep(c: Node, last: Edge | null, next: Edge, e: Edge): void {
  const after = next.nextDep!;
  const tail = c.lastDep!;

  if (last !== null) last.nextDep = after;
  else c.firstDep = after;
  after.prevDep = last;

  next.prevDep = tail;
  next.nextDep = null;
  tail.nextDep = next;
  c.lastDep = next;
  // A failed marked pass can leave a marked suffix behind: stay inside it.
  if (tail.ver === UNREAD) next.ver = UNREAD;

  if (e !== after) moveDep(c, e, last, after);
}

/** Remove every edge of `c` after `last` (all of them when null). */
export function cutDeps(c: Node, last: Edge | null): void {
  let e = last === null ? c.firstDep : last.nextDep;

  if (e === null) return;

  if (last === null) c.firstDep = null;
  else last.nextDep = null;
  c.lastDep = last;
  // The cut head's back pointer would tie this garbage to the live list, and
  // so to garbage cut later: old garbage keeps newer garbage alive.
  e.prevDep = null;

  for (; e !== null; e = e.nextDep) unlinkSub(e);
}

/** Restamp every edge of `c`, all of them committed, with its generation (SETTLE). */
export function settleDeps(c: Node): void {
  const gen = c.gen;

  for (let e = c.firstDep; e !== null; e = e.nextDep) e.gen = gen;
}

/** Take an edge out of its source's subscriber list. */
export function unlinkSub(e: Edge): void {
  if (__STATS__) stats.unlinks++;

  const s = e.from;
  const before = e.prevSub!;
  const after = e.nextSub;

  if (e === s.firstSub) s.firstSub = after;
  else before.nextSub = after;

  if (after !== null) after.prevSub = before;
  else if (s.firstSub !== null) s.firstSub.prevSub = before;
  // Subscribers are in birth order, so an old removed edge would point at a
  // much younger one and keep it (and its watcher) alive across scavenges.
  e.prevSub = null;
  e.nextSub = null;
}
