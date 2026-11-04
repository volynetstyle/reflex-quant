// Reactive kernel: nodes, relations, dependency acquisition, invalidation,
// validation and recomputation. It knows no scheduling, cleanups or public
// API; the host composes those from the operations exported here.
//
// One node shape serves sources and consumers. A relation is one edge object
// threaded through two doubly linked lists: the consumer's `deps` (in the
// order of its last read sequence) and the source's `subs` (birth order).
// Push and pull are loops over explicit stacks; the only recursion left is
// the user's: a computation that reads a computed runs it inside its pass.

declare const __QUANT_STATS__: boolean;

/** May be out of date: some transitive source changed. Push sets it. */
export const STALE = 1;
/** Must execute: never succeeded, the last attempt failed, or a direct source changed. */
export const DIRTY = 2;
/** A tracking pass of this node is on the stack. */
export const RUNNING = 4;
/** The pass indexed its relations in their sources' `slot` cells. */
const INDEXED = 8;
/** A root: delivered to the host instead of propagating. */
export const WATCH = 16;
/**
 * A watcher woken by a direct signal write only. Its committed computed
 * sources are then clean (any push through one would have set STALE), so
 * its validation would be vacuous: STALE means "validate", WOKEN does not.
 */
export const WOKEN = 32;
// Bits from 64 up belong to the host.

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
/** Scan budget before indexing: any constant keeps a pass linear. */
const SCAN = 8;

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
/** Push: subscriber lists to resume after a descent. */
const siblings: Edge[] = [];
/** Pull: the relation each validating node was descended through. */
const descent: Edge[] = [];
let deliver: (root: Node) => void = () => {};

export function setDeliver(hook: (root: Node) => void): void {
  deliver = hook;
}

