// Policy around the kernel: the watcher lifecycle (check, consume the
// cleanup, run), a FIFO queue for scheduled watchers, and batching.
import { Flag } from "./graph";
import type { Cleanup, Fn, Node } from "./graph";
import { check, dispose, exec, node, onWake, untracked } from "./kernel";

const queue: (Node | null)[] = [];
// The host's registers. Exported so a write's caller can test for work
// without a call into the host; ES bindings are read-only to importers, so
// only this module writes them.
/** Queued watchers. */
export let size = 0;
/** Open batches. */
export let depth = 0;
/** A drain loop is open. */
export let draining = false;

/** Queue a scheduled watcher once; the kernel calls this when it wakes one. */
export function wake(w: Node): void {
  if ((w.flags & (Flag.Auto | Flag.Queued)) !== Flag.Auto) return;

  w.flags |= Flag.Queued;
  queue[size++] = w;
}

onWake(wake);

/** A watcher runs `fn` and keeps a returned function as its cleanup. */
export function watcher(fn: Fn, auto: boolean): Node {
  return node(
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
  const flags = w.flags;

  if (w.fn === null || (flags & (Flag.Stale | Flag.Woken)) === 0) return;

  w.flags = flags & ~(Flag.Stale | Flag.Woken);

  if ((flags & Flag.Stale) !== 0) {
    try {
      check(w);
    } catch (error) {
      w.flags |= Flag.Stale;
      throw error;
    }
  }

  if ((w.flags & Flag.Dirty) === 0 || w.fn === null) return;

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
  if (size === 0 || draining || depth !== 0) return;

  drainNow();
}

/**
 * `flush` with its guard at the call site: a write's caller tests
 * `size !== 0 && !draining && depth === 0` first (the queue first, so a write
 * that woke nothing costs one load), and calls this only when there is work.
 */
export function drainNow(): void {
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
    const queuedWatcher = queue[i]!;
    queue[i] = null;
    queuedWatcher.flags &= ~Flag.Queued;

    try {
      run(queuedWatcher);
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
