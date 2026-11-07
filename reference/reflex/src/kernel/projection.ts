import type { ProjectionObservation } from "@volynets/algorithm-projection";
import {
  profileRuntimeCounter,
  profileRuntimeCounterBy,
  profileRuntimePullPath,
  profileRuntimeReadConsumerPath,
  profileRuntimePushPath,
  type RuntimeProfileCounterName,
} from "@runtime/profiling";

export const legacyCounterProjection = {
  "projection.semantic.advance.invoke": "advanceCalls",
  "projection.semantic.advance.compute.run": "advanceComputeRuns",
  "projection.semantic.advance.value.changed": "advanceChanged",
  "projection.semantic.advance.value.unchanged": "advanceUnchanged",
  "projection.semantic.advance.cleanup.check": "advanceCleanupChecks",
  "projection.semantic.advance.cleanup.run": "advanceCleanupRuns",
  "projection.semantic.advance.propagate.invoke": "advancePropagateCalls",
  "projection.semantic.advance.propagate.skip-edge":
    "advancePropagateSkippedEdge",
  "projection.semantic.advance.propagate.owned-edge-only-skip":
    "advanceOwnedEdgeOnlySkipped",
  "projection.semantic.pull.invoke": "pullCalls",
  "projection.semantic.pull.edge.visit": "pullEdgesVisited",
  "projection.semantic.pull.dependency.changed": "pullChangedDeps",
  "projection.semantic.pull.dependency.invalid": "pullInvalidDeps",
  "projection.semantic.pull.dependency.clean": "pullCleanDeps",
  "projection.semantic.pull.descend": "pullDescents",
  "projection.semantic.pull.advance.invoke": "pullAdvanceCalls",
  "projection.semantic.pull.sibling.stable-scan": "pullStableSiblingScans",
  "projection.semantic.pull.changed.bubble": "pullChangedBubbles",
  "projection.semantic.pull.stack.trim": "pullStackTrimEvents",
  "projection.semantic.push.invoke": "pushCalls",
  "projection.semantic.push.edge.direct.visit": "pushDirectEdgesVisited",
  "projection.semantic.push.edge.transitive.visit":
    "pushTransitiveEdgesVisited",
  "projection.semantic.push.subscriber.dirty.skip": "pushAlreadyDirtySkipped",
  "projection.semantic.push.subscriber.computing.check": "pushComputingChecked",
  "projection.semantic.push.subscriber.changed.mark": "pushMarkedChanged",
  "projection.semantic.push.subscriber.invalid.mark": "pushMarkedInvalid",
  "projection.semantic.push.watcher.invalidate": "pushWatchersInvalidated",
  "projection.semantic.push.frontier.enqueue": "pushChildBranchesQueued",
  "projection.semantic.push.stack.trim": "pushStackTrimEvents",
  "projection.semantic.push-once.invoke": "pushOnceCalls",
  "projection.semantic.push-once.edge.visit": "pushOnceEdgesVisited",
  "projection.semantic.push-once.subscriber.changed.mark":
    "pushOnceMarkedChanged",
  "projection.semantic.push-once.subscriber.changed.skip":
    "pushOnceAlreadyChangedSkipped",
  "projection.semantic.push-once.edge.explicit-skip": "pushOnceSkippedEdges",
  "projection.semantic.push-once.watcher.scheduled-delivery-skip":
    "pushOnceScheduledWatcherDeliverySkipped",
  "projection.semantic.write.invoke": "writeCalls",
  "projection.semantic.write.value.same": "writeSameValue",
  "projection.semantic.write.value.changed": "writeChanged",
  "projection.semantic.write.subscribers.empty": "writeNoSubscribers",
  "projection.semantic.write.propagation.nested": "writeNestedPropagation",
  "projection.semantic.read.producer.invoke": "readProducerCalls",
  "projection.semantic.read.producer.track": "readProducerTracked",
  "projection.semantic.read.consumer.invoke": "readConsumerCalls",
  "projection.semantic.read.consumer.lazy": "readConsumerLazyCalls",
  "projection.semantic.read.consumer.eager": "readConsumerEagerCalls",
  "projection.semantic.read.consumer.track": "readConsumerTracked",
  "projection.semantic.read.stabilize.force-advance": "stabilizeForceAdvance",
  "projection.semantic.read.stabilize.pull-advance": "stabilizePullAdvance",
  "projection.semantic.context.run": "contextRunCalls",
  "projection.semantic.context.switch": "contextSwitches",
  "projection.semantic.context.propagation.enter": "contextPropagationEnter",
  "projection.semantic.context.propagation.leave": "contextPropagationLeave",
  "projection.semantic.context.propagation.scope-enter":
    "propagationScopesEntered",
  "projection.semantic.context.propagation.scope-leave":
    "propagationScopesLeft",
  "projection.semantic.context.settled.check": "contextSettledChecks",
  "projection.semantic.context.settled.emit": "contextSettledEmits",
  "projection.semantic.context.settled.defer": "contextSettledDeferred",
  "projection.semantic.node.invalidated.emit": "nodeInvalidatedEmits",
  "projection.semantic.watcher.cleanup": "watcherCleanups",
  "projection.semantic.watcher.run": "watcherRunCalls",
  "projection.semantic.watcher.schedule.attempt": "watcherScheduleAttempts",
  "projection.semantic.watcher.schedule.success": "watcherScheduleSuccesses",
  "projection.semantic.watcher.schedule.dedup-skip":
    "watcherScheduleDedupSkipped",
  "projection.semantic.watcher.schedule.release": "watcherScheduleReleases",
  "projection.semantic.watcher.frontier.invoke": "watcherFrontierInvokes",
  "projection.semantic.watcher.frontier.edge.visit":
    "watcherFrontierEdgesVisited",
  "projection.semantic.watcher.frontier.dependency.changed":
    "watcherFrontierChangedDeps",
  "projection.semantic.watcher.frontier.dependency.invalid":
    "watcherFrontierInvalidDeps",
  "projection.semantic.watcher.frontier.dependency.clean":
    "watcherFrontierCleanDeps",
  "projection.semantic.watcher.clean.skip": "watcherCleanSkips",
  "projection.semantic.watcher.stable.skip": "watcherStableSkips",
  "projection.semantic.watcher.disposed.skip": "watcherDisposedSkips",
  "projection.semantic.watcher.execute": "watcherExecutions",
  "projection.semantic.watcher.execute.exit": "watcherExecutionExits",
  "projection.semantic.watcher.cleanup.check": "watcherCleanupChecks",
  "projection.semantic.watcher.dispose": "watcherDisposals",
  "projection.semantic.tracking.resolve": "trackingResolveCalls",
  "projection.semantic.tracking.slow-path": "trackingSlowPath",
  "projection.semantic.tracking.cursor.hit": "trackingCursorHit",
  "projection.semantic.tracking.next.hit": "trackingNextHit",
  "projection.semantic.tracking.cursor.append": "trackingAppendAfterCursor",
  "projection.semantic.tracking.prefix.duplicate": "trackingPrefixDuplicate",
  "projection.semantic.tracking.reorder.one-hop": "trackingOneHopReorder",
  "projection.semantic.tracking.reorder.two-hop": "trackingTwoHopReorder",
  "projection.semantic.tracking.last-edge.shortcut": "trackingLastEdgeShortcut",
  "projection.semantic.tracking.initial.create": "trackingInitialCreate",
  "projection.semantic.tracking.initial.first-hit": "trackingInitialFirstHit",
  "projection.semantic.tracking.initial.last-edge-shortcut":
    "trackingInitialLastEdgeShortcut",
  "projection.semantic.tracking.suffix.head-hit": "trackingSuffixHeadHit",
  "projection.semantic.tracking.suffix.reuse": "trackingSuffixReuseHit",
  "projection.semantic.tracking.suffix.link-new": "trackingSuffixLinkNew",
  "projection.semantic.tracking.edge.move": "trackingEdgeMoved",
  "projection.semantic.tracking.locate.step": "trackingLocateSteps",
  "projection.semantic.cleanup.invoke": "cleanupCalls",
  "projection.semantic.cleanup.skip": "cleanupSkipped",
  "projection.semantic.cleanup.edge.drop": "cleanupEdgesDropped",
  "projection.semantic.compute.context.enter": "computeContextEnters",
  "projection.semantic.compute.context.restore": "computeContextRestores",
} as const satisfies Readonly<
  Record<`projection.semantic.${string}`, RuntimeProfileCounterName>
