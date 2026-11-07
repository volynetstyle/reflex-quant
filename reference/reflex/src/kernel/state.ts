/* eslint-disable no-var */
import type { ReactiveNode } from "./shape";

export const enum RuntimeState {
  Idle = 0,
  Tracking = 1 << 0,
  Propagating = 1 << 1,
  Batching = 1 << 2,
  IdlePending = 1 << 3,
  HostWorkPending = 1 << 4,
}

const EXECUTION_ACTIVE = RuntimeState.Tracking | RuntimeState.Propagating;

/**
 * Compact runtime lifecycle register. `Idle` is exactly zero.
 */
export var runtimeState = RuntimeState.Idle;

export function setRuntimeState(state: number): void {
  runtimeState = state;
}

function setRuntimeStateFlag(flag: RuntimeState, enabled: boolean): void {
  runtimeState = enabled === true ? runtimeState | flag : runtimeState & ~flag;
}

/**
 * Runtime execution registers.
 *
 * These are intentionally module-level mutable bindings.
 * They sit on the hot path, so access should stay as cheap as possible:
 * direct reads/writes beat object property indirection here.
 */

// #region Tracking consumer register

/**
 * The consumer currently collecting dependencies.
 *
 * `null` means dependency tracking is disabled.
 */
export var currentConsumer: ReactiveNode | null = null;

/**
 * Replace the active dependency-tracking consumer.
 */
export function setCurrentConsumer(consumer: ReactiveNode | null): void {
  currentConsumer = consumer;
  setRuntimeStateFlag(RuntimeState.Tracking, consumer !== null);
}

/**
 * Start tracking reads for the given consumer.
 *
 * Returns the previous consumer so the caller can restore it later.
 */
export function enterConsumerTracking(
  consumer: ReactiveNode,
): ReactiveNode | null {
  const previousConsumer = currentConsumer;
  currentConsumer = consumer;
  runtimeState |= RuntimeState.Tracking;
  trackingStamp++;
  return previousConsumer;
}

/**
 * Restore the previous dependency-tracking consumer.
 */
export function restoreConsumerTracking(
  previousConsumer: ReactiveNode | null,
): void {
  currentConsumer = previousConsumer;
  if (previousConsumer === null) {
    runtimeState &= ~RuntimeState.Tracking;
  } else {
    runtimeState |= RuntimeState.Tracking;
  }
}

// #endregion

// #region Tracking epoch register

/**
 * Kernel-wide dependency-tracking clock: every tracking pass takes the next
 * value as its stamp, and edges keep the stamp of the pass that accepted them.
 *
 * The clock only moves forward and never repeats a value, so a stamp on a live
 * edge can never belong to a later pass (F13). It counts integers from 0; 0 is
 * never a pass stamp. Exactness holds for 2^53 passes (Number.MAX_SAFE_INTEGER),
 * beyond any realistic process lifetime.
 */
export var trackingStamp = 0;

/**
 * Move the clock forward to `epoch`. A value at or below the current epoch is
 * ignored: rewinding would let a stale stamp pose as a current-pass proof.
 */
export function setTrackingStamp(epoch: number): void {
  if (epoch > trackingStamp) trackingStamp = epoch;
}

/**
 * Advance the tracking epoch and return the new value.
 */
export function advanceTrackingStamp(): number {
  return ++trackingStamp;
}

/**
 * Keep the newest of the current epoch and `epoch` (context loads).
 */
export function keepNewestTrackingStamp(epoch: number): void {
  if (epoch > trackingStamp) trackingStamp = epoch;
}

/**
 * Whether epoch `a` is later than epoch `b`.
 */
export function isNewerEpoch(a: number, b: number): boolean {
  return a > b;
}

// #endregion

// #region Propagation scope register

/**
 * Current propagation nesting depth.
 *
 * Non-zero means the runtime is inside invalidation / propagation work.
 */
export var propagationScopeDepth = 0;

/**
 * Replace propagation depth.
 *
 * Mostly useful for context restore / tests.
 */
export function setPropagationScopeDepth(depth: number): void {
  propagationScopeDepth = depth < 0 ? 0 : depth;
  setRuntimeStateFlag(RuntimeState.Propagating, propagationScopeDepth !== 0);
}

/**
 * Enter a propagation scope.
 */
export function enterPropagationScopeRegister(): void {
  propagationScopeDepth++;
  runtimeState |= RuntimeState.Propagating;
}

/**
 * Leave a propagation scope.
 *
 * Returns `true` when propagation became idle.
 */
export function leavePropagationScopeRegister(): boolean {
  if (propagationScopeDepth > 0) {
    propagationScopeDepth--;
  }

  if (propagationScopeDepth === 0) {
    runtimeState &= ~RuntimeState.Propagating;
  }
  return (runtimeState & EXECUTION_ACTIVE) === RuntimeState.Idle;
}

/**
 * Whether runtime execution is currently idle.
 */
export function isRuntimeExecutionIdle(): boolean {
  return (runtimeState & EXECUTION_ACTIVE) === RuntimeState.Idle;
}

// #endregion

// #region Reactive batch registers

/**
 * Current reactive batch nesting depth.
 */
export var reactiveBatchDepth = 0;

/**
 * Whether runtime work, batching, or an idle notification is pending.
 * `RuntimeState.Idle` (zero) means the runtime has no active lifecycle state.
 */
export function enterReactiveBatchRegister(): void {
  ++reactiveBatchDepth;
  runtimeState |= RuntimeState.Batching;
}

export function leaveReactiveBatchRegister(): boolean {
  if (reactiveBatchDepth > 0) {
    --reactiveBatchDepth;
  }

  if (reactiveBatchDepth === 0) {
    runtimeState &= ~RuntimeState.Batching;
  }
  return reactiveBatchDepth === 0;
}

export function markRuntimeIdlePending(): void {
  setRuntimeStateFlag(RuntimeState.IdlePending, true);
}

export function clearRuntimeIdlePending(): void {
  setRuntimeStateFlag(RuntimeState.IdlePending, false);
}

export function markHostWorkPending(): void {
  runtimeState |= RuntimeState.HostWorkPending;
}

export function clearHostWorkPending(): void {
  runtimeState &= ~RuntimeState.HostWorkPending;
}

export function setReactiveBatchState(batchDepth: number, state: number): void {
  reactiveBatchDepth = batchDepth < 0 ? 0 : batchDepth;
  setRuntimeState(state);
}

export function isReactiveBatchActive(): boolean {
  return (runtimeState & RuntimeState.Batching) !== RuntimeState.Idle;
}

// #endregion
