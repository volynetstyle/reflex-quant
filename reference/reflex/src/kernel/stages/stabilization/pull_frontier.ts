import {
  Changed,
  Computing,
  Revalidate,
  Unknown,
  Visited,
  type ReactiveEdge,
  type WatcherNode,
} from "@runtime/kernel/shape";

import { advance } from "./advance";
import { should_recompute } from "./pull_dependency";
import { observeRuntimeProjection } from "@runtime/kernel/projection";

/**
 * Validate a watcher's complete committed dependency frontier.
 *
 * Unlike should_recompute(), this operation scans every root dependency: a
 * confirmed change is accumulated and does not stop later root siblings.
 * The root's Changed bit is semantic execution evidence, never traversal
 * control. A validation epoch lets propagation record invalidations that would
 * otherwise be hidden by an already-set Unknown bit.
 *
 * Preconditions:
 * - root has Unknown;
 * - root is not Computing.
 *
 * During validation, Computing marks an active consumer epoch and tailIn spans
 * the complete committed frontier. Reentrant invalidation is therefore
 * recorded by the existing push protocol as Visited | Unknown.
 *
 * On success, this function returns whether it confirmed a dependency change.
 * It does not discharge root.Unknown and preserves epoch-local Visited.
 * On failure it additionally commits any already-confirmed Changed evidence.
 * It always restores Computing and the previous incoming cursor. Orthogonal
 * state such as Scheduled remains owned by the scheduler boundary.
 *
 * Best case: O(D), with every dependency clean.
 * Typical: O(D + dirty slice).
 * With memoized stabilization: O(D + Vu + Eu).
 * Without that invariant, the strict bound is
 * O(D + sum(traversal(dependency))).
 */
export function pull_frontier(
  root: WatcherNode,
  firstEdge: ReactiveEdge | null,
): boolean {
  const initialState = root.state;
  const previousTail = root.tailIn;

  // Visited on entry belongs to the preceding watcher execution epoch. Turn
  // it into durable execution evidence before reusing Visited as this
  // validation epoch's invalidation marker. Computing plus the committed tail
  // deliberately reuses push's existing rare reentrant-subscriber path, so
  // validation adds no branch to propagation hot paths.
  // Revalidate on entry is discharged by this pass itself; only a reentrant
  // invalidation recorded during this epoch may request another one.
  root.tailIn = root.lastIn;
  root.state =
    (initialState & ~(Visited | Revalidate)) |
    Computing |
    ((initialState & Visited) !== 0 ? Changed : 0);

  let changed = false;

  try {
    // Fused exhaustive specialization of pull_dependency(). Keeping the three
    // shallow states in this loop avoids a call per clean wide dependency; the
    // shared stack machine is entered only for an Unknown dependency subtree.
    for (let edge = firstEdge; edge !== null; edge = edge.nextIn) {
      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.watcher.frontier.edge.visit",
        );

      const dependency = edge.from;
      const state = dependency.state;
      {
        if (__DEV__ && (state & Computing) !== 0) {
          throw new Error("Cycle detected while refreshing reactive graph");
        }
      }

      if ((state & Changed) !== 0) {
        if (__PROFILE__)
          observeRuntimeProjection?.(
            "projection.semantic.watcher.frontier.dependency.changed",
          );
        if (advance(dependency, edge) === true) changed = true;
        continue;
      }

      if ((state & Unknown) === 0) {
        if (__PROFILE__)
          observeRuntimeProjection?.(
            "projection.semantic.watcher.frontier.dependency.clean",
          );
        continue;
      }

      if (__PROFILE__)
        observeRuntimeProjection?.(
          "projection.semantic.watcher.frontier.dependency.invalid",
        );

      const dependencyEdge = dependency.firstIn;
      if (
        dependencyEdge === null ||
        should_recompute(dependency, dependencyEdge) === true
      ) {
        if (advance(dependency, edge) === true) {
          changed = true;
        }
      }
    }

    return changed;
  } catch (error) {
    // Earlier dependencies may already have committed new values.
    // Preserve that monotonic evidence across the failed validation.
    if (changed) root.state |= Changed;
    throw error;
  } finally {
    root.state &= ~Computing;

    if (root.compute !== undefined) {
      root.tailIn = previousTail;
    }
  }
}
