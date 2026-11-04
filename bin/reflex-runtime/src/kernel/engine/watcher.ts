import { defaultContext, emitNodeInvalidated } from "@runtime/kernel/config";
import { flushPendingRuntimeIdle } from "@runtime/kernel/batch";
import {
  currentConsumer,
  RuntimeState,
  runtimeState,
  setCurrentConsumer,
} from "@runtime/kernel/state";
import {
  devRecordWatcherCleanup,
  devRecordWatcherDispose,
  devRecordWatcherFinish,
  devRecordWatcherSkip,
  devRecordWatcherStart,
} from "@runtime/kernel/dev";
import {
  devAssertNoRuntimeHookWatcherExecution,
  devAssertNoRuntimeHookTopologyMutation,
  enterRuntimePhase,
  leaveRuntimePhase,
  RuntimePhase,
} from "@runtime/kernel/execution";
import {
  Both,
  disposeNode,
  Changed,
  Computing,
  Unknown,
  Scheduled,
  Visited,
  Revalidate,
  WatcherCleanupPending,
  type WatcherCleanup,
  type WatcherNode,
} from "@runtime/kernel/shape";
import { pull_frontier } from "@runtime/kernel/stages/stabilization/pull_frontier";
import { observeRuntimeProjection } from "@runtime/kernel/projection";

import { executeKnownNodeComputation } from "./watcher.execution";

const WATCHER_TRANSIENT_STATE =
  Both | Visited | Computing | Scheduled | Revalidate;

function recoverWatcherAfterError(node: WatcherNode): void {
  // A failed lifecycle callback must not leave an unscheduled dirty watcher:
  // such a node can no longer be invalidated and becomes a zombie. Keep its
  // dependency set as a conservative retry set, but return it to an idle
  // state so the next source change can schedule it again.
  node.state &= ~WATCHER_TRANSIENT_STATE;
}
/**
 * Pull validation failed before watcher lifecycle execution began. Preserve
 * committed dependencies and cleanup, but canonicalize transient traversal
 * state so an explicit later run retries validation from the beginning.
 */
function recoverWatcherAfterValidationError(node: WatcherNode): void {
  // Scheduled belongs to the external queue, not to the failed traversal.
  // Preserve it so the scheduler can identify and defer a reentrant queue
  // entry instead of executing the same failed watcher twice in one drain.
  const retryState = (node.state & (Changed | Visited | Scheduled)) | Unknown;
  node.state = (node.state & ~WATCHER_TRANSIENT_STATE) | retryState;
}
/**
 * A watcher callback can fail because a nested reactive read failed. That is
 * semantically an incomplete validation, even when a warmed cache promoted
 * the watcher to Changed and selected the direct execution path. Detect this
 * only after an exception; successful watcher execution pays no scan cost.
 */
function recoverWatcherAfterComputationError(node: WatcherNode): void {
  for (let edge = node.firstIn; edge !== null; edge = edge.nextIn) {
    if ((edge.from.state & Both) !== 0) {
      recoverWatcherAfterValidationError(node);
      return;
    }
  }

  recoverWatcherAfterError(node);
}

/** Claims ownership of this watcher for an external scheduler queue. */
export function claimWatcherSchedule(node: WatcherNode): boolean {
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.watcher.schedule.attempt");
  const state = node.state;

  if ((state & Scheduled) !== 0) {
    if (__PROFILE__)
      observeRuntimeProjection?.(
        "projection.semantic.watcher.schedule.dedup-skip",
      );
    return false;
  }

  node.state = state | Scheduled;
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.watcher.schedule.success");
  return true;
}

/** Releases ownership of this watcher from an external scheduler queue. */
export function releaseWatcherSchedule(node: WatcherNode): void {
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.watcher.schedule.release");
  node.state &= ~Scheduled;
}

function runCleanup(cleanup: WatcherCleanup): void {
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.watcher.cleanup");

  const prevActive = currentConsumer;

  if (prevActive === null) {
    cleanup();
    return;
  }

  setCurrentConsumer(null);

  try {
    cleanup();
  } finally {
    setCurrentConsumer(prevActive);
  }
}

/**
 * Cold path, stable exit of a validation that retained Unknown. A direct
 * Visited was already delivered by push. A transitive Revalidate was not:
 * push does not emit to a dirty watcher. Hand that obligation to the host
 * unless a queue already owns this watcher.
 */
function deliverRetainedValidation(node: WatcherNode): void {
  if ((node.state & (Revalidate | Visited | Scheduled)) === Revalidate)
    emitNodeInvalidated(node);
}

/**
 * Cold path, completion of an execution invalidated during itself. Visited
 * keeps an execution obligation; Revalidate keeps only validation. Push
 * delivered Visited when it was recorded; Revalidate must be delivered here,
 * since later pushes merge into the retained Unknown silently.
 */
