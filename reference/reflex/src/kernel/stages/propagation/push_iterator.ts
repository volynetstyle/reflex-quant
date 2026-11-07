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
  Both,
  Unknown,
  Visited,
  Watcher,
  Revalidate,
  type ReactiveEdge,
  type ReactiveNode,
} from "@runtime/kernel/shape";
import {
  noteResumeEdgeStackUsage,
  readRuntimeWalkerStackStats,
} from "@runtime/kernel/stages/stackStats";
import {
  observeRuntimeProjection,
  observeRuntimeProjectionAmount,
} from "@runtime/kernel/projection";
import { isEdgeInTrackedPrefix } from "@runtime/kernel/stages/tracking/prefix";
import { profilePushNode } from "@runtime/kernel/stages/profile";
import { observeRuntimePropagate } from "@runtime/kernel/projection.propagate";

// JIT: a full-range fill() leaves the backing store PACKED_ELEMENTS (checked
// with %HasHoleyElements on Node 24.22 and 25.2); `new Array(512)` alone is
// HOLEY and every stack load would carry a hole check. Keep the fill. Pushes
// only append at `top <= length` and pops clear with null, so the stack never
// becomes holey later.
const propagateStack: ReactiveEdge[] = new Array(512).fill(null);
const MAX_RETAINED_PROPAGATE_STACK = 512;
const propagateDepthStack: number[] | undefined = __PROFILE__
  ? new Array(512).fill(0)
  : undefined;
// JIT: holds only Int32 stack indices. Never store a non-Smi value here; the
// `| 0` at the read site in pushIteratorCore relies on it staying small.
let propagateStackHigh = 0;

/**
 * Rare scheduler dispatch for an invalidated watcher, shared by both phases.
 * The try/catch lives here, so pushIteratorCore's bytecode has no handler
 * table and the Ignition, Sparkplug and Maglev tiers see a smaller CFG; the
 * extra frame is paid only next to an external hook call. TurboFan inlines
 * this into pushIteratorCore on watcher workloads, so its optimized code
 * keeps the region (Node 24.22, --trace-turbo-inlining).
 */
function dispatchWatcherInvalidation(
  sub: ReactiveNode<unknown>,
  base: number,
  top: number,
): void {
  propagateStackHigh = top;

  try {
    if (__DEV__) emitNodeInvalidated(sub);
    else nodeInvalidatedHook!(sub);
  } catch (error) {
    while (top !== base) propagateStack[--top] = null!;
    propagateStackHigh = base;
    throw error;
  }
}

/**
 * Rare re-entrant tracking path: a computing subscriber is marked only when
 * the changed edge is in its tracked prefix, a dependency it has already read
 * in this pass (or, during watcher validation, any committed dependency). The
 * prefix test is O(1) through the pass stamp (isEdgeInTrackedPrefix). Keeping
 * it out of the common clean/already-dirty loops leaves Maglev and TurboFan
 * with a much smaller hot control-flow graph.
 *
 * JIT: both exits return a Smi (0 or the new state), never null or a boolean,
 * so `next` at the call sites stays a Word32 phi.
 */
function markComputingSubscriber(
  edge: ReactiveEdge,
  sub: ReactiveNode<unknown>,
  state: number,
): number {
  if (__PROFILE__)
    observeRuntimeProjection?.(
      "projection.semantic.push.subscriber.computing.check",
    );

  const tail = sub.tailIn;
  if (tail === null) return 0;

  // JIT: the prefix call returns a primitive boolean, compared strictly with
  // `true`; the representation of that comparison is engine-specific.
  if (edge !== tail && isEdgeInTrackedPrefix(sub, tail, edge) !== true) {
    return 0;
  }

  return (sub.state = state | Visited | Unknown);
}

/**
 * Push invalidation iterator:
 * - direct subscribers get Changed
 * - transitive subscribers get Unknown
 */
