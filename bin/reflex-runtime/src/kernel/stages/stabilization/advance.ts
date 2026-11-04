import { defaultContext } from "@runtime/kernel/config";
import {
  enterConsumerTracking,
  restoreConsumerTracking,
} from "@runtime/kernel/state";
import {
  devAssertExecutableNode,
  devAssertRefreshEdge,
  devRecordComputeError,
  devRecordComputeFinish,
  devRecordComputeStart,
  devRecordRecompute,
} from "@runtime/kernel/dev";
import {
  enterRuntimePhase,
  leaveRuntimePhase,
  RuntimePhase,
} from "@runtime/kernel/execution";
import {
  Changed,
  Computing,
  Both,
  Unknown,
  Visited,
  type ReactiveEdge,
  type ReactiveNode,
} from "@runtime/kernel/shape";
import { cleanupUnvisitedSources } from "@runtime/kernel/stages/tracking";
import { push_iterator_once } from "@runtime/kernel/stages/propagation";
import { observeRuntimeProjection } from "@runtime/kernel/projection";

/**
 * Recompute equality, `Object.is`. Writes compare with their own copy
 * (`sameWrittenValue`, protocol/write.producer.ts), so the two sites keep
 * separate type feedback.
 */
export const compare = Object.is;

/**
 * A computation threw. Cold path, kept out of `advanceCore`'s bytecode.
 *
 * The node becomes Changed: a failed pull-bubble computation may have entered
 * as Unknown after its dependencies already stabilized, and retrying must
 * execute the callback. A Changed node's incoming edges wake nothing (push
 * skips a Changed subscriber) and its next read recomputes without
 * validation, so they serve only as reconciliation material for the retry.
 * The pass keeps what it read and drops the residual suffix, as a successful
 * pass does; otherwise a series of failures with different reads would
 * accumulate the union of all of them until the first success. Watchers keep
 * theirs as a retry set (engine/watcher.ts).
 */
function settleFailedComputation(
  node: ReactiveNode,
  computingState: number,
): void {
  node.state = (computingState & ~(Computing | Unknown)) | Changed;
  if (node.tailIn !== node.lastIn) cleanupUnvisitedSources(node);
}

/**
 * Advance to next value
 *
 * Recompute `node` and, if it changed, propagate dirtiness to its outgoing users.
 *
 * The active pull walker owns the current parent edge; this only propagates
 * side-fanout that existed before recompute. `skipOutEdge` is that owned
 * edge, or null.
 *
 * JIT: no parameter default. A default copies the parameters to registers
 * and adds a branch to the bytecode every inlining caller is charged for.
 */
function advanceCore(
  node: ReactiveNode,
  skipOutEdge: ReactiveEdge | null,
): boolean {
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.advance.invoke");

  if (__DEV__) devAssertExecutableNode(node);

  const compute = node.compute as NonNullable<typeof node.compute>;
  node.tailIn = null;

  const computingState = (node.state & ~Visited) | Computing;
  node.state = computingState;

  const prevActive = enterConsumerTracking(node);

  if (__DEV__) devRecordComputeStart(node, defaultContext);

  let next: unknown;

  try {
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.advance.compute.run");

    next = compute();
  } catch (error) {
    restoreConsumerTracking(prevActive);
    settleFailedComputation(node, computingState);

    if (__DEV__) devRecordComputeError(node, error, defaultContext);

    throw error;
  }

  restoreConsumerTracking(prevActive);

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.advance.cleanup.check");

  if (node.tailIn !== node.lastIn) {
    node.state = computingState & ~Computing;
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.advance.cleanup.run");
    cleanupUnvisitedSources(node);
  }

  if (__DEV__) devRecordComputeFinish(node, next, defaultContext);

  // Either outcome resolves the node, and nothing observes it before the
  // outcome's DEV record, so the state is written once, ahead of the compare.
  node.state = computingState & ~(Computing | Both);

  const prev = node.payload;

  // JIT: `compare` is Object.is and returns a boolean. `=== true` compiles to
  // one reference compare instead of a generic ToBoolean on the call result.
  if (compare(prev, next) === true) {
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.advance.value.unchanged");

    if (__DEV__) devRecordRecompute(node, false, next, prev, defaultContext);
    return false;
  }

  node.payload = next;

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.advance.value.changed");

  if (__DEV__) devRecordRecompute(node, true, next, prev, defaultContext);

  const firstOut = node.firstOut;

  if (firstOut !== null) {
    if (__PROFILE__)
      observeRuntimeProjection?.(
        "projection.semantic.advance.propagate.invoke",
      );

    if (__DEV__) devAssertRefreshEdge(node, firstOut);
    // One push serves both cases: a null `skipOutEdge` never equals
    // `firstOut`. Only an owned edge that is the whole fan-out needs none.
    if (firstOut !== skipOutEdge || firstOut.nextOut !== null) {
      if (__PROFILE__ && skipOutEdge !== null)
        observeRuntimeProjection?.(
          "projection.semantic.advance.propagate.skip-edge",
        );
      push_iterator_once(firstOut, skipOutEdge);
    } else if (__PROFILE__) {
      observeRuntimeProjection?.(
        "projection.semantic.advance.propagate.owned-edge-only-skip",
      );
    }
  }

  return true;
}

export const advance: (
  node: ReactiveNode,
  skipOutEdge: ReactiveEdge | null,
) => boolean = __DEV__
  ? function advanceDev(node, skipOutEdge): boolean {
      enterRuntimePhase(RuntimePhase.Recomputing);

      try {
        return advanceCore(node, skipOutEdge);
      } finally {
        leaveRuntimePhase();
      }
    }
  : advanceCore;
