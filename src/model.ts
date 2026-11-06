// Compile-time vocabulary of the runtime graph. Nothing here exists at runtime.
import type { UNREAD } from "./flags";

// The aliases name different facts but do not brand numbers: counters wrap at
// MASK and edge versions can carry UNREAD.
export type Flags = number;
export type Version = number;
export type Generation = number;

/** A computed's or watcher's body; a signal has none. */
export type Fn = (prev: unknown) => unknown;
/** A watcher's cleanup, run untracked. */
export type Cleanup = () => unknown;

export interface Node {
  flags: Flags;
  value: unknown;
  /** Bumps on every Object.is-visible change of value. */
  ver: Version;
  /** null for a signal and for a disposed node. */
  fn: Fn | null;
  /** Sources, in read order. */
  deps: Edge | null;
  /** The running pass's last accepted source edge. */
  last: Edge | null;
  /** Subscribers, in birth order. */
  subs: Edge | null;
  lastSub: Edge | null;
  /** While a reader indexes: this node's edge into that reader. */
  slot: Edge | null;
  /** Successful runs; edges born since the last one are tentative. */
  gen: Generation;
}

export interface Edge {
  readonly from: Node;
  readonly to: Node;
  /** from.ver when `to` read it; UNREAD while indexed and not yet read. */
  ver: Version | typeof UNREAD;
  /** to.gen + 1 at birth: tentative while it still equals to.gen + 1. */
  gen: Generation;
  prev: Edge | null;
  next: Edge | null;
  prevSub: Edge | null;
  nextSub: Edge | null;
}

/** Shared LIFO of the kernel's walks: edges, and (source, cell) pairs. */
export type WorkStack = (Node | Edge | null)[];
