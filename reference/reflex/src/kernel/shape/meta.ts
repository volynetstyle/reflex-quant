/**
 * Reactive node state is composed from independent flag groups:
 *
 *  - Evidence   : Unknown | Changed
 *  - Execution  : Visited | Computing
 *  - Scheduling : Scheduled
 *  - Role       : Producer | Consumer | Watcher
 *
 * Evidence forms a two-bit Boolean lattice:
 *                  (Both)
 *             Unknown | Changed
 *              /            \
 *           Unknown       Changed
 *              \            /
 *                   None
 *
 * For watchers, `Unknown` and `Changed` are independent obligations:
 *
 *  Unknown
 *      At least one committed dependency still requires validation.
 *
 *  Changed
 *      At least one dependency has already proven that execution is required
 *      once validation succeeds.
 *
 * Watcher evidence accumulated during one unsettled propagation wave is
 * monotonic:
 *
 *      merge(a, b) = a | b
 *
 * and therefore commutative, associative and idempotent.
 *
 * Validation may later discharge `Unknown`; this is a separate operation from
 * propagation-time evidence accumulation.
 *
 * Watcher propagation-time evidence is monotonic:
 *
 * nextEvidence = currentEvidence | incomingEvidence
 *
 * It must never discard an already-known watcher obligation.
 *
 * Ordinary computed nodes use the same bits as an ordered dirty state:
 * a direct `Changed` supersedes `Unknown` because recomputation is already
 * required. Resolution belongs to validation/evaluation stages, not watcher
 * propagation merge.
 */

/**
 * Bottom of semilattice.
 */
export const None = 0b00;
/**
 * Validation is required before execution/recomputation may proceed.
 */
export const Unknown = 1 << 0; // 1
/**
 * Execution/recomputation is definitely required.
 * No further validation is needed to establish that fact.
 */
export const Changed = 1 << 1; // 2
/**
 * Top of semilattice.
 */
export const Both = Unknown | Changed; // =3

// end of paragraph
/** Node has already been visited during the current traversal. */
export const Visited = 1 << 2; // 4
/** Node is currently being evaluated. */
export const Computing = 1 << 3; // 8
/** Node performs side effects and has no output value. */
export const Watcher = 1 << 4; // 16

// <!-- Watcher -->
/** Watcher has been enqueued for execution. */
export const Scheduled = 1 << 5; // 32
export const Disposed = 1 << 6; // 64
/** Watcher payload owns a cleanup callback. */
export const WatcherCleanupPending = 1 << 7; // 128
/**
 * Transitive invalidation reached a watcher during its own validation or
 * execution epoch. It retains a validation obligation only: unlike Visited, it
 * is never execution evidence.
 */
export const Revalidate = 1 << 8; // 256

/**
 * Prepared-tape membership (graph/tape.ts): the node may have an edge to
 * the consumer that holds the tape lease. Set for every producer when the
 * tape is prepared and for the producer of every edge linked to the owner
 * while the lease is recorded; cleared when the lease is released. It only
 * ever says "maybe": a stale bit costs one exact lookup, never an answer.
 * Every computation derives `state` from itself, so the bit survives them.
 */
export const Leased = 1 << 9; // 512

// <!-- Watcher end -->

// ...
// free powers include 29 and 30 in prod [6, 31*]
// ...

/**
 * Only available in the development environment (DEV),
 * Source node whose value is committed externally.
 * */
export const Producer = __DEV__ ? 1 << 29 : 0;

/**
 * Only available in the development environment (DEV),
 * as it is not required in the production environment
 * prod) under heavy use (hot path).
 */
export const Consumer = __DEV__ ? 1 << 30 : 0;

export type ReactiveNodeState = number;

/** Clean producer. Normal steady state for source nodes. */
export const PRODUCER_INITIAL_STATE = Producer;
/** Directly invalidated computed node: skip verification and recompute on read. */
export const CONSUMER_INITIAL_STATE = Changed | Consumer;
/** Watcher starts with both validation and initial-execution obligations. */
export const WATCHER_INITIAL_STATE = Both | Watcher | Consumer;