>;

export type LegacyCounterProjectionId = keyof typeof legacyCounterProjection;

export type RuntimeProjectionObservation = ProjectionObservation<undefined> & {
  readonly id: LegacyCounterProjectionId;
  readonly kind: "semantic";
};

export type RuntimeProjectionCounterAmountId =
  | "projection.semantic.push.stack.trim.excess"
  | "projection.semantic.pull.stack.trim.excess";

export interface RuntimeProjectionPathPayload {
  readonly branch: string;
  readonly depth: number;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly stackDepth: number;
}

let runtimeProjectionObserver:
  | ((observation: ProjectionObservation) => void)
  | undefined;

export function emitRuntimeProjection(
  observation: ProjectionObservation,
): void {
  runtimeProjectionObserver?.(observation);
}

export function setRuntimeProjectionObserver(
  observer: ((observation: ProjectionObservation) => void) | undefined,
): void {
  runtimeProjectionObserver = observer;
}

export const observeRuntimeProjection = __PROFILE__
  ? function observeRuntimeProjection(id: LegacyCounterProjectionId): void {
      const observation = { id, kind: "semantic", payload: undefined } as const;
      emitRuntimeProjection(observation);
      profileRuntimeCounter(legacyCounterProjection[id]);
    }
  : undefined;

