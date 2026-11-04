// =============================================================================
// Host: when watchers run
// =============================================================================
//
// The kernel knows *whether* a watcher may need to run (it marks it STALE
// and calls `wake`). The host decides *when*:
//
//   - Woken watchers wait in a FIFO queue.
//   - The queue drains after a write (index.ts `set`), at the end of the
//     outermost batch, or when an effect is created.
//   - Draining is not reentrant. A write made by a running watcher only
//     queues more work, which the drain loop picks up after the current
//     watcher. So a watcher is never re-run inside its own run, and a
//     watcher that writes a source it reads converges instead of looping
//     on the stack.
//
// A watcher's lifecycle, each time it is taken from the queue:
//
//   validate   check(w): bring every source up to date; DIRTY if any changed
//   cleanup    if a run is owed, call the cleanup the last run returned
//   run        exec(w): run the callback; what it returns is the new cleanup
//
// Validation comes first and is complete (kernel section 6) so that a
// failing source throws before the cleanup, an irreversible step.
import {
  DIRTY,
  STALE,
  WATCH,
  check,
  dispose,
  exec,
  node,
  onWake,
  untracked,
  type Node,
} from "./kernel";

/** Run by this host's queue. Watchers without it are run by their owner (tests). */
const AUTO = 32;
/** Already in the queue: one entry per watcher. */
const QUEUED = 64;
/**
 * Its validation threw. Nothing changed since then, so no push will mark it
 * again; RETRY makes the next run validate anyway, so the error resurfaces
 * instead of the watcher silently going quiet.
 */
const RETRY = 128;

type Fn = () => unknown;

const queue: Node[] = [];
/** Nesting depth of `batch`; the queue drains when it returns to 0. */
let depth = 0;
let draining = false;

/** Queue a scheduled watcher once; the kernel calls this when it marks one. */
export function wake(w: Node): void {
  if ((w.flags & (AUTO | QUEUED)) !== AUTO) return;
  w.flags |= QUEUED;
  queue.push(w);
}

onWake(wake);

/**
 * A new watcher is STALE | DIRTY: it has never run, so it owes a run, and
 * the host must look at it.
 */
export function watcher(fn: Fn, auto: boolean): Node {
  return node(fn, undefined, WATCH | STALE | DIRTY | (auto ? AUTO : 0));
}

/**
 * Validate, then, if a run is owed, consume the previous cleanup and run.
 *
 * A watcher that is neither STALE nor RETRY has nothing to look at: either
 * it is clean, or its last run failed and it waits (DIRTY, "cold") for a
 * source to change and wake it.
 *
 * Precondition: its own run is not on the stack (the drain is not reentrant).
 */
export function run(w: Node): void {
  const f = w.flags;
  if (w.fn === null || (f & (STALE | RETRY)) === 0) return;
  w.flags = f & ~(STALE | RETRY);
  try {
    check(w);
  } catch (error) {
    w.flags |= RETRY;
    throw error;
  }
  if ((w.flags & DIRTY) === 0 || w.fn === null) return;
  const cleanup = w.value;
  if (typeof cleanup === "function") {
    // Consumed before it runs: a throwing cleanup is not called twice.
    w.value = undefined;
    untracked(cleanup as Fn);
    // The cleanup may have disposed its own watcher.
    if (w.fn === null) return;
  }
  exec(w);
}

/** Terminal: detach from all sources, then run the last cleanup outside tracking. */
export function stop(w: Node): void {
  if (w.fn === null) return;
  const cleanup = w.value;
  w.value = undefined;
  dispose(w);
  if (typeof cleanup === "function") untracked(cleanup as Fn);
}

/**
 * Run queued watchers in order until the queue is empty, including the ones
 * queued while draining. One failing watcher does not stop the others; the
 * first error is rethrown at the end, to whoever caused the drain.
 */
export function flush(): void {
  if (draining || depth !== 0) return;
  draining = true;
  let failed = false;
  let first: unknown;
  for (let i = 0; i < queue.length; i++) {
    const w = queue[i]!;
    w.flags &= ~QUEUED;
    try {
      run(w);
    } catch (error) {
      if (!failed) first = error;
      failed = true;
    }
  }
  queue.length = 0;
  draining = false;
  if (failed) throw first;
}

/**
 * Writes inside a batch only mark; watchers run once, when the outermost
 * batch ends. Reads inside still see up-to-date values: pull does not wait
 * for the batch.
 */
export function batch<T>(fn: () => T): T {
  depth++;
  try {
    return fn();
  } finally {
    if (--depth === 0) flush();
  }
}
