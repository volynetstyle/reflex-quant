import {
  DEFAULT_READ_TRACKING_STRATEGY,
  defaultContext,
  readTrackingStrategy,
} from "@runtime/kernel/config";
import { trackingStamp } from "@runtime/kernel/state";
import { devRecordTrackRead } from "@runtime/kernel/dev";
import {
  moveTrackedIncomingEdgeAfterCursorUnchecked,
  moveTrackedIncomingEdgeToFrontUnchecked,
} from "@runtime/kernel/shape/graph/cursorMoves";
import {
  appendTrackedEdgeAfterCursorUnchecked,
  linkEdge,
  linkFirstTrackedEdgeUnchecked,
} from "@runtime/kernel/shape/graph/linkEdge";
import type { ReactiveEdge } from "@runtime/kernel/shape/edge";
import type ReactiveNode from "@runtime/kernel/shape/node";
import { observeRuntimeProjection } from "@runtime/kernel/projection";

import { locateReorderedEdge, locateTrackedEdge } from "./locate";
import { isEdgeInTrackedPrefix } from "./prefix";

/**
 * Commit a read that is not in the tracked prefix and that no locality tier
 * resolved: move the located suffix edge after the cursor, to the head when
 * the prefix is empty (`cursorEdge` null), or link a new edge there.
 *
 * `locatedEdge` is the exact lookup result. It is not the first suffix edge,
 * which the caller compared, so a move is never a no-op. A configured
 * strategy keeps its contract (it is called for exactly these reads, after
 * the prefix test) and repeats its own search.
 */
function reconcileLocatedRead(
  producer: ReactiveNode,
  consumer: ReactiveNode,
  cursorEdge: ReactiveEdge | null,
  suffixStartEdge: ReactiveEdge,
  passStamp: number,
  locatedEdge: ReactiveEdge | null,
): void {
  devRecordTrackRead(defaultContext, consumer, producer);
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.tracking.slow-path");

  if (readTrackingStrategy !== DEFAULT_READ_TRACKING_STRATEGY) {
    consumer.tailIn = readTrackingStrategy(
      producer,
      consumer,
      cursorEdge,
      suffixStartEdge,
      passStamp,
    );
    return;
  }

  if (locatedEdge === null) {
    if (__PROFILE__)
      observeRuntimeProjection?.(
        "projection.semantic.tracking.suffix.link-new",
      );
    consumer.tailIn = linkEdge(producer, consumer, cursorEdge, passStamp);
    return;
  }

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.tracking.edge.move");
  if (cursorEdge === null) {
    moveTrackedIncomingEdgeToFrontUnchecked(consumer, locatedEdge, passStamp);
  } else {
    moveTrackedIncomingEdgeAfterCursorUnchecked(
      consumer,
      cursorEdge,
      locatedEdge,
    );
  }
  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.tracking.suffix.reuse");
}

/**
 * Cold initial-order miss: the first read of a pass did not match the first
 * incoming edge. The common empty-list and first-edge hits stay in
 * resolveTrackedRead so its generated hot path remains small.
 */
function resolveInitialTrackedReadMiss(
  producer: ReactiveNode,
  consumer: ReactiveNode,
  firstIncomingEdge: ReactiveEdge,
): void {
  const passStamp = trackingStamp;

  if (__TRACKING_LAST_EDGE__) {
    const lastIncomingEdge = consumer.lastIn!;

    // Not the first edge, which the caller compared.
    if (lastIncomingEdge.from === producer) {
      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.tracking.initial.last-edge-shortcut",
        );
      moveTrackedIncomingEdgeToFrontUnchecked(
        consumer,
        lastIncomingEdge,
        passStamp,
      );

      devRecordTrackRead(defaultContext, consumer, producer);
      return;
    }
  }

  // The prefix is empty: whatever the lookup finds is in the suffix. The
  // first incoming edge was compared by the caller.
  reconcileLocatedRead(
    producer,
    consumer,
    null,
    firstIncomingEdge,
    passStamp,
    locateTrackedEdge(producer, consumer, null, firstIncomingEdge.nextIn),
  );
}

