// Quant internals for the cost probes (bench/cost): the public API with raw
// handles (a handle is the node), the kernel and graph primitives the probes
// time in isolation, and replicas of the private steps they need. Research
// only; never part of a release.
import { Flag, MASK } from "../../src/flags.ts";
import type { Node } from "../../src/model.ts";

export { batch, computed, dispose, effect, get, peek, set, signal, untracked, update } from "../../src/index.ts";
export { index, read, write } from "../../src/kernel.ts";
export { move } from "../../src/graph.ts";

export const name = "quant-internals";

/** The flags `read` tests before it pulls. */
export const PULL_FLAGS: number = Flag.Stale | Flag.Dirty | Flag.Busy;
export { UNREAD } from "../../src/flags.ts";
export const VERSION_MASK: number = MASK;

/**
 * Replica of the kernel's private `unindex` for a consumer whose index
 * displaced nothing: clear the slots and the flag. It also restores the
 * versions `index` set to UNREAD, which a real pass does through its reads.
 */
export function clearIndex(c: Node): void {
  for (let e = c.deps; e !== null; e = e.next) {
    e.from.slot = null;
    e.ver = e.from.ver;
  }
  c.flags &= ~Flag.Indexed;
}