function retainAfterExecution(node: WatcherNode): void {
  const undelivered =
    (node.state & (Revalidate | Visited | Scheduled)) === Revalidate;
  node.state = (node.state & ~(Changed | Revalidate)) | Unknown;
  if (undelivered) emitNodeInvalidated(node);
}

export function runWatcher(node: WatcherNode): void {
  runWatcherWithoutSettledCheckpoint(node);
  if ((runtimeState & RuntimeState.IdlePending) !== RuntimeState.Idle) {
    flushPendingRuntimeIdle();
  }
}

/** Scheduler drain entry point; the caller owns one checkpoint after draining. */
export const runWatcherWithoutSettledCheckpoint = !__DEV__
  ? runWatcherCore
  : function (node: WatcherNode): void {
      devAssertNoRuntimeHookWatcherExecution();
      enterRuntimePhase(RuntimePhase.WatcherExecution);
      try {
        runWatcherCore(node);
      } finally {
        leaveRuntimePhase();
      }
    };

function runWatcherCore(node: WatcherNode): void {
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.watcher.run");

  const state = node.state;

  if ((state & Both) === 0) {
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.watcher.clean.skip");

    devRecordWatcherSkip(node, "clean", defaultContext);
    return;
  }

  if ((state & Unknown) !== 0) {
    const mustExecute = (state & (Changed | Visited)) !== 0;

    let changed: boolean;

    try {
      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.watcher.frontier.invoke",
        );
      changed = pull_frontier(node, node.firstIn);
    } catch (error) {
      recoverWatcherAfterValidationError(node);
      throw error;
    }

    const invalidatedDuringValidation =
      (node.state & (Visited | Revalidate)) !== 0;

    if (!invalidatedDuringValidation) node.state &= ~Unknown;
    if (mustExecute || changed === true) node.state |= Changed;

    if ((node.state & Changed) === 0) {
      if (__PROFILE__)
        observeRuntimeProjection?.("projection.semantic.watcher.stable.skip");

      devRecordWatcherSkip(node, "stable", defaultContext);
      if ((node.state & Revalidate) !== 0) deliverRetainedValidation(node);
      return;
    }
  }

  if (node.compute === undefined) {
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.watcher.disposed.skip");

    node.state &= ~Both;
    devRecordWatcherSkip(node, "stable", defaultContext);
    return;
  }

  const compute = node.compute;
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.watcher.execute");

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.watcher.cleanup.check");
  const prevCleanup =
    (node.state & WatcherCleanupPending) !== 0
      ? (node.payload as WatcherCleanup)
      : null;

  if (__DEV__)
    devRecordWatcherStart(node, prevCleanup !== null, defaultContext);

  node.state &= ~(Visited | Revalidate);

  if (prevCleanup !== null) {
    // Clearing is only required when a cleanup is actually owned. The common
    // no-cleanup watcher keeps an already-undefined payload and avoids a hot
    // property store on every execution.
    node.payload = undefined;
    node.state &= ~WatcherCleanupPending;
    try {
      runCleanup(prevCleanup);
    } catch (error) {
      // A cleanup may write through a dependency before failing. Idle recovery
      // would then hide that dirty upstream from every later push.
      recoverWatcherAfterComputationError(node);
      throw error;
    }
    devRecordWatcherCleanup(node, defaultContext);

    if (node.compute === undefined) {
      node.state &= ~Both;
      if (__DEV__) {
        devRecordWatcherFinish(node, false, undefined, defaultContext);
      }
      return;
    }
  }

  let result: ReturnType<typeof compute>;

  try {
    result = executeKnownNodeComputation(node, compute);
  } catch (error) {
    recoverWatcherAfterComputationError(node);
    throw error;
  }

  if (node.compute === undefined) {
    node.payload = undefined;
    node.state &= ~WATCHER_TRANSIENT_STATE;
    return;
  }

  const hasCleanup = typeof result === "function";

  if (hasCleanup) {
    node.payload = result;
    node.state |= WatcherCleanupPending;
  }

  if ((node.state & (Visited | Revalidate)) === 0) {
    node.state &= ~Both;
  } else {
    retainAfterExecution(node);
  }

  devRecordWatcherFinish(node, hasCleanup, result, defaultContext);
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.watcher.execute.exit");
}

export function disposeWatcher(node: WatcherNode): void {
  devAssertNoRuntimeHookTopologyMutation();

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.watcher.dispose");

  const cleanup =
    (node.state & WatcherCleanupPending) !== 0
      ? (node.payload as WatcherCleanup)
      : null;

  disposeNode(node);
  node.state &= ~(WATCHER_TRANSIENT_STATE | WatcherCleanupPending);

  if (cleanup !== null) {
    runCleanup(cleanup);
  }

  node.payload = undefined;

  devRecordWatcherDispose(node, cleanup !== null, defaultContext);
}