/**
 * Cursor miss at the physical tail (`cursorEdge.nextIn === null`): append
 * locality and the completed-prefix guard.
 *
 * The suffix is empty, so every edge of the pair is in the prefix (INV-T2):
 * the read is a duplicate exactly when the edge exists, and stamps are not
 * consulted.
 *
 * JIT: kept apart from resolveCursorTrackedReadMiss. TurboFan charges a
 * caller for a callee's bytecode plus everything already inlined into the
 * callee's optimized code, against a 920-byte budget per compilation. As one
 * 300-byte function, both miss kinds were inlined into resolveTrackedRead
 * wherever either was hot, and resolveTrackedRead then no longer fit into
 * runWatcherCore, advanceCore or executeComputation. Split, a call site pulls
 * in only the miss kind that actually occurs there.
 */
function resolveTailTrackedReadMiss(
  producer: ReactiveNode,
  consumer: ReactiveNode,
  cursorEdge: ReactiveEdge,
): void {
  // With the cursor at lastIn, any edge of the pair is in the tracked prefix
  // (INV-T2): the read is a duplicate exactly when the edge exists. The
  // cursor itself was compared by the caller.
  if (locateTrackedEdge(producer, consumer, cursorEdge.prevIn, null) !== null) {
    if (__PROFILE__)
      observeRuntimeProjection?.(
        "projection.semantic.tracking.prefix.duplicate",
      );
    devRecordTrackRead(defaultContext, consumer, producer);
    return;
  }

  appendTrackedEdgeAfterCursorUnchecked(
    producer,
    consumer,
    cursorEdge,
    cursorEdge.stamp,
  );

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.tracking.cursor.append");
  devRecordTrackRead(defaultContext, consumer, producer);
}

/**
 * Cursor miss inside the list: bounded reorder and tail locality, then one
 * exact lookup that both detects a duplicate and finds a reusable edge.
 *
 * Every edge the locality tiers find lies after the expected next edge,
 * which the caller compared: one or two hops past it, or the physical tail.
 * The tail's predecessor is never the cursor, since that would make the
 * tail the expected next edge. All three take the same move.
 */
function resolveCursorTrackedReadMiss(
  producer: ReactiveNode,
  consumer: ReactiveNode,
  cursorEdge: ReactiveEdge,
): void {
  const expectedNextEdge = cursorEdge.nextIn!;
  const lookahead1Edge = expectedNextEdge.nextIn;
  let movedEdge: ReactiveEdge | null = null;

  if (lookahead1Edge !== null) {
    if (__TRACKING_ONE_HOP__ && lookahead1Edge.from === producer) {
      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.tracking.reorder.one-hop",
        );
      movedEdge = lookahead1Edge;
    } else if (__TRACKING_TWO_HOP__) {
      const lookahead2Edge = lookahead1Edge.nextIn;

      if (lookahead2Edge !== null && lookahead2Edge.from === producer) {
        if (__PROFILE__)
          observeRuntimeProjection?.(
            "projection.semantic.tracking.reorder.two-hop",
          );
        movedEdge = lookahead2Edge;
      }
    }
  }

  if (__TRACKING_LAST_EDGE__ && movedEdge === null) {
    const lastIncomingEdge = consumer.lastIn!;

    if (lastIncomingEdge.from === producer) {
      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.tracking.last-edge.shortcut",
        );
      movedEdge = lastIncomingEdge;
    }
  }

  if (movedEdge !== null) {
    moveTrackedIncomingEdgeAfterCursorUnchecked(
      consumer,
      cursorEdge,
      movedEdge,
    );
    devRecordTrackRead(defaultContext, consumer, producer);
    return;
  }

  // Exact lookup. The cursor and the expected next edge were compared by
  // the caller, so the incoming side starts beside them.
  const locatedEdge = locateReorderedEdge(
    producer,
    consumer,
    cursorEdge.prevIn,
    lookahead1Edge,
  );

  // JIT: `=== true` keeps a non-inlined boolean result a single compare
  // (docs/JIT_CONTRACTS.md, canonical-boolean).
  if (
    locatedEdge !== null &&
    isEdgeInTrackedPrefix(consumer, cursorEdge, locatedEdge) === true
  ) {
    if (__PROFILE__)
      observeRuntimeProjection?.(
        "projection.semantic.tracking.prefix.duplicate",
      );
    devRecordTrackRead(defaultContext, consumer, producer);
    return;
  }

  reconcileLocatedRead(
    producer,
    consumer,
    cursorEdge,
    expectedNextEdge,
    cursorEdge.stamp,
    locatedEdge,
  );
}

