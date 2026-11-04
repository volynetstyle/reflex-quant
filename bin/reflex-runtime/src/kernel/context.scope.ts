import { recordDebugEvent } from "../../debug/debug.runtime";
import { observeRuntimeProjection } from "@runtime/kernel/projection";

import { emitRuntimeIdleWithBatching } from "./batch";
import { defaultContext, runtimeIdleHook } from "./config";
import {
  enterPropagationScopeRegister,
  leavePropagationScopeRegister,
  markRuntimeIdlePending,
  propagationScopeDepth,
  RuntimeState,
  runtimeState,
  setPropagationScopeDepth,
} from "./state";

/**
 * Whether a settled event has an observer: an idle hook or host work.
 *
 * JIT: keep this a function returning a boolean, not an inline condition.
 * Inside an `if`, Terser reduces `(x & bit) !== 0` to a bare `x & bit` (or
 * `bit & ~x`), so `runtimeIdleHook !== undefined || ...` becomes a
 * `boolean | Smi` value and TurboFan emits a generic ToBoolean chain
 * (falsy-root compares, HeapNumber and BigInt map checks) in writeProducer.
 * A return is value context, and the build runs Terser with `inline: false`,
 * so the result stays a boolean; TurboFan inlines the call. writeProducer:
 * 249 to 222 instructions on B.chain (Node 24.22, perf/v8-shape/analyze.mjs).
 */
function isSettledObserved(): boolean {
  return (
    runtimeIdleHook !== undefined ||
    (runtimeState & RuntimeState.HostWorkPending) !== RuntimeState.Idle
  );
}

export const enterPropagationScope = !__PROFILE__
  ? enterPropagationScopeRegister
  : function (): void {
      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.context.propagation.scope-enter",
        );
      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.context.propagation.enter",
        );
      enterPropagationScopeRegister();
    };

export function leavePropagationScope(): void {
  if (__PROFILE__)
    observeRuntimeProjection?.(
      "projection.semantic.context.propagation.scope-leave",
    );
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.context.propagation.leave");

  if (leavePropagationScopeRegister() !== true) {
    if (propagationScopeDepth === 0 && isSettledObserved())
      markRuntimeIdlePending();
    return;
  }

  // Low-level runtimes commonly have no host settlement hook. Keep profile
  // counters and development debug events intact while avoiding the batching
  // dispatcher on the production no-hook path.
  if (!__DEV__ && !__PROFILE__ && !isSettledObserved()) return;

  emitRuntimeIdleWithBatching();
}

/** Leaves an aborted propagation scope without publishing a settled event. */
export function abortPropagationScope(): void {
  if (__PROFILE__)
    observeRuntimeProjection?.(
      "projection.semantic.context.propagation.scope-leave",
    );
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.context.propagation.leave");
  setPropagationScopeDepth(0);
}

export function emitSettledIfIdle(): void {
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.context.settled.check");

  if (!__DEV__ && !__PROFILE__ && !isSettledObserved()) return;
  if (
    (runtimeState & (RuntimeState.Tracking | RuntimeState.Propagating)) !==
    RuntimeState.Idle
  ) {
    if (propagationScopeDepth === 0 && isSettledObserved())
      markRuntimeIdlePending();
    return;
  }

  if (__DEV__) recordDebugEvent(defaultContext, "context:settled");
  emitRuntimeIdleWithBatching();
}
