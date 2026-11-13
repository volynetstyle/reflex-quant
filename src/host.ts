// Policy around the kernel: the watcher lifecycle (check, consume the
// cleanup, run), a FIFO queue for scheduled watchers, and batching.
import { Flag, KEEP, TRIM } from "./graph";
import type { Cleanup, Flags, Node, NodeFn } from "./graph";
import { check, createNode, dispose, exec, onWake, untracked } from "./kernel";

/**
 * The queue: a ring of `mask + 1` slots, a power of two, holding the `size`
 * queued watchers from `head` on. It doubles only when full, so it holds
 * fewer than 2W + KEEP slots for W watchers queued at once (S8), and a
 * delivery takes no slot of its own: a slot is free again once taken.
 */
let queue: (Node | null)[] = new Array<Node | null>(KEEP).fill(null);
let mask = KEEP - 1;
let head = 0;
/**
 * Deliveries of the small drains since the last drain that needed the ring,
 * and the largest of them: the ring is given back once they add up to its
 * size (see `drain`).
 */
let spare = 0;
let calm = 0;
// The host's registers. Exported so a write's caller can test for work
// without a call into the host; ES bindings are read-only to importers, so
// only this module writes them.
/** Queued watchers. */
export let size = 0;
/** Open batches, plus one while a drain loop is open: work waits while > 0. */
export let hold = 0;

/** Queue a scheduled watcher once; the kernel calls this when it wakes one. */
export function wake(w: Node): void {
  const flags = w.flags;

  if ((flags & Flag.AutoQueued) !== Flag.Auto) return;

  w.flags = flags | Flag.Queued;

  if (size > mask) grow();

  queue[(head + size++) & mask] = w;
}

onWake(wake);

/** A full ring doubles, its watchers moved to the front in queue order. */
function grow(): void {
  const next = new Array<Node | null>(size + size).fill(null);

  for (let i = 0; i < size; i++) next[i] = queue[(head + i) & mask] as Node;

  queue = next;
  mask = size + size - 1;
  head = 0;
}

/** A watcher runs `fn` and keeps a returned function as its cleanup. */
export function watcher(fn: NodeFn, auto: boolean): Node {
  return createNode(
    fn,
    undefined,
    Flag.Watch | Flag.Stale | Flag.Dirty | (auto ? Flag.Auto : 0),
  );
}

/**
 * Check every committed source unless only signals woke it, then, if a run
 * is owed, consume the previous cleanup and run. A watcher neither STALE,
 * WOKEN is clean, or cold after a failure until a source changes. A failed
 * check leaves it STALE, so the next run checks again (V1) and the next push
 * finds it queued or delivers it again.
 * Precondition: its own run is not on the stack (flush is not reentrant).
 */
export function run(w: Node): void {
  deliver(w, w.flags);
}

/**
 * `run` with the watcher's flags already loaded: the drain clears QUEUED in
 * the same store that clears WAKE. WOKEN without STALE means only signals
 * woke it, and they made it DIRTY: no check, no reload.
 */
function deliver(w: Node, flags: Flags): void {
  if (w.fn === null || (flags & Flag.Wake) === 0) {
    w.flags = flags;
    return;
  }
  w.flags = flags & ~Flag.Wake;

  if ((flags & Flag.Stale) !== 0) {
    try {
      check(w);
    } catch (error) {
      w.flags |= Flag.Stale;
      throw error;
    }

    if ((w.flags & Flag.Dirty) === 0 || w.fn === null) return;
  }
  const cleanup = w.value;

  if (typeof cleanup === "function") {
    w.value = undefined;
    untracked(cleanup as Cleanup);

    if (w.fn === null) return;
  }
  exec(w);
}

/** Terminal: detach, then run the last cleanup outside tracking. */
export function stop(w: Node): void {
  if (w.fn === null) return;

  const cleanup = w.value;
  w.value = undefined;
  dispose(w);

  if (typeof cleanup === "function") untracked(cleanup as Cleanup);
}

/** Run queued watchers until the queue drains; rethrow the first error. */
export function flush(): void {
  if (size === 0 || hold !== 0) return;

  drainNow();
}

/**
 * `flush` with its guard at the call site: a write's caller tests
 * `size !== 0 && hold === 0` first (the queue first, so a write that woke
 * nothing costs one load), and calls this only when there is work.
 */
export function drainNow(): void {
  hold = 1;
  drain(false, undefined);
}

/**
 * A new scheduled watcher's first run. With no drain open, no batch and an
 * empty queue this is `wake(w); flush()` with the queue slot skipped: the
 * drain opens on `w` (so its run stays inside the drain loop, LOG 11), and a
 * fresh watcher has no sources to check and no cleanup, so `run` is `exec`.
 */
export function start(w: Node): void {
  if (hold !== 0 || size !== 0) {
    wake(w);
    return flush();
  }
  hold = 1;

  try {
    exec(w);
  } catch (error) {
    return drain(true, error);
  }
  drain(false, undefined);
}

/**
 * The drain loop, opened by the caller (`hold` is 1): FIFO, the first error
 * rethrown at the end.
 *
 * A drain whose deliveries (which bound its watchers queued at once) fill
 * less than a quarter of the ring is small. The ring is cut back at rest,
 * to KEEP or to the power of two above twice the largest small drain, once
 * the small drains since the last large one have delivered as many watchers
 * as the ring holds. Growing back costs O(ring), so a give-back followed by
 * a burst is O(1) per delivery; a burst after every few small drains keeps
 * its ring, and a burst followed by small drains is still given back.
 */
function drain(failed: boolean, first: unknown): void {
  let taken = 0;

  for (; size !== 0; taken++) {
    const queuedWatcher = queue[head]!;
    queue[head] = null;
    head = (head + 1) & mask;
    size--;

    try {
      deliver(queuedWatcher, queuedWatcher.flags & ~Flag.Queued);
    } catch (error) {
      if (!failed) first = error;

      failed = true;
    }
  }
  head = 0;

  if (mask >= TRIM) {
    if (taken + taken < mask >> 1) {
      if (taken > calm) calm = taken;

      if ((spare += taken) > mask) shrink(calm);
    } else spare = calm = 0;
  }
  hold = 0;

  if (failed) throw first;
}

/** Cut an empty ring to KEEP slots, or to the power of two above 2 * taken. */
function shrink(taken: number): void {
  let length = KEEP;

  while (length < taken + taken) length += length;

  queue.length = length;
  mask = length - 1;
  spare = calm = 0;
}

/**
 * The outermost batch end runs what the body deferred, also when the body
 * threw; then the body's error is the batch's error (F5), and a deferred
 * watcher's failure leaves only that watcher cold (F3). Inside a drain the
 * drain runs it.
 */
export function batch<T>(fn: () => T): T {
  hold++;
  let value: T;

  try {
    value = fn();
  } catch (error) {
    if (--hold === 0) {
      try {
        flush();
      } catch {
        // F5: a later error does not replace the body's.
      }
    }
    throw error;
  }
  if (--hold === 0) flush();

  return value;
}

/** Slots the queue holds now (tests). */
export function queueLength(): number {
  return queue.length;
}