function pushIteratorCore(firstOut: ReactiveEdge | null): void {
  // if (firstOut === null) return;

  if (__PROFILE__)
    observeRuntimeProjection?.("projection.semantic.push.invoke");

  const stack = propagateStack;
  // [ outer live stack ][ nested live stack ][ free capacity ]
  // 0                  base                top
  //
  // JIT: keep the captured stack base Int32 for index and range analysis.
  // `| 0` is not a correctness guard (the value is already an integer); it is
  // the type feedback that lets V8 treat `base` and `top` as Word32 and drop
  // Smi checks on push and pop. Removing it regresses the generated code:
  // pushIteratorCore grows from 267 to 303 TurboFan instructions with two more
  // Smi checks on B.chain, and from 120 to 157 on B.fanout (Node 24.22,
  // perf/v8-shape/analyze.mjs).
  const base = propagateStackHigh | 0;
  // JIT: source provenance and writes are checked; range and lowering are not.
  // @jit int32-provenance(base)
  let top = base;

  /**
   * Phase 1:
   * Direct outgoing edges.
   *
   * No DFS here. Children are only pushed to stack.
   */
  for (
    let edge: ReactiveEdge | null = firstOut;
    edge !== null;
    edge = edge.nextOut
  ) {
    if (__PROFILE__)
      observeRuntimeProjection?.("projection.semantic.push.edge.direct.visit");

    const sub: ReactiveNode<unknown> = edge.to;
    const state = sub.state;

    // JIT: seeded with the Smi 0 and assigned only Int32 bit expressions, so
    // the phi is Word32. Use 0 for "skip", never null or undefined.
    let next = 0;

    if ((state & (Both | Computing)) === 0) {
      next = (state & ~Visited) | Changed;
      sub.state = next;
    } else if ((state & Unknown) !== 0 && (state & Watcher) === 0) {
      next = (state & ~(Unknown | Visited)) | Changed;
      sub.state = next;
    } else if ((state & Computing) !== 0) {
      next = markComputingSubscriber(edge, sub, state);
    } else if ((state & Unknown) !== 0) {
      // Cold merge: an already scheduled watcher learned that one of its
      // direct dependencies definitely changed.
      next = (state & ~Visited) | Changed;
      sub.state = next;
    }

    if (next === 0) {
      if (__PROFILE__) {
        if (__PROFILE__)
          observeRuntimeProjection?.(
            "projection.semantic.push.subscriber.dirty.skip",
          );
        profilePushNode("direct.skip", sub, 1, top - base);
      }
      continue;
    }

    if (__PROFILE__) {
      if (__PROFILE__)
        observeRuntimeProjection?.(
          (next & Changed) !== 0
            ? "projection.semantic.push.subscriber.changed.mark"
            : "projection.semantic.push.subscriber.invalid.mark",
        );
      profilePushNode(
        (next & Changed) !== 0 ? "direct.changed" : "direct.unknown",
        sub,
        1,
        top - base,
      );
    }
    if (__DEV__)
      observeRuntimePropagate?.({
        edge: edge,
        nextState: next,
        immediate: true,
        context: defaultContext,
      });

    if ((next & Watcher) !== 0) {
      if (__PROFILE__) {
        if (__PROFILE__)
          observeRuntimeProjection?.(
            "projection.semantic.push.watcher.invalidate",
          );
        profilePushNode("direct.watcher", sub, 1, top - base);
      }

      // A watcher that was already transitively Unknown still needs promotion
      // to Changed when a direct dependency changes. It is already owned by
      // the scheduler, though, so do not emit a duplicate invalidation.
      if ((state & (Unknown | Computing)) === Unknown) continue;

      // Direct watchers always cut off descent. Production can omit the
      // no-op emitter when no hook is installed; development retains events.
      if (__DEV__ || nodeInvalidatedHook !== undefined)
        dispatchWatcherInvalidation(sub, base, top);
      continue;
    }

    const child = sub.firstOut;
    if (child !== null) {
      if (__PROFILE__)
        observeRuntimeProjection?.("projection.semantic.push.frontier.enqueue");

      if (__PROFILE__) propagateDepthStack![top] = 2;
      stack[top++] = child;
      if (__DEV__) noteResumeEdgeStackUsage(top);
    }
  }

  /**
   * Phase 2:
   * Transitive DFS.
   *
   * Everything below direct level gets Unknown.
   */
  while (top !== base) {
    let edge: ReactiveEdge | null = stack[--top]!;
    // JIT: clear with null, never `delete` or shrink `length` mid-walk; a hole
    // would turn the backing store HOLEY for the rest of the process.
    stack[top] = null!;
    let depth = __PROFILE__ ? propagateDepthStack![top]! : 0;

    while (edge !== null) {
      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.push.edge.transitive.visit",
        );

      const sub: ReactiveNode<unknown> = edge.to;
      const state = sub.state;

      // JIT: Word32 phi, as in phase 1.
      let next = 0;

      if ((state & (Both | Computing)) === 0) {
        next = (state & ~Visited) | Unknown;
        sub.state = next;
      } else if ((state & Computing) !== 0) {
        next = markComputingSubscriber(edge, sub, state);
        // Transitive evidence proves only that a running watcher's validation
        // may be stale. Record Revalidate instead of the Visited execution marker.
        if (next !== 0 && (state & Watcher) !== 0)
          next = sub.state = state | Unknown | Revalidate;
      } else if ((state & (Watcher | Unknown)) === Watcher) {
        // Watcher evidence is a pair of independent obligations. A direct
        // Changed already delivered the execution obligation, but it does not
        // prove that the rest of the committed frontier is valid. Preserve it
        // while adding the transitive validation obligation.
        next = (state & ~Visited) | Unknown;
        sub.state = next;
      }

      const sibling: ReactiveEdge | null = edge.nextOut;

      if (next !== 0) {
        if (__PROFILE__) {
          if (__PROFILE__)
            observeRuntimeProjection?.(
              "projection.semantic.push.subscriber.invalid.mark",
            );
          profilePushNode("transitive.unknown", sub, depth, top - base);
        }
        if (__DEV__)
          observeRuntimePropagate?.({
            edge: edge,
            nextState: next,
            immediate: false,
            context: defaultContext,
          });

        // Every non-zero `next` above inherits the Watcher bit from `state`,
        // so `(next & Watcher) !== 0 && (state & Both) === 0` is one mask and
        // compare on `state`.
        if (
          (state & (Watcher | Both)) === Watcher &&
          nodeInvalidatedHook !== undefined
        ) {
          if (__PROFILE__) {
            if (__PROFILE__)
              observeRuntimeProjection?.(
                "projection.semantic.push.watcher.invalidate",
              );
            profilePushNode("transitive.watcher", sub, depth, top - base);
          }

          dispatchWatcherInvalidation(sub, base, top);
        } else {
          const child = sub.firstOut;

          if (child !== null) {
            if (sibling !== null) {
              if (__PROFILE__)
                observeRuntimeProjection?.(
                  "projection.semantic.push.frontier.enqueue",
                );

              if (__PROFILE__) propagateDepthStack![top] = depth;
              stack[top++] = sibling;
              if (__DEV__) noteResumeEdgeStackUsage(top);
            }

            edge = child;
            if (__PROFILE__) depth += 1;
            continue;
          }
        }
      } else {
        if (__PROFILE__) {
          if (__PROFILE__)
            observeRuntimeProjection?.(
              "projection.semantic.push.subscriber.dirty.skip",
            );
          profilePushNode("transitive.skip", sub, depth, top - base);
        }
      }

      edge = sibling;
    }
  }

  propagateStackHigh = base;
  if (base === 0 && stack.length > MAX_RETAINED_PROPAGATE_STACK) {
    if (__PROFILE__) {
      if (__PROFILE__)
        observeRuntimeProjection?.("projection.semantic.push.stack.trim");
      if (__PROFILE__)
        observeRuntimeProjectionAmount?.(
          "projection.semantic.push.stack.trim.excess",
          stack.length - MAX_RETAINED_PROPAGATE_STACK,
        );
    }
    stack.length = MAX_RETAINED_PROPAGATE_STACK;
  }
}

export const push_iterator: (firstOut: ReactiveEdge | null) => void = __DEV__
  ? function pushIteratorDev(firstOut): void {
      enterRuntimePhase(RuntimePhase.Propagating);

      try {
        pushIteratorCore(firstOut);
      } finally {
        leaveRuntimePhase();
      }
    }
  : pushIteratorCore;

// A re-export, not `const propagate = push_iterator`: no second module binding.
export { push_iterator as propagate };

export function readPropagateStackStats(): {
  shouldRecompute: { current: number; peak: number; capacity: number };
  propagate: { current: number; peak: number; capacity: number };
} {
  return readRuntimeWalkerStackStats(
    0,
    0,
    propagateStackHigh,
    propagateStack.length,
  );
}