export const observeRuntimeProjectionAmount = __PROFILE__
  ? function observeRuntimeProjectionAmount(
      id: RuntimeProjectionCounterAmountId,
      amount: number,
    ): void {
      emitRuntimeProjection({ id, kind: "semantic", payload: undefined });
      profileRuntimeCounterBy(
        id === "projection.semantic.push.stack.trim.excess"
          ? "pushStackTrimExcess"
          : "pullStackTrimExcess",
        amount,
      );
    }
  : undefined;

type RuntimePathObserver = (
  branch: string,
  depth: number,
  fanIn: number,
  fanOut: number,
  stackDepth: number,
) => void;

export const observeRuntimePushPath: RuntimePathObserver | undefined =
  __PROFILE__
    ? function observeRuntimePushPath(
        branch,
        depth,
        fanIn,
        fanOut,
        stackDepth,
      ): void {
        emitRuntimeProjection({
          id: "projection.semantic.push.path",
          kind: "semantic",
          payload: { branch, depth, fanIn, fanOut, stackDepth },
        });
        profileRuntimePushPath(branch, depth, fanIn, fanOut, stackDepth);
      }
    : undefined;

export const observeRuntimePullPath: RuntimePathObserver | undefined =
  __PROFILE__
    ? function observeRuntimePullPath(
        branch,
        depth,
        fanIn,
        fanOut,
        stackDepth,
      ): void {
        emitRuntimeProjection({
          id: "projection.semantic.pull.path",
          kind: "semantic",
          payload: { branch, depth, fanIn, fanOut, stackDepth },
        });
        profileRuntimePullPath(branch, depth, fanIn, fanOut, stackDepth);
      }
    : undefined;

export const observeRuntimeReadConsumerPath = __PROFILE__
  ? function observeRuntimeReadConsumerPath(isDirty: boolean): void {
      emitRuntimeProjection({
        id: isDirty
          ? "projection.semantic.read.consumer.path.dirty"
          : "projection.semantic.read.consumer.path.clean",
        kind: "semantic",
        payload: { isDirty },
      });
      profileRuntimeReadConsumerPath(isDirty);
    }
  : undefined;

export function adaptRuntimeProjection(
  observation: RuntimeProjectionObservation,
): void {
  profileRuntimeCounter(legacyCounterProjection[observation.id]);
}
