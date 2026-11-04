import { defaultContext } from "@runtime/kernel/config";
import {
  enterConsumerTracking,
  restoreConsumerTracking,
} from "@runtime/kernel/state";
import {
  devAssertExecutableNode,
  devRecordComputeError,
  devRecordComputeFinish,
  devRecordComputeStart,
} from "@runtime/kernel/dev";
import {
  enterRuntimePhase,
  leaveRuntimePhase,
  RuntimePhase,
} from "@runtime/kernel/execution";
import {
  Computing,
  Visited,
  type ComputeFn,
  type ReactiveNode,
} from "@runtime/kernel/shape";
import { cleanupUnvisitedSources } from "@runtime/kernel/stages/tracking";
import { observeRuntimeProjection } from "@runtime/kernel/projection";

export const executeKnownNodeComputation = !__DEV__
  ? executeComputation
  : function <T>(node: ReactiveNode<T>, compute: ComputeFn<T>): T {
      enterRuntimePhase(RuntimePhase.Recomputing);
      try {
        return executeComputation(node, compute);
      } finally {
        leaveRuntimePhase();
      }
    };

function executeComputation<T>(
  node: ReactiveNode<T>,
  compute: ComputeFn<T>,
): T {
  node.tailIn = null;
  node.state = (node.state & ~Visited) | Computing;
  const prevActive = enterConsumerTracking(node);
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.compute.context.enter");

  devRecordComputeStart(node, defaultContext);

  let result: T;

  try {
    result = compute!();
  } catch (error) {
    restoreConsumerTracking(prevActive);
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.compute.context.restore");
    node.state &= ~Computing;

    devRecordComputeError(node, error, defaultContext);

    throw error;
  }

  restoreConsumerTracking(prevActive);
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.compute.context.restore");
  node.state &= ~Computing;

  if (node.tailIn !== node.lastIn) {
    cleanupUnvisitedSources(node);
  }

  // const reductionEnabled =
  //   graphReductionPolicy.enabled || (node.state & GraphReductionEnabled) !== 0;

  // if (reductionEnabled) {
  //   observeGraphReductionRun(node, graphReductionPolicy, reductionEnabled);
  // }

  devRecordComputeFinish(node, result, defaultContext);

  return result;
}

export function executeNodeComputation<T>(node: ReactiveNode<T>): T {
  devAssertExecutableNode(node);

  return executeKnownNodeComputation(node, node.compute);
}
