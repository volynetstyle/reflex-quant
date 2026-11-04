import { defaultContext } from "@runtime/kernel/config";
import { flushPendingRuntimeIdle } from "@runtime/kernel/batch";
import {
  currentConsumer,
  RuntimeState,
  runtimeState,
} from "@runtime/kernel/state";
import {
  devAssertConsumerCanStabilize,
  devRecordReadConsumer,
} from "@runtime/kernel/dev";
import { devAssertNoRuntimeHookReactiveRead } from "@runtime/kernel/execution";
import {
  Changed,
  Both,
  Computing,
  Unknown,
  Visited,
  type ConsumerNode,
  type ReactiveEdge,
} from "@runtime/kernel/shape";
import { resolveTrackedRead } from "@runtime/kernel/stages/tracking";
import { advance } from "@runtime/kernel/stages/stabilization/advance";
import { should_recompute } from "@runtime/kernel/stages/stabilization/pull_dependency";
import {
  observeRuntimeProjection,
  observeRuntimeReadConsumerPath,
} from "@runtime/kernel/projection";

import { LAZY, type ConsumerReadModeValue } from "./utils/constants";

// Consumer reads. Observable behavior: docs/RUNTIME.md, "Computed consumers
// and reads". Both modes stabilize a dirty node before its payload is
// observed; a lazy read then records the edge into the active computation.

/**
 * Lazy read: stabilize, then record the dependency in the active computation.
 * Called with the node as `this`, so a facade binds it once per node.
 */
export function readConsumerLazy<T>(this: ConsumerNode<T>): T {
  devAssertNoRuntimeHookReactiveRead();

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.read.consumer.invoke");
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.read.consumer.lazy");

  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const node = this;
  const state = node.state;

  if (__PROFILE__) observeRuntimeReadConsumerPath?.((state & Both) !== 0);

  if ((state & Both) !== 0) stabilizeDirtyConsumer(node, state);

  // Tracking never changes the payload. The local keeps the DEV record's
  // argument a plain name, which the production build erases with the call.
  const consumer = currentConsumer;
  const payload = node.payload;

  if (consumer !== null) {
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.read.consumer.track");
    resolveTrackedRead(node, consumer);
  }

  devRecordReadConsumer(node, "lazy", payload, defaultContext, consumer);

  return payload;
}

/** Eager read: stabilize without recording a dependency. */
export function readConsumerEager<T>(node: ConsumerNode<T>): T {
  devAssertNoRuntimeHookReactiveRead();

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.read.consumer.invoke");
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.read.consumer.eager");

  const state = node.state;

  if (__PROFILE__) observeRuntimeReadConsumerPath?.((state & Both) !== 0);

  if ((state & Both) !== 0) stabilizeDirtyConsumer(node, state);

  const payload = node.payload;

  devRecordReadConsumer(node, "eager", payload, defaultContext);

  return payload;
}

/**
 * Read in the given mode; lazy by default.
 *
 * The lazy body repeats `readConsumerLazy` instead of calling it: the
 * benchmarks read through this function, and a call level here moves
 * TurboFan's inlining boundaries in every caller that reads a computed.
 */
export function readConsumer<T>(
  node: ConsumerNode<T>,
  mode: ConsumerReadModeValue = LAZY,
): T {
  if (mode !== LAZY) return readConsumerEager(node);

  devAssertNoRuntimeHookReactiveRead();

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.read.consumer.invoke");
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.read.consumer.lazy");

  const state = node.state;

  if (__PROFILE__) observeRuntimeReadConsumerPath?.((state & Both) !== 0);

  if ((state & Both) !== 0) stabilizeDirtyConsumer(node, state);

  const consumer = currentConsumer;
  const payload = node.payload;

  if (consumer !== null) {
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.read.consumer.track");
    resolveTrackedRead(node, consumer);
  }

  devRecordReadConsumer(node, "lazy", payload, defaultContext, consumer);

  return payload;
}

/** A computed never rests with `Visited` (I3): for valid states, `Changed`. */
const FORCE_RECOMPUTE_STATE = Changed | Visited;

/**
 * Bring a dirty consumer up to date.
 *
 * `Changed` is execution evidence: recompute. `Unknown` alone is validated
 * first and recomputed only when a dependency changed; a fully stable
 * validation clears `Unknown` itself, and a recompute leaves a resolved state
 * on either result. An `Unknown` consumer without inputs has nothing to
 * validate and is clean as a root (F9).
 */
function stabilizeDirtyConsumer<T>(node: ConsumerNode<T>, state: number): void {
  devAssertConsumerCanStabilize(state);

  if ((state & FORCE_RECOMPUTE_STATE) !== 0) {
    if (__PROFILE__)
      observeRuntimeProjection?.(
        "projection.semantic.read.stabilize.force-advance",
      );
    advance(node, ownedParentEdgeForStableRead(node));
  } else {
    const edge = node.firstIn;
    if (__PROFILE__)
      observeRuntimeProjection?.(
        "projection.semantic.read.stabilize.pull-advance",
      );

    if (edge === null) {
      node.state &= ~Unknown;
    } else if (should_recompute(node, edge) === true) {
      advance(node, null);
    }
  }

  if ((runtimeState & RuntimeState.IdlePending) !== RuntimeState.Idle) {
    flushPendingRuntimeIdle();
  }
}

/**
 * The edge `producer -> currentConsumer` when it is exactly the next read of
 * the active tracking pass; otherwise null.
 *
 * `advance` receives it as the owned edge: the reader learns the new value
 * from this read, so the one-step push skips its edge. The proof only looks.
 * The cursor moves and the dependency commits in `resolveTrackedRead`, after
 * stabilization succeeds; append, reorder and duplicate reads fall back to
 * the full push. `Computing` is what makes `tailIn` the tracking frontier
 * (INV-H); outside it the slot may hold a producer hint.
 */
function ownedParentEdgeForStableRead(
  producer: ConsumerNode<unknown>,
): ReactiveEdge | null {
  const consumer = currentConsumer;

  if (
    consumer === null ||
    consumer === producer ||
    (consumer.state & Computing) === 0
  ) {
    return null;
  }

  const cursor = consumer.tailIn;
  const candidate = cursor === null ? consumer.firstIn : cursor.nextIn;

  return candidate !== null && candidate.from === producer ? candidate : null;
}
