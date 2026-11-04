import { loadRuntimeConfiguration } from "./config";
import { createRuntimeContext, type RuntimeContext } from "./context.model";
import {
  loadRuntimeExecutionFrame,
  RUNTIME_EXECUTION_FRAMES_ENABLED,
  saveRuntimeExecutionFrame,
} from "./execution";
import {
  currentConsumer,
  keepNewestTrackingStamp,
  propagationScopeDepth,
  reactiveBatchDepth,
  setCurrentConsumer,
  setPropagationScopeDepth,
  setReactiveBatchState,
  trackingStamp,
  runtimeState,
} from "./state";

let activeRuntimeContext = createRuntimeContext();

export function getActiveRuntimeContext(): RuntimeContext {
  return activeRuntimeContext;
}

export function syncRuntimeContext(
  context: RuntimeContext,
  direction: "load" | "save",
): void {
  switch (direction) {
    case "load": {
      setCurrentConsumer(context.currentConsumer);
      // One kernel-wide clock: edges are shared by every context and stamped
      // with pass epochs, so a load may only move the epoch forward.
      keepNewestTrackingStamp(context.trackingStamp);
      setPropagationScopeDepth(context.propagationScopeDepth);
      setReactiveBatchState(context.batchDepth, context.runtimeState);
      loadRuntimeConfiguration(context);
      return;
    }
    case "save": {
      context.currentConsumer = currentConsumer;
      context.trackingStamp = trackingStamp;
      context.propagationScopeDepth = propagationScopeDepth;
      context.batchDepth = reactiveBatchDepth;
      context.runtimeState = runtimeState;
    }
  }
}

export function switchRuntimeContext(next: RuntimeContext): void {
  if (next === activeRuntimeContext) return;

  syncRuntimeContext(activeRuntimeContext, "save");
  if (RUNTIME_EXECUTION_FRAMES_ENABLED) {
    // Diagnostic phases belong to the domain that entered them (E2).
    activeRuntimeContext.executionFrame = saveRuntimeExecutionFrame();
    loadRuntimeExecutionFrame(next.executionFrame);
    next.executionFrame = null;
  }
  activeRuntimeContext = next;
  syncRuntimeContext(next, "load");
}
