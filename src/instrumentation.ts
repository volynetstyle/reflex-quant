// Research counters, eliminated from production bundles.
export const stats = {
  reads: 0,
  hits: 0,
  repeats: 0,
  scans: 0,
  lookups: 0,
  dups: 0,
  moves: 0,
  links: 0,
  unlinks: 0,
  /** Walks that fill the slot index. */
  indexes: 0,
  /** Walks that mark a pass's unread suffix (LOG 28). */
  sweeps: 0,
  /** Edges walked by either. */
  indexed: 0,
  runs: 0,
  marks: 0,
  checks: 0,
};
