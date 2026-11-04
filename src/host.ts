// Policy around the kernel: the watcher lifecycle (validate, consume the
// cleanup, execute), a FIFO queue for scheduled watchers, and batching.
import {
  DIRTY,
  STALE,
  WATCH,
  WOKEN,
  dispose,
  execute,
  node,
  setDeliver,
  untracked,
  validateAll,
  type Node,
} from "./kernel";

/** Scheduled by this host; unscheduled watchers are run by their owner. */
const SCHEDULED = 64;
const QUEUED = 128;
/** Validation threw: run() validates again although no push re-marked it (V1). */
const RETRY = 256;

type Body = () => unknown;

const queue: Node[] = [];
let depth = 0;
let flushing = false;

/** Queue a scheduled watcher once; the kernel calls this on every push. */
export function schedule(w: Node): void {
  if ((w.flags & (SCHEDULED | QUEUED)) !== SCHEDULED) return;
  w.flags |= QUEUED;
  queue.push(w);
}

setDeliver(schedule);

/** A watcher runs `body` and keeps its returned function as the cleanup. */
export function watcher(body: Body, scheduled: boolean): Node {
  return node(body, undefined, WATCH | STALE | DIRTY | (scheduled ? SCHEDULED : 0));
}

/**
 * Validate every committed dependency, then, if an execution is owed,
 * consume the previous cleanup and execute. A watcher that is not STALE is
 * clean, or cold after a failure until a dependency changes.
 */
export function run(w: Node): void {
  // Precondition: w's own pass is not on the stack (flush is not reentrant).
  const flags = w.flags;
  if (w.fn === null || (flags & (STALE | WOKEN | RETRY)) === 0) return;
  w.flags = flags & ~(STALE | WOKEN | RETRY);
  // Woken by signals only: every committed computed source is clean, so the
  // universal validation would find nothing; the write already owed it.
  if ((flags & (STALE | RETRY)) !== 0) {
    try {
      validateAll(w);
    } catch (error) {
      w.flags |= RETRY;
      throw error;
    }
  }
  if ((w.flags & DIRTY) === 0 || w.fn === null) return;
  const cleanup = w.value;
  if (typeof cleanup === "function") {
    w.value = undefined;
    untracked(cleanup as Body);
    if (w.fn === null) return;
  }
  execute(w);
}

/** Terminal: detach, then run the last cleanup outside tracking. */
export function stop(w: Node): void {
  if (w.fn === null) return;
  const cleanup = w.value;
  w.value = undefined;
  dispose(w);
  if (typeof cleanup === "function") untracked(cleanup as Body);
}

/** Run queued watchers until the queue drains; rethrow the first error. */
export function flush(): void {
  if (flushing || depth !== 0 || queue.length === 0) return;
  flushing = true;
  let failed = false;
  let first: unknown;
  try {
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
  } finally {
    queue.length = 0;
    flushing = false;
  }
  if (failed) throw first;
}

export function batch<T>(fn: () => T): T {
  depth++;
  try {
    return fn();
  } finally {
    if (--depth === 0) flush();
  }
}
