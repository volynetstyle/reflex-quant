// Reactive kernel: nodes, relations, dependency acquisition, invalidation,
// validation and recomputation. It knows no scheduling, cleanups or public
// API; the host composes those from the operations exported here.
//
// One node shape serves sources and consumers. A relation is one edge object
// threaded through two doubly linked lists: the consumer's `deps` (in the
// order of its last read sequence) and the source's `subs` (birth order).

declare const __QUANT_STATS__: boolean;

/** May be out of date: some transitive source changed. Push sets it. */
export const STALE = 1;
/** Must execute: never succeeded, or the last attempt failed. */
export const DIRTY = 2;
/** A tracking pass of this node is on the stack. */
export const RUNNING = 4;
/** The pass indexed its relations in their sources' `slot` cells. */
const INDEXED = 8;
/** A root: delivered to the host instead of propagating. */
export const WATCH = 16;
// Bits from 32 up belong to the host.

export interface Node {
  flags: number;
  value: unknown;
  /** Advances on every Object.is-visible change of `value`. */
  version: number;
  fn: ((previous: unknown) => unknown) | null;
  deps: Edge | null;
  /** Last relation accepted by the current pass; null: none yet. */
  cursor: Edge | null;
  subs: Edge | null;
  subsTail: Edge | null;
  /** This node's relation into the indexed pass of a reader, or null. */
  slot: Edge | null;
  /** Successful passes so far: relations born after the last one are tentative. */
  gen: number;
}

export interface Edge {
  from: Node;
  to: Node;
  /** `from.version` at the read; UNREAD for not-yet-read relations of an indexed pass. */
  version: number;
  /** `to.gen + 1` at birth: equal to `to.gen + 1` while uncommitted. */
  gen: number;
  prevDep: Edge | null;
  nextDep: Edge | null;
  prevSub: Edge | null;
  nextSub: Edge | null;
}

const UNREAD = -1;
const VERSION_MASK = 0x3fffffff;

export const stats = {
  reads: 0,
  hits: 0,
  repeats: 0,
  lookups: 0,
  duplicates: 0,
  skips: 0,
  moves: 0,
  allocations: 0,
  removals: 0,
  indexings: 0,
  indexed: 0,
  executions: 0,
  invalidations: 0,
  validations: 0,
};

let active: Node | null = null;
/** (source, cell) pairs an indexed pass displaced from an enclosing pass. */
const displaced: (Node | Edge)[] = [];
let deliver: (root: Node) => void = () => {};

export function setDeliver(hook: (root: Node) => void): void {
  deliver = hook;
}

/** No pass on the stack and no displaced cell outstanding (tests). */
export function atRest(): boolean {
  return active === null && displaced.length === 0;
}

export function node(fn: Node["fn"], value: unknown, flags: number): Node {
  return {
    flags,
    value,
    version: 0,
    fn,
    deps: null,
    cursor: null,
    subs: null,
    subsTail: null,
    slot: null,
    gen: 0,
  };
}

const nextGen = (gen: number) => (gen + 1) & VERSION_MASK;

// ------------------------------------------------------------------ write

export function write(source: Node, value: unknown): void {
  if (Object.is(source.value, value)) return;
  source.value = value;
  source.version = (source.version + 1) & VERSION_MASK;
  for (let e = source.subs; e !== null; e = e.nextSub) {
    // A direct subscriber read the old version, so it must execute; one
    // whose pass is running may not have read it yet: versions decide.
    const sub = e.to;
    if ((sub.flags & RUNNING) === 0) sub.flags |= DIRTY;
    mark(sub);
  }
}

function mark(n: Node): void {
  const flags = n.flags;
  if (__QUANT_STATS__) stats.invalidations++;
  if ((flags & WATCH) !== 0) {
    n.flags = flags | STALE;
    deliver(n);
    return;
  }
  if ((flags & STALE) !== 0) return;
  n.flags = flags | STALE;
  for (let e = n.subs; e !== null; e = e.nextSub) mark(e.to);
}

// ------------------------------------------------------------------- read

export function read(n: Node): unknown {
  if ((n.flags & (STALE | DIRTY | RUNNING)) !== 0) refresh(n);
  if (active !== null) track(active, n);
  return n.value;
}