/**
 * Record a read of `producer` by the tracking consumer `consumer`.
 *
 * The pass stamp is derived, not supplied: a read extending the tracked
 * prefix uses the cursor edge's stamp (nested computation may have advanced
 * the epoch since), and the first read of a pass uses the current epoch.
 *
 * Stable dependency traces stay entirely in this small function. Dynamic
 * append/reorder/duplicate reconciliation is isolated in cold helpers so V8
 * can optimize and inline the dominant sequential path independently.
 *
 * JIT: a miss handler receives only what it cannot derive with one load
 * (the stamp and the expected next edge are read again from the cursor);
 * every argument here costs bytecode that each inlining caller is charged.
 */
export function resolveTrackedRead(
  producer: ReactiveNode,
  consumer: ReactiveNode,
): void {
  {
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.tracking.resolve");
  }

  const cursorEdge = consumer.tailIn;

  if (cursorEdge !== null) {
    const expectedNextEdge = cursorEdge.nextIn;

    // Stable traces overwhelmingly advance to the next existing edge.
    if (expectedNextEdge !== null && expectedNextEdge.from === producer) {
      expectedNextEdge.stamp = cursorEdge.stamp;
      consumer.tailIn = expectedNextEdge;
      {
        if (__PROFILE__)
          observeRuntimeProjection?.("projection.semantic.tracking.next.hit");
        devRecordTrackRead(defaultContext, consumer, producer);
      }
      return;
    }

    // Consecutive duplicate reads remain represented by the current cursor,
    // which already carries this pass's stamp.
    if (cursorEdge.from === producer) {
      {
        if (__PROFILE__)
          observeRuntimeProjection?.("projection.semantic.tracking.cursor.hit");
        devRecordTrackRead(defaultContext, consumer, producer);
      }
      return;
    }

    if (expectedNextEdge === null) {
      /* @__NOINLINE__ */ resolveTailTrackedReadMiss(
        producer,
        consumer,
        cursorEdge,
      );
    } else {
      /* @__NOINLINE__ */ resolveCursorTrackedReadMiss(
        producer,
        consumer,
        cursorEdge,
      );
    }
    return;
  }

  const firstIncomingEdge = consumer.firstIn;

  if (firstIncomingEdge === null) {
    linkFirstTrackedEdgeUnchecked(producer, consumer, trackingStamp);

    {
      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.tracking.initial.create",
        );
      devRecordTrackRead(defaultContext, consumer, producer);
    }
    return;
  }

  if (firstIncomingEdge.from === producer) {
    firstIncomingEdge.stamp = trackingStamp;
    consumer.tailIn = firstIncomingEdge;
    {
      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.tracking.initial.first-hit",
        );
      devRecordTrackRead(defaultContext, consumer, producer);
    }
    return;
  }

  /* @__NOINLINE__ */ resolveInitialTrackedReadMiss(
    producer,
    consumer,
    firstIncomingEdge,
  );
}
