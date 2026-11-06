// Flag layout and constants used by the kernel and host.
export const enum Flag {
  /** A source below may have changed; a watcher must validate. */
  Stale = 1 << 0,
  /** Must run: first run, failed run, or a direct source changed. */
  Dirty = 1 << 1,
  /** Its run is on the stack. */
  Busy = 1 << 2,
  /** Its run put its edges into the sources' slots. */
  Indexed = 1 << 3,
  /** Its run marked its unread edges UNREAD; pairs are found through subscribers. */
  Marked = 1 << 8,
  /** A watcher: handed to the host, never read. */
  Watch = 1 << 4,
  /** Woken by signals only; computed sources need no validation. */
  Woken = 1 << 5,
  /** Host policy: scheduled by the reference host. */
  Auto = 1 << 6,
  /** Host policy: already in its queue. */
  Queued = 1 << 7,
}

/** edge.ver of an edge the marked or indexed run has not read yet. */
export const UNREAD = -1;
/** Counters wrap inside the SMI range. */
export const MASK = 0x3fffffff;
/** Scan budget of every bounded search: a constant keeps a run linear. */
export const SCAN = 8;
