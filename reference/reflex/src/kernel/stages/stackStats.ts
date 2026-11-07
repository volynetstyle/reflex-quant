export interface RuntimeWalkerStackStats {
  current: number;
  peak: number;
  capacity: number;
}

export const STACK_TRIM_MIN_CAPACITY = 256;

let shouldRecomputeStackPeak = 0;
let resumeEdgeStackPeak = 0;

export function noteShouldRecomputeStackUsage(stackTop: number): void {
  if (!__DEV__) return;
  if (stackTop <= shouldRecomputeStackPeak) return;

  shouldRecomputeStackPeak = stackTop;
}

export function noteResumeEdgeStackUsage(stackTop: number): void {
  if (!__DEV__) return;
  if (stackTop <= resumeEdgeStackPeak) return;

  resumeEdgeStackPeak = stackTop;
}

export function resetRuntimeWalkerStackStats(): void {
  if (!__DEV__) return;
  shouldRecomputeStackPeak = 0;
  resumeEdgeStackPeak = 0;
}

export function trimWalkerStackIfSparse<T>(stack: T[], high: number): void {
  const len = stack.length;

  if (len < STACK_TRIM_MIN_CAPACITY) return;
  if (high > len >> 2) return;

  stack.length = high;
}

export function trimWalkerStackToFloorIfSparse<T>(stack: T[]): void {
  const len = stack.length;

  if (len <= STACK_TRIM_MIN_CAPACITY) return;

  stack.length = STACK_TRIM_MIN_CAPACITY;
}

export function readRuntimeWalkerStackStats(
  shouldRecomputeStackHigh: number,
  shouldRecomputeStackCapacity: number,
  resumeStackHigh: number,
  resumeEdgeStackCapacity: number,
): {
  shouldRecompute: RuntimeWalkerStackStats;
  propagate: RuntimeWalkerStackStats;
} {
  if (!__DEV__) {
    return {
      shouldRecompute: {
        current: 0,
        peak: 0,
        capacity: 0,
      },
      propagate: {
        current: 0,
        peak: 0,
        capacity: 0,
      },
    };
  }

  return {
    shouldRecompute: {
      current: shouldRecomputeStackHigh,
      peak: shouldRecomputeStackPeak,
      capacity: shouldRecomputeStackCapacity,
    },
    propagate: {
      current: resumeStackHigh,
      peak: resumeEdgeStackPeak,
      capacity: resumeEdgeStackCapacity,
    },
  };
}