/** No pass on the stack and nothing left on a work stack (tests). */
export function atRest(): boolean {
  return active === null && displaced.length === 0 && siblings.length === 0 && descent.length === 0;
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

// ------------------------------------------------------------------ write

export function write(source: Node, value: unknown): void {
  if (Object.is(source.value, value)) return;
  source.value = value;
  source.version = (source.version + 1) & VERSION_MASK;
  for (let e = source.subs; e !== null; e = e.nextSub) {
    // A direct subscriber read the old version, so it must execute; one
    // whose pass is running may not have read it yet: versions decide.
    const sub = e.to;
    const flags = sub.flags;
    if (__QUANT_STATS__) stats.invalidations++;
    if ((flags & RUNNING) !== 0) {
      if ((flags & STALE) === 0) {
        sub.flags = flags | STALE;
        if ((flags & WATCH) !== 0) deliver(sub);
        else if (sub.subs !== null) propagate(sub.subs);
      }
    } else if ((flags & WATCH) !== 0) {
      // Woken by a signal only: nothing below it can be stale, so it owes an
      // execution but no validation.
      sub.flags = flags | DIRTY | WOKEN;
      if ((flags & (STALE | WOKEN)) === 0) deliver(sub);
    } else if ((flags & STALE) !== 0) {
      sub.flags = flags | DIRTY;
    } else {
      sub.flags = flags | DIRTY | STALE;
      if (sub.subs !== null) propagate(sub.subs);
    }
  }
}

/**
 * Mark everything below the subscriber list `first` STALE: depth first, no
 * recursion; `siblings` holds where to resume after a descent. A node that
 * is already STALE has STALE subscribers, or is a watcher already handed to
 * the host: skip it. A watcher becoming STALE is handed to the host.
 */
function propagate(first: Edge): void {
  const base = siblings.length;
  let e: Edge | null = first;
  for (;;) {
    while (e !== null) {
      const n: Node = e.to;
      const flags = n.flags;
      if (__QUANT_STATS__) stats.invalidations++;
      if ((flags & STALE) !== 0) {
        // already marked
      } else if ((flags & WATCH) !== 0) {
        n.flags = flags | STALE;
        if ((flags & WOKEN) === 0) deliver(n);
      } else {
        n.flags = flags | STALE;
        const subs = n.subs;
        if (subs !== null) {
          if (e.nextSub !== null) siblings.push(e.nextSub);
          e = subs;
          continue;
        }
      }
      e = e.nextSub;
    }
    if (siblings.length === base) return;
    e = siblings.pop()!;
  }
}

// ------------------------------------------------------------------- read

/** Read a computed: bring it up to date, then track it. */
export function read(n: Node): unknown {
  if ((n.flags & (STALE | DIRTY | RUNNING)) !== 0) refresh(n);
  const c = active;
  if (c !== null) {
    // Hot path: the next relation in read order is this source's.
    const cursor = c.cursor;
    const next = cursor === null ? c.deps : cursor.nextDep;
    if (__QUANT_STATS__) stats.reads++;
    if (next !== null && next.from === n) {
      if (__QUANT_STATS__) stats.hits++;
      c.cursor = next;
      next.version = n.version;
    } else trackMiss(c, n, cursor, next);
  }
  return n.value;
}

/** Read a signal: never out of date, so only the tracking half of `read`. */
export function readSignal(n: Node): unknown {
  const c = active;
  if (c !== null) {
    const cursor = c.cursor;
    const next = cursor === null ? c.deps : cursor.nextDep;
    if (__QUANT_STATS__) stats.reads++;
    if (next !== null && next.from === n) {
      if (__QUANT_STATS__) stats.hits++;
      c.cursor = next;
      next.version = n.version;
    } else trackMiss(c, n, cursor, next);
  }
  return n.value;
}

/**
 * Bring a computed up to date, without recursion. Existential, in read
 * order: a node's sources are checked first to last and the first changed
 * one makes it execute. A STALE source is descended into (`descent` holds
 * the relation to come back through), a DIRTY one executes. Execution runs
 * user code, which may refresh other nodes on the same stack above `base`.
 * A throw leaves every node still validating DIRTY.
 */
export function refresh(root: Node): void {
  const flags = root.flags;
  if ((flags & RUNNING) !== 0) throw new Error("Cycle detected");
  if ((flags & DIRTY) !== 0) {
    execute(root);
    return;
  }
  if ((flags & STALE) === 0) return;
  root.flags = flags & ~STALE;
  const base = descent.length;
  let n = root;
  let e = root.deps;
  try {
    for (;;) {
      let changed = false;
      while (e !== null) {
        const source: Node = e.from;
        const f = source.flags;
        if (__QUANT_STATS__) stats.validations++;
        if ((f & (STALE | DIRTY)) !== 0) {
          if ((f & RUNNING) !== 0) throw new Error("Cycle detected");
          if ((f & DIRTY) === 0) {
            source.flags = f & ~STALE;
            descent.push(e);
            n = source;
            e = source.deps;
            continue;
          }
          execute(source);
        }
        if (source.version !== e.version) {
          changed = true;
          break;
        }
        e = e.nextDep;
      }
      if (changed) execute(n);
      // Ascend; a parent whose child changed executes as well.
      for (;;) {
        if (descent.length === base) return;
        const up = descent.pop()!;
        n = up.to;
        if (up.from.version === up.version) {
          e = up.nextDep;
          break;
        }
        execute(n);
      }
    }
  } catch (error) {
    n.flags |= DIRTY;
    while (descent.length > base) descent.pop()!.to.flags |= DIRTY;
    throw error;
  }
}

/**
 * Universal: refresh every committed source before deciding, so a throwing
 * source is found before any irreversible step of the caller. Marks DIRTY on
 * change. Tentative relations (reads of a failed attempt) only wake; they
 * exist only while an execution is owed, so versions need no check then.
 */
export function validateAll(n: Node): void {
  const tentative = (n.gen + 1) & VERSION_MASK;
  let owed = (n.flags & DIRTY) !== 0;
  for (let e = n.deps; e !== null; e = e.nextDep) {
    const source = e.from;
    if (__QUANT_STATS__) stats.validations++;
    if ((source.flags & (STALE | DIRTY)) !== 0 && e.gen !== tentative) refresh(source);
    if (!owed && source.version !== e.version) {
      owed = true;
      n.flags |= DIRTY;
    }
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
  let value: unknown;
  try {
    value = n.fn!(n.value);
  } catch (error) {
    active = previous;
    abort(n, base);
    throw error;
  }
  active = previous;
  const flags = n.flags;
  if ((flags & INDEXED) !== 0) release(n, base);
  n.flags = flags & ~(RUNNING | INDEXED);
  if (n.fn === null) {
    teardown(n);
    return;
  }
  // Commit: drop the unread suffix, close the generation, publish the value.
  // (The pass moved the cursor; the reset above does not narrow it.)
  const cursor = n.cursor as Edge | null;
  if ((cursor === null ? n.deps : cursor.nextDep) !== null) cut(n, cursor);
  n.gen = (n.gen + 1) & VERSION_MASK;
  if (!Object.is(value, n.value)) {
    n.value = value;
    n.version = (n.version + 1) & VERSION_MASK;
  }
}

/** Clear the pass's slot cells and give back the ones it displaced. */
function release(n: Node, base: number): void {
  for (let e = n.deps; e !== null; e = e.nextDep) e.from.slot = null;
  for (let i = displaced.length - 2; i >= base; i -= 2)
    (displaced[i] as Node).slot = displaced[i + 1] as Edge;
  displaced.length = base;
}

/** Disposed during its own pass: the teardown was deferred to here. */
function teardown(n: Node): void {
  cut(n, null);
  n.flags &= ~(STALE | DIRTY | WOKEN);
}

/**
 * A failed pass: keep committed ∪ this attempt's reads as the wake set, drop
 * the unread relations earlier failed attempts left behind, owe an execution.
 */
function abort(n: Node, base: number): void {
  if ((n.flags & INDEXED) !== 0) release(n, base);
  n.flags &= ~(RUNNING | INDEXED);
  if (n.fn === null) {
    teardown(n);
    return;
  }
  n.flags |= DIRTY;
  const tentative = (n.gen + 1) & VERSION_MASK;
  const last = n.cursor;
  for (let e = last === null ? n.deps : last.nextDep; e !== null; ) {
    const after: Edge | null = e.nextDep;
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

function trackMiss(c: Node, source: Node, cursor: Edge | null, next: Edge | null): void {
  if (cursor !== null && cursor.from === source) {
    if (__QUANT_STATS__) stats.repeats++;
    cursor.version = source.version;
    return;
  }
  if ((c.flags & INDEXED) === 0) {
    if (source.subs === null) {
      // No subscriber at all: absent, whatever the lists hold.
      link(c, source, cursor, next, false);
      return;
    }
    // Bounded exact scans before indexing. A relation found anywhere is the
    // pair's unique relation; absence needs one side scanned completely.
    let e = next !== null ? next.nextDep : null;
    let budget = SCAN;
    while (e !== null && e.from !== source && --budget !== 0) e = e.nextDep;
    if (e !== null && e.from === source) {
      if (__QUANT_STATS__) stats.skips++;
      moveToCursor(c, e, cursor, next!);
      e.version = source.version;
      return;
    }
    let p = cursor !== null ? cursor.prevDep : null;
    budget = SCAN;
    while (p !== null && p.from !== source && --budget !== 0) p = p.prevDep;
    if (p !== null && p.from === source) {
      if (__QUANT_STATS__) stats.duplicates++;
      p.version = source.version;
      return;
    }
    if ((e === null && p === null) || unsubscribed(source, c)) {
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
  let budget = SCAN;
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
    gen: (c.gen + 1) & VERSION_MASK,
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
  n.flags &= ~(STALE | DIRTY | WOKEN);
}