/** Bring a computed up to date: execute if it must, else validate first. */
export function refresh(n: Node): void {
  const flags = n.flags;
  if ((flags & RUNNING) !== 0) throw new Error("Cycle detected");
  if ((flags & DIRTY) === 0) {
    if ((flags & STALE) === 0) return;
    n.flags = flags & ~STALE;
    if (!changed(n)) return;
  }
  execute(n);
}

/** Existential: the first changed source proves execution is needed. */
function changed(n: Node): boolean {
  try {
    for (let e = n.deps; e !== null; e = e.nextDep) {
      const source = e.from;
      if (__QUANT_STATS__) stats.validations++;
      if ((source.flags & (STALE | DIRTY)) !== 0) refresh(source);
      if (source.version !== e.version) return true;
    }
  } catch (error) {
    n.flags |= DIRTY;
    throw error;
  }
  return false;
}

/**
 * Universal: refresh every committed source before deciding, so a throwing
 * source is found before any irreversible step of the caller. Marks DIRTY on
 * change. Tentative relations (reads of a failed attempt) only wake.
 */
export function validateAll(n: Node): void {
  const tentative = nextGen(n.gen);
  for (let e = n.deps; e !== null; e = e.nextDep) {
    if (e.gen === tentative) continue;
    const source = e.from;
    if (__QUANT_STATS__) stats.validations++;
    if ((source.flags & (STALE | DIRTY)) !== 0) refresh(source);
    if (source.version !== e.version) n.flags |= DIRTY;
  }
}

export function untracked<T>(fn: () => T): T {
  const previous = active;
  active = null;
  try {
    return fn();
  } finally {
    active = previous;
  }
}

// -------------------------------------------------------------- execution

/** Run `n.fn` as a tracking pass; commit value and relations on success. */
export function execute(n: Node): void {
  const previous = active;
  const base = displaced.length;
  if (__QUANT_STATS__) stats.executions++;
  // Clear before running: a push during the pass re-marks the node.
  n.flags = (n.flags & ~(STALE | DIRTY)) | RUNNING;
  n.cursor = null;
  active = n;
  let ok = false;
  let value: unknown;
  try {
    value = n.fn!(n.value);
    ok = true;
  } finally {
    active = previous;
    finish(n, ok, base);
  }
  if (!Object.is(value, n.value) && n.fn !== null) {
    n.value = value;
    n.version = (n.version + 1) & VERSION_MASK;
  }
}

function finish(n: Node, ok: boolean, base: number): void {
  if ((n.flags & INDEXED) !== 0) {
    for (let e = n.deps; e !== null; e = e.nextDep) e.from.slot = null;
    for (let i = displaced.length - 2; i >= base; i -= 2)
      (displaced[i] as Node).slot = displaced[i + 1] as Edge;
    displaced.length = base;
  }
  n.flags &= ~(RUNNING | INDEXED);
  if (n.fn === null) {
    // Disposed during its own pass: teardown was deferred to here.
    cut(n, null);
    n.flags &= ~(STALE | DIRTY);
    return;
  }
  if (ok) {
    cut(n, n.cursor);
    n.gen = nextGen(n.gen);
    return;
  }
  // Failed: keep committed ∪ this attempt's reads as the wake set; drop the
  // unread relations earlier failed attempts left behind.
  n.flags |= DIRTY;
  const tentative = nextGen(n.gen);
  const last = n.cursor;
  for (let e = last === null ? n.deps : last.nextDep; e !== null; ) {
    const after = e.nextDep;
    if (e.gen === tentative) {
      const before = e.prevDep;
      if (before !== null) before.nextDep = after;
      else n.deps = after;
      if (after !== null) after.prevDep = before;
      unsubscribe(e);
    }
    e = after;
  }
}

// --------------------------------------------------------------- tracking

function track(c: Node, source: Node): void {
  const cursor = c.cursor;
  const next = cursor === null ? c.deps : cursor.nextDep;
  if (__QUANT_STATS__) stats.reads++;
  if (next !== null && next.from === source) {
    if (__QUANT_STATS__) stats.hits++;
    c.cursor = next;
    next.version = source.version;
    return;
  }
  trackMiss(c, source, cursor, next);
}

