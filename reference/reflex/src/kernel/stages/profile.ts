import type { ReactiveEdge, ReactiveNode } from "@runtime/kernel/shape";
import {
  observeRuntimePullPath,
  observeRuntimePushPath,
} from "@runtime/kernel/projection";
import { isRuntimeProfilingEnabled } from "@runtime/profiling";

// PROFILE-only path observation shared by the propagation and validation
// walkers. Every call site is guarded by `__PROFILE__`, so production builds
// contain none of this.

function countIn(edge: ReactiveEdge | null): number {
  let count = 0;

  for (let current = edge; current !== null; current = current.nextIn) {
    count += 1;
  }

  return count;
}

function countOut(edge: ReactiveEdge | null): number {
  let count = 0;

  for (let current = edge; current !== null; current = current.nextOut) {
    count += 1;
  }

  return count;
}

export function profilePushNode(
  branch: string,
  sub: ReactiveNode<unknown>,
  depth: number,
  stackDepth: number,
): void {
  if (__PROFILE__ && isRuntimeProfilingEnabled()) {
    observeRuntimePushPath?.(
      branch,
      depth,
      countIn(sub.firstIn),
      countOut(sub.firstOut),
      stackDepth,
    );
  }
}

export function profilePullNode(
  branch: string,
  node: ReactiveNode<unknown>,
  depth: number,
  stackDepth: number,
): void {
  if (__PROFILE__ && isRuntimeProfilingEnabled()) {
    observeRuntimePullPath?.(
      branch,
      depth,
      countIn(node.firstIn),
      countOut(node.firstOut),
      stackDepth,
    );
  }
}
