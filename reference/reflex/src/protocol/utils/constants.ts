/** Stabilize, then record the edge into the active computation, if any. */
export const LAZY = 1 << 0;

/** Stabilize without recording the edge. */
export const EAGER = 1 << 1;

/** Read modes of `readConsumer`. */
export const ConsumerReadMode = {
  lazy: LAZY,
  eager: EAGER,
} as const;

export type ConsumerReadModeValue =
  (typeof ConsumerReadMode)[keyof typeof ConsumerReadMode];