function trackMiss(
  c: Node,
  source: Node,
  cursor: Edge | null,
  next: Edge | null,
): void {
  if (cursor !== null && cursor.from === source) {
    if (__QUANT_STATS__) stats.repeats++;
    cursor.version = source.version;
    return;
  }
  if ((c.flags & INDEXED) === 0) {
    // Cheap exact answers before indexing. A relation found in the unread
    // suffix is the pair's unique relation; only absence needs a proof.
    const skipped = next !== null ? next.nextDep : null;
    if (skipped !== null && skipped.from === source) {
      if (__QUANT_STATS__) stats.skips++;
      moveToCursor(c, skipped, cursor, next!);
      skipped.version = source.version;
      return;
    }
    if (unsubscribed(source, c)) {
      link(c, source, cursor, next, false);
      return;
    }
    index(c, next);
  }
  if (__QUANT_STATS__) stats.lookups++;
  const cell = source.slot;
  if (cell !== null && cell.to === c) {
    if (cell.version !== UNREAD) {
      // Already read in this pass.
      if (__QUANT_STATS__) stats.duplicates++;
      cell.version = source.version;
      return;
    }
    if (__QUANT_STATS__) stats.moves++;
    moveToCursor(c, cell, cursor, next!);
    cell.version = source.version;
    return;
  }
  link(c, source, cursor, next, true);
}

/** Absence proof from the source's side, bounded: no relation of `c` among few subscribers. */
function unsubscribed(source: Node, c: Node): boolean {
  let budget = 8;
  for (let e = source.subs; e !== null; e = e.nextSub) {
    if (e.to === c || --budget === 0) return false;
  }
  return true;
}

/** Move an unread relation (strictly after `next`) to the cursor. */
function moveToCursor(c: Node, e: Edge, cursor: Edge | null, next: Edge): void {
  const before = e.prevDep!;
  const after = e.nextDep;
  before.nextDep = after;
  if (after !== null) after.prevDep = before;
  e.prevDep = cursor;
  e.nextDep = next;
  if (cursor !== null) cursor.nextDep = e;
  else c.deps = e;
  next.prevDep = e;
  c.cursor = e;
}

/** A new relation at the cursor, appended to the source's subscribers. */
function link(c: Node, source: Node, cursor: Edge | null, next: Edge | null, indexed: boolean): void {
  if (__QUANT_STATS__) stats.allocations++;
  const tail = source.subsTail;
  const e: Edge = {
    from: source,
    to: c,
    version: source.version,
    gen: nextGen(c.gen),
    prevDep: cursor,
    nextDep: next,
    prevSub: tail,
    nextSub: null,
  };
  if (cursor !== null) cursor.nextDep = e;
  else c.deps = e;
  if (next !== null) next.prevDep = e;
  if (tail !== null) tail.nextSub = e;
  else source.subs = e;
  source.subsTail = e;
  c.cursor = e;
  if (indexed) {
    if (source.slot !== null) displaced.push(source, source.slot);
    source.slot = e;
  }
}

/** Index every relation of `c` in its source's slot; mark the unread ones. */
function index(c: Node, next: Edge | null): void {
  if (__QUANT_STATS__) stats.indexings++;
  c.flags |= INDEXED;
  let unread = false;
  for (let e = c.deps; e !== null; e = e.nextDep) {
    if (__QUANT_STATS__) stats.indexed++;
    if (e === next) unread = true;
    if (unread) e.version = UNREAD;
    const source = e.from;
    if (source.slot !== null) displaced.push(source, source.slot);
    source.slot = e;
  }
}

/** Remove every relation of `c` after `last` (all of them when null). */
function cut(c: Node, last: Edge | null): void {
  let e = last === null ? c.deps : last.nextDep;
  if (e === null) return;
  if (last === null) c.deps = null;
  else last.nextDep = null;
  for (; e !== null; e = e.nextDep) unsubscribe(e);
}

function unsubscribe(e: Edge): void {
  if (__QUANT_STATS__) stats.removals++;
  const source = e.from;
  const before = e.prevSub;
  const after = e.nextSub;
  if (before !== null) before.nextSub = after;
  else source.subs = after;
  if (after !== null) after.prevSub = before;
  else source.subsTail = before;
}

// --------------------------------------------------------------- disposal

/** Detach `n` from its sources for good. Deferred to the end of its own pass. */
export function dispose(n: Node): void {
  if (n.fn === null) return;
  n.fn = null;
  if ((n.flags & RUNNING) !== 0) return;
  cut(n, null);
  n.flags &= ~(STALE | DIRTY);
}
