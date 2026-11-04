import {
  defaultContext,
  emitNodeInvalidated,
  nodeInvalidatedHook,
} from "@runtime/kernel/config";
import {
  enterRuntimePhase,
  leaveRuntimePhase,
  RuntimePhase,
} from "@runtime/kernel/execution";
import {
  Changed,
  Computing,
  Scheduled,
  Unknown,
  Watcher,
  type ReactiveEdge,
} from "@runtime/kernel/shape";
import { observeRuntimeProjection } from "@runtime/kernel/projection";
import { observeRuntimePropagate } from "@runtime/kernel/projection.propagate";

/**
 * One-step propagation after a recompute changed a value: every direct
 * subscriber without `Changed` gains it (computeds drop `Unknown`, watchers
 * keep it). `skip` is the edge owned by the active pull walker, whose target
 * learns the result from the walker itself; `null` skips nothing, and an
 * edge outside this list skips nothing either.
 */
function pushIteratorOnceCore(
  edge: ReactiveEdge | null,
  skip: ReactiveEdge | null,
): void {
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.push-once.invoke");

  for (let current = edge; current !== null; current = current.nextOut) {
    if (current === skip) {
      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.push-once.edge.explicit-skip",
        );
      continue;
    }

    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.push-once.edge.visit");

    const sub = current.to;
    const state = sub.state;

    if ((state & Changed) === 0) {
      sub.state =
        (state & Watcher) !== 0
          ? state | Changed
          : (state & ~Unknown) | Changed;

      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.push-once.subscriber.changed.mark",
        );
      if (__DEV__)
        observeRuntimePropagate?.({
          edge: current,
          nextState: sub.state,
          immediate: true,
          context: defaultContext,
        });

      if ((state & Watcher) !== 0 && nodeInvalidatedHook !== undefined) {
        // Scheduled and Computing are ownership certificates: the host queue
        // must already execute this watcher, or its own run is active. A
        // running watcher keeps Changed, so Computing reaches here only in
        // the validation epoch, after the host released Scheduled; that pass
        // consumes the Changed evidence (F17). Preserve the stronger Changed
        // evidence above, but do not redeliver the same obligation.
        if ((state & (Scheduled | Computing)) !== 0) {
          if (__PROFILE__)
            observeRuntimeProjection?.(
              "projection.semantic.push-once.watcher.scheduled-delivery-skip",
            );
          continue;
        }

        if (__DEV__) emitNodeInvalidated(sub);

        if (!__DEV__) nodeInvalidatedHook!(sub);
      }
    } else {
      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.push-once.subscriber.changed.skip",
        );
    }
  }
}

export const push_iterator_once: (
  edge: ReactiveEdge | null,
  skip?: ReactiveEdge | null,
) => void = __DEV__
  ? function pushIteratorOnceDev(edge, skip = null): void {
      enterRuntimePhase(RuntimePhase.Propagating);

      try {
        pushIteratorOnceCore(edge, skip);
      } finally {
        leaveRuntimePhase();
      }
    }
  : (pushIteratorOnceCore as (
      edge: ReactiveEdge | null,
      skip?: ReactiveEdge | null,
    ) => void);

/** Same walk with a mandatory owned edge; kept for the internal API. */
export const push_iterator_once_skipping: (
  edge: ReactiveEdge | null,
  skip: ReactiveEdge,
) => void = push_iterator_once;
