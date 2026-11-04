import { observeRuntimeProjection } from "@runtime/kernel/projection";

import { emitRuntimeIdle } from "./config";
import {
  clearRuntimeIdlePending,
  enterReactiveBatchRegister,
  leaveReactiveBatchRegister,
  markRuntimeIdlePending,
  RuntimeState,
  runtimeState,
} from "./state";

/**
 * Enters a reactive batch boundary.
 *
 * Writes and invalidations still happen immediately, and lazy consumers still
 * recompute on demand. The boundary only defers host-visible reactive-settled
 * notifications. Effect scheduling belongs to the host scheduler and is not
 * part of this operation.
 */
export function enterReactiveBatch(): void {
  enterReactiveBatchRegister();
}

/**
 * Leaves a reactive batch boundary.
 *
 * The outermost exit delivers one deferred reactive-settled notification when
 * runtime execution is idle. This is the complete runtime exit operation;
 * callers must not inspect or flush settlement registers themselves.
 */
export function leaveReactiveBatch(): void {
  leaveReactiveBatchRegister();
  flushPendingRuntimeIdle();
}

export function flushPendingRuntimeIdle(): void {
  const blockingState =
    RuntimeState.Tracking | RuntimeState.Propagating | RuntimeState.Batching;

  if (
    (runtimeState & RuntimeState.IdlePending) === RuntimeState.Idle ||
    (runtimeState & blockingState) !== RuntimeState.Idle
  )
    return;

  clearRuntimeIdlePending();
  emitRuntimeIdle();
}

export function emitRuntimeIdleWithBatching(): void {
  if ((runtimeState & RuntimeState.Batching) !== RuntimeState.Idle) {
    markRuntimeIdlePending();
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.context.settled.defer");
    return;
  }

  // A batch can end while propagation/tracking is still active. The next idle
  // checkpoint owns delivery of that deferred notification.
  if ((runtimeState & RuntimeState.IdlePending) !== RuntimeState.Idle) {
    clearRuntimeIdlePending();
  }
  emitRuntimeIdle();
}
