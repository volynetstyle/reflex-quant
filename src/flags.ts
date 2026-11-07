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
}

/** edge.ver of an edge the marked or indexed run has not read yet. */
export const UNREAD = -1;
/** Counters wrap inside the SMI range. */
export const MASK = 0x3fffffff;
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
 * Work-stack slots kept at rest, and the length past which the outermost
 * walk's end cuts the stack back to them. The gap keeps walks only a little
 * deeper than KEEP from cutting and regrowing on every pass.
 */
export const KEEP = 256;
export const TRIM = 512;
