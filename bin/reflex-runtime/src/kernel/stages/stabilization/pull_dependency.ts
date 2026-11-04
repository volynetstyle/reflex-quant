import { devAssertRefreshEdge } from "@runtime/kernel/dev";
import {
  enterRuntimePhase,
  leaveRuntimePhase,
  RuntimePhase,
} from "@runtime/kernel/execution";
import { observeRuntimeProjection } from "@runtime/kernel/projection";
import {
  Both,
  Changed,
  Computing,
  Unknown,
  type ReactiveEdge,
  type ReactiveNode,
} from "@runtime/kernel/shape";

import { advance } from "./advance";
import { pull_iterator } from "./pull_iterator";
import { profilePullNode } from "../profile";

/**
 * Stabilize a dirty dependency using caller-observed state.
 *
 * May run user code; return is a reentrancy barrier.
 */
function pullDependencyDirty(
  edge: ReactiveEdge,
  dependency: ReactiveNode,
  state: number,
): boolean {
  const changed = state & Changed;

  if (changed === 0) {
    const firstIn = dependency.firstIn;

    if (firstIn !== null) {
      if (__PROFILE__) {
        observeRuntimeProjection?.(
          "projection.semantic.pull.dependency.invalid",
        );
        observeRuntimeProjection?.("projection.semantic.pull.descend");
        profilePullNode("dep.unknown.descend", dependency, 1, 0);
      }

      return pull_iterator(edge, dependency, firstIn);
    }
  }

  if (__PROFILE__) {
    observeRuntimeProjection?.(
      changed !== 0
        ? "projection.semantic.pull.dependency.changed"
        : "projection.semantic.pull.dependency.invalid",
    );
    observeRuntimeProjection?.("projection.semantic.pull.advance.invoke");
    profilePullNode(
      changed !== 0 ? "dep.changed.advance" : "dep.unknown.leaf.advance",
      dependency,
      1,
      0,
    );
  }

  if (__DEV__) devAssertRefreshEdge(dependency, edge);

  // JIT: `=== true` pins the return type to boolean without a ToBoolean.
  return advance(dependency, edge) === true;
}

/** Stabilize one causal dependency branch and return its edge-local proof. */
function pullDependencyCore(edge: ReactiveEdge): boolean {
  if (__PROFILE__) {
    observeRuntimeProjection?.("projection.semantic.pull.edge.visit");
  }

  const dependency = edge.from;
  const state = dependency.state;

  if (__DEV__ && (state & Computing) !== 0) {
    throw new Error("Cycle detected while refreshing reactive graph");
  }

  if ((state & Both) === 0) {
    if (__PROFILE__) {
      observeRuntimeProjection?.("projection.semantic.pull.dependency.clean");
      profilePullNode("dep.clean", dependency, 1, 0);
    }
    return false;
  }

  // JIT: boolean return, as above.
  return pullDependencyDirty(edge, dependency, state) === true;
}

/**
 * Short-circuit consumer policy over dependency proofs.
 * Root Changed is execution evidence; a fully stable frontier discharges
 * root Unknown. Neither responsibility belongs to pullDependencyDirty().
 *
 * Policy:
 * - root Changed -> true
 * - clean dependency -> next sibling
 * - Changed dependency -> advance
 * - Unknown leaf -> advance
 * - Unknown branch -> pull_iterator
 *
 * After dirty dependency stabilization, root state is read again because user
 * code may have supplied reentrant evidence.
 */
function shouldRecomputeCore(node: ReactiveNode, edge: ReactiveEdge): boolean {
  if (__PROFILE__) {
    observeRuntimeProjection?.("projection.semantic.pull.invoke");
  }

  if ((node.state & Changed) !== 0) return true;

  while (true) {
    if (__PROFILE__) {
      observeRuntimeProjection?.("projection.semantic.pull.edge.visit");
    }

    const dependency = edge.from;
    const state = dependency.state;

    if (__DEV__ && (state & Computing) !== 0) {
      throw new Error("Cycle detected while refreshing reactive graph");
    }

    if ((state & Both) === 0) {
      if (__PROFILE__) {
        observeRuntimeProjection?.("projection.semantic.pull.dependency.clean");
        profilePullNode("dep.clean", dependency, 1, 0);
      }
    } else {
      if (pullDependencyDirty(edge, dependency, state) === true) return true;

      // Dirty proof may run user code. Observe reentrant root evidence even
      // when the current edge became the final edge during that call.
      if ((node.state & Changed) !== 0) return true;
    }

    const sibling = edge.nextIn;
    if (sibling === null) {
      node.state &= ~Unknown;
      return false;
    }

    if (__PROFILE__) {
      observeRuntimeProjection?.(
        "projection.semantic.pull.sibling.stable-scan",
      );
      profilePullNode("sibling.stable", sibling.from, 1, 0);
    }
    edge = sibling;
  }
}

export const should_recompute: (
  node: ReactiveNode,
  edge: ReactiveEdge,
) => boolean = __DEV__
  ? function shouldRecomputeDev(node, edge): boolean {
      enterRuntimePhase(RuntimePhase.Pulling);

      try {
        return shouldRecomputeCore(node, edge);
      } finally {
        leaveRuntimePhase();
      }
    }
  : shouldRecomputeCore;

export const pull_dependency: (edge: ReactiveEdge) => boolean = __DEV__
  ? function pullDependencyDev(edge): boolean {
      enterRuntimePhase(RuntimePhase.Pulling);

      try {
        return pullDependencyCore(edge);
      } finally {
        leaveRuntimePhase();
      }
    }
  : pullDependencyCore;
