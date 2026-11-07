import { observeRuntimeProjection } from "@runtime/kernel/projection";

import {
  DEFAULT_READ_TRACKING_STRATEGY,
  loadRuntimeConfiguration,
} from "./config";
import {
  applyRuntimeContextOptions,
  createRuntimeContext,
  isRuntimeContext,
  type RuntimeContext,
  type RuntimeContextOptions,
  type RuntimeContextSnapshot,
} from "./context.model";
import {
  getActiveRuntimeContext,
  switchRuntimeContext,
  syncRuntimeContext,
} from "./context.switch";
import { resetRuntimeExecutionState } from "./execution";
import { trackingStamp } from "./state";

export { createRuntimeContext, getActiveRuntimeContext };
export type {
  RuntimeContext,
  RuntimeContextOptions,
  RuntimeContextSnapshot,
} from "./context.model";
export type { RuntimeHooks, RuntimeHostHooks } from "./config";

/** Reusable stack of suspended runtime contexts. */
const suspendedContexts: (RuntimeContext | undefined)[] = [];
let suspendedDepth = 0;

export function runWithRuntimeContext<T>(
  context: RuntimeContext,
  fn: () => T,
): T {
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.context.run");

  const previous = getActiveRuntimeContext();
  if (previous === context) return fn();

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.context.switch");

  switchRuntimeContext(context);
  suspendedContexts[suspendedDepth++] = previous;

  try {
    return fn();
  } finally {
    suspendedContexts[--suspendedDepth] = undefined;
    switchRuntimeContext(previous);
  }
}

/**
 * Opens the region of `runWithRuntimeContext(context, fn)` around a callback
 * the caller invokes itself, so the callback is not passed through this call.
 * Returns the context to restore, or `null` when `context` is already active.
 * Every exit, including a throw, must pass the result to
 * `leaveRuntimeContextRegion`.
 */
export function enterRuntimeContextRegion(
  context: RuntimeContext,
): RuntimeContext | null {
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.context.run");
  const previous = getActiveRuntimeContext();
  if (previous === context) return null;

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.context.switch");
  switchRuntimeContext(context);
  suspendedContexts[suspendedDepth++] = previous;
  return previous;
}

/** Closes a region opened by `enterRuntimeContextRegion`. */
export function leaveRuntimeContextRegion(
  previous: RuntimeContext | null,
): void {
  if (previous === null) return;
  suspendedContexts[--suspendedDepth] = undefined;
  switchRuntimeContext(previous);
}

/** Whether a context has a suspended continuation. */
export function isRuntimeContextSuspended(context: RuntimeContext): boolean {
  for (let i = suspendedDepth - 1; i >= 0; i--) {
    if (suspendedContexts[i] === context) return true;
  }

  return false;
}

export function configureRuntimeContext(
  context: RuntimeContext,
  options?: RuntimeContextOptions,
): void;
export function configureRuntimeContext(options?: RuntimeContextOptions): void;
export function configureRuntimeContext(
  contextOrOptions: RuntimeContext | RuntimeContextOptions = {},
  maybeOptions: RuntimeContextOptions = {},
): void {
  const explicitContext = isRuntimeContext(contextOrOptions);
  const context = explicitContext
    ? contextOrOptions
    : getActiveRuntimeContext();
  applyRuntimeContextOptions(
    context,
    explicitContext ? maybeOptions : contextOrOptions,
  );
  // Configuration only: the active execution registers are live and the
  // context object holds stale copies of them until the next save.
  if (context === getActiveRuntimeContext()) loadRuntimeConfiguration(context);
}

/**
 * Hard reset of a context's registers and configuration.
 *
 * Resetting the active context is a recovery tool: the caller asserts that no
 * continuation of that context will resume. Resetting a context suspended
 * below the active one is rejected, because its continuation will resume.
 */
export function resetRuntimeContext(
  context: RuntimeContext = getActiveRuntimeContext(),
): void {
  if (isRuntimeContextSuspended(context)) {
    throw new Error(
      "Cannot reset a runtime context while its execution is suspended by a nested context.",
    );
  }

  context.currentConsumer = null;
  context.trackingStamp = 0;
  context.propagationScopeDepth = 0;
  context.batchDepth = 0;
  context.runtimeState = 0;
  context.readTrackingStrategy = DEFAULT_READ_TRACKING_STRATEGY;
  context.nodeInvalidatedHook = undefined;
  context.runtimeIdleHook = undefined;
  context.hostFlushHook = undefined;
  context.executionFrame = null;

  if (context === getActiveRuntimeContext()) {
    resetRuntimeExecutionState();
    // The clock is not rewound: nodes and edges survive a reset, and a
    // repeated stamp would pose as a current-pass proof (F13).
    syncRuntimeContext(context, "load");
  }
}

export function snapshotRuntimeContext(
  context: RuntimeContext = getActiveRuntimeContext(),
): RuntimeContextSnapshot {
  if (context === getActiveRuntimeContext())
    syncRuntimeContext(context, "save");

  const {
    currentConsumer,
    trackingStamp,
    propagationScopeDepth,
    batchDepth,
    runtimeState,
    readTrackingStrategy,
    nodeInvalidatedHook,
    runtimeIdleHook,
    hostFlushHook,
  } = context;
  return {
    currentConsumer,
    trackingStamp,
    propagationScopeDepth,
    batchDepth,
    runtimeState,
    readTrackingStrategy,
    nodeInvalidatedHook,
    runtimeIdleHook,
    hostFlushHook,
  };
}

/**
 * Restores a register-bank checkpoint taken by `snapshotRuntimeContext`.
 *
 * Legal at a quiescent boundary of `context`, or to unwind to a checkpoint
 * taken by an enclosing frame that is still on the stack. The tracking epoch
 * is never restored: it is the kernel-wide clock and only moves forward.
 */
export function restoreRuntimeContextSnapshot(
  context: RuntimeContext,
  snapshot: RuntimeContextSnapshot,
): void {
  const active = context === getActiveRuntimeContext();
  if (active) context.trackingStamp = trackingStamp;
  context.currentConsumer = snapshot.currentConsumer;
  context.propagationScopeDepth = snapshot.propagationScopeDepth;
  context.batchDepth = snapshot.batchDepth;
  context.runtimeState = snapshot.runtimeState;
  context.readTrackingStrategy = snapshot.readTrackingStrategy;
  context.nodeInvalidatedHook = snapshot.nodeInvalidatedHook;
  context.runtimeIdleHook = snapshot.runtimeIdleHook;
  context.hostFlushHook = snapshot.hostFlushHook;
  if (active) syncRuntimeContext(context, "load");
}
