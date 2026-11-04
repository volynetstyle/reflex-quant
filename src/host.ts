// Policy around the kernel: the watcher lifecycle (check, consume the
// cleanup, run), a FIFO queue for scheduled watchers, and batching.
import {
  DIRTY,
  STALE,
  WATCH,
  WOKEN,
  check,
  dispose,
  exec,
  node,
  onWake,
  untracked,
  type Node,
} from "./kernel";

/** Run by this host's queue; other watchers are run by their owner. */
const AUTO = 64;
const QUEUED = 128;
/** Its check threw: run() checks again although no push marked it (V1). */
const RETRY = 256;

type Fn = () => unknown;

const queue: (Node | null)[] = [];
let size = 0;
let depth = 0;
let draining = false;

/** Queue a scheduled watcher once; the kernel calls this when it wakes one. */
export function wake(w: Node): void {
  if ((w.flags & (AUTO | QUEUED)) !== AUTO) return;
  w.flags |= QUEUED;
  queue[size++] = w;
}

onWake(wake);

/** A watcher runs `fn` and keeps a returned function as its cleanup. */
export function watcher(fn: Fn, auto: boolean): Node {
  return node(fn, undefined, WATCH | STALE | DIRTY | (auto ? AUTO : 0));
}

/**
 * Check every committed source unless only signals woke it, then, if a run
 * is owed, consume the previous cleanup and run. A watcher neither STALE,
 * WOKEN nor RETRY is clean, or cold after a failure until a source changes.
 * Precondition: its own run is not on the stack (flush is not reentrant).
 */
export function run(w: Node): void {
  const f = w.flags;
  if (w.fn === null || (f & (STALE | WOKEN | RETRY)) === 0) return;
  w.flags = f & ~(STALE | WOKEN | RETRY);
  if ((f & (STALE | RETRY)) !== 0) {
    try {
      check(w);
    } catch (error) {
      w.flags |= RETRY;
      throw error;
    }
  }
  if ((w.flags & DIRTY) === 0 || w.fn === null) return;
  const cleanup = w.value;
  if (typeof cleanup === "function") {
    w.value = undefined;
    untracked(cleanup as Fn);
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
  if (typeof cleanup === "function") untracked(cleanup as Fn);
}

/** Run queued watchers until the queue drains; rethrow the first error. */
export function flush(): void {
  if (draining || depth !== 0 || size === 0) return;
  draining = true;
  drain(false, undefined);
}

/**
 * A new scheduled watcher's first run. With no drain open, no batch and an
 * empty queue this is `wake(w); flush()` with the queue slot skipped: the
 * drain opens on `w` (so its run stays inside the drain loop, LOG 11), and a
 * fresh watcher has no sources to check and no cleanup, so `run` is `exec`.
 */
export function start(w: Node): void {
  if (draining || depth !== 0 || size !== 0) {
    wake(w);
    return flush();
  }
  draining = true;
  try {
    exec(w);
  } catch (error) {
    return drain(true, error);
  }
  drain(false, undefined);
}

/** The drain loop, opened by the caller: FIFO, the first error rethrown at the end. */
function drain(failed: boolean, first: unknown): void {
  for (let i = 0; i < size; i++) {
    const w = queue[i]!;
    queue[i] = null;
    w.flags &= ~QUEUED;
    try {
      run(w);
    } catch (error) {
      if (!failed) first = error;
      failed = true;
    }
  }
  size = 0;
  draining = false;
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
