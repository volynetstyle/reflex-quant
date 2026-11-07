import type { ProjectionObservation } from "@volynets/algorithm-projection";
import type { RuntimeDebugContext } from "@runtime/kernel/config";
import { devRecordPropagate } from "@runtime/kernel/dev";
import type { ReactiveEdge } from "@runtime/kernel/shape";
import { emitRuntimeProjection } from "@runtime/kernel/projection";

export interface PropagateProjectionPayload {
  readonly edge: ReactiveEdge;
  readonly nextState: number;
  readonly immediate: boolean;
  readonly context: RuntimeDebugContext;
}

export type PropagateProjectionObservation =
  ProjectionObservation<PropagateProjectionPayload> & {
    readonly id: "projection.semantic.propagation.edge.marked";
    readonly kind: "semantic";
  };

export const observeRuntimePropagate = __DEV__
  ? function observeRuntimePropagate(
      payload: PropagateProjectionPayload,
    ): void {
      emitRuntimeProjection({
        id: "projection.semantic.propagation.edge.marked",
        kind: "semantic",
        payload,
      });
      devRecordPropagate(
        payload.edge,
        payload.nextState,
        payload.immediate,
        payload.context,
      );
    }
  : undefined;
