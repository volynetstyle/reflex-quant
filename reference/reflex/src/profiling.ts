export interface RuntimeProfileCounters {
  writeCalls: number;
  writeSameValue: number;
  writeChanged: number;
  writeNoSubscribers: number;
  writeNestedPropagation: number;
  propagationScopesEntered: number;
  propagationScopesLeft: number;
  pushCalls: number;
  pushDirectEdgesVisited: number;
  pushTransitiveEdgesVisited: number;
  pushMarkedChanged: number;
  pushMarkedInvalid: number;
  pushAlreadyDirtySkipped: number;
  pushComputingChecked: number;
  pushWatchersInvalidated: number;
  pushChildBranchesQueued: number;
  pushOnceCalls: number;
  pushOnceEdgesVisited: number;
  pushOnceMarkedChanged: number;
  pushOnceAlreadyChangedSkipped: number;
  pushOnceSkippedEdges: number;
  pushOnceScheduledWatcherDeliverySkipped: number;
  pullCalls: number;
  pullEdgesVisited: number;
  pullChangedDeps: number;
  pullInvalidDeps: number;
  pullCleanDeps: number;
  pullDescents: number;
  pullAdvanceCalls: number;
  pullStableSiblingScans: number;
  pullChangedBubbles: number;
  advanceCalls: number;
  advanceComputeRuns: number;
  advanceChanged: number;
  advanceUnchanged: number;
  advanceCleanupChecks: number;
  advanceCleanupRuns: number;
  advancePropagateCalls: number;
  advancePropagateSkippedEdge: number;
  advanceOwnedEdgeOnlySkipped: number;
  readProducerCalls: number;
  readProducerTracked: number;
  readConsumerCalls: number;
  readConsumerLazyCalls: number;
  readConsumerEagerCalls: number;
  readConsumerCleanFastPath: number;
  readConsumerDirtyPath: number;
  readConsumerTracked: number;
  stabilizeForceAdvance: number;
  stabilizePullAdvance: number;
  trackingResolveCalls: number;
  trackingCursorHit: number;
  trackingNextHit: number;
  trackingAppendAfterCursor: number;
  trackingPrefixDuplicate: number;
  trackingOneHopReorder: number;
  trackingTwoHopReorder: number;
  trackingLastEdgeShortcut: number;
  trackingInitialCreate: number;
  trackingInitialFirstHit: number;
  trackingInitialLastEdgeShortcut: number;
  trackingSlowPath: number;
  trackingSlowPathBlocked: number;
  trackingSuffixHeadHit: number;
  trackingSuffixReuseHit: number;
  trackingSuffixLinkNew: number;
  trackingEdgeMoved: number;
  trackingSuffixEagerDetach: number;
  trackingLocateSteps: number;
  cleanupCalls: number;
  cleanupSkipped: number;
  cleanupEdgesDropped: number;
  watcherRunCalls: number;
  watcherScheduleAttempts: number;
  watcherScheduleSuccesses: number;
  watcherScheduleDedupSkipped: number;
  watcherScheduleReleases: number;
  watcherFrontierInvokes: number;
  watcherFrontierEdgesVisited: number;
  watcherFrontierChangedDeps: number;
  watcherFrontierInvalidDeps: number;
  watcherFrontierCleanDeps: number;
  watcherCleanSkips: number;
  watcherStableSkips: number;
  watcherDisposedSkips: number;
  watcherExecutions: number;
  watcherExecutionExits: number;
  watcherCleanupChecks: number;
  watcherCleanups: number;
  watcherDisposals: number;
  contextRunCalls: number;
  contextSwitches: number;
  contextPropagationEnter: number;
  contextPropagationLeave: number;
  contextSettledChecks: number;
  contextSettledEmits: number;
  contextSettledDeferred: number;
  nodeInvalidatedEmits: number;
  computeContextEnters: number;
  computeContextRestores: number;
  pushStackTrimEvents: number;
  pushStackTrimExcess: number;
  pullStackTrimEvents: number;
  pullStackTrimExcess: number;
}

export type RuntimeProfileCounterName = keyof RuntimeProfileCounters;

export type RuntimeProfileResult<T> = {
  value: T;
  counters: RuntimeProfileCounters;
  topology: RuntimeProfileTopology;
};

export interface RuntimeProfileTopologyHotPath {
  path: string;
  count: number;
}

export interface RuntimeProfileTopologyWalker {
  total: number;
  maxDepth: number;
  maxStack: number;
  fanIn: Record<string, number>;
  fanOut: Record<string, number>;
  depth: Record<string, number>;
  branch: Record<string, number>;
  shape: Record<string, number>;
  hotPaths: RuntimeProfileTopologyHotPath[];
}

export interface RuntimeProfileTopology {
  push: RuntimeProfileTopologyWalker;
  pull: RuntimeProfileTopologyWalker;
}

export interface RuntimeProfileSession {
  readonly baseline: RuntimeProfileCounters;
  read(): RuntimeProfileCounters;
  readTopology(): RuntimeProfileTopology;
  delta(from?: RuntimeProfileCounters): RuntimeProfileCounters;
  reset(): void;
  stop(): RuntimeProfileCounters;
}

type RuntimeProfileSessionOptions = {
  enabled?: boolean;
  reset?: boolean;
};

const COUNTER_NAMES = [
  "writeCalls",
  "writeSameValue",
  "writeChanged",
  "writeNoSubscribers",
  "writeNestedPropagation",
  "propagationScopesEntered",
  "propagationScopesLeft",
  "pushCalls",
  "pushDirectEdgesVisited",
  "pushTransitiveEdgesVisited",
  "pushMarkedChanged",
  "pushMarkedInvalid",
  "pushAlreadyDirtySkipped",
  "pushComputingChecked",
  "pushWatchersInvalidated",
  "pushChildBranchesQueued",
  "pushOnceCalls",
  "pushOnceEdgesVisited",
  "pushOnceMarkedChanged",
  "pushOnceAlreadyChangedSkipped",
  "pushOnceSkippedEdges",
  "pushOnceScheduledWatcherDeliverySkipped",
  "pullCalls",
  "pullEdgesVisited",
  "pullChangedDeps",
  "pullInvalidDeps",
  "pullCleanDeps",
  "pullDescents",
  "pullAdvanceCalls",
  "pullStableSiblingScans",
  "pullChangedBubbles",
  "advanceCalls",
  "advanceComputeRuns",
  "advanceChanged",
  "advanceUnchanged",
  "advanceCleanupChecks",
  "advanceCleanupRuns",
  "advancePropagateCalls",
  "advancePropagateSkippedEdge",
  "advanceOwnedEdgeOnlySkipped",
  "readProducerCalls",
  "readProducerTracked",
  "readConsumerCalls",
  "readConsumerLazyCalls",
  "readConsumerEagerCalls",
  "readConsumerCleanFastPath",
  "readConsumerDirtyPath",
  "readConsumerTracked",
  "stabilizeForceAdvance",
  "stabilizePullAdvance",
  "trackingResolveCalls",
  "trackingCursorHit",
  "trackingNextHit",
  "trackingAppendAfterCursor",
  "trackingPrefixDuplicate",
  "trackingOneHopReorder",
  "trackingTwoHopReorder",
  "trackingLastEdgeShortcut",
  "trackingInitialCreate",
  "trackingInitialFirstHit",
  "trackingInitialLastEdgeShortcut",
  "trackingSlowPath",
  "trackingSlowPathBlocked",
  "trackingSuffixHeadHit",
  "trackingSuffixReuseHit",
  "trackingSuffixLinkNew",
  "trackingEdgeMoved",
  "trackingSuffixEagerDetach",
  "trackingLocateSteps",
  "cleanupCalls",
  "cleanupSkipped",
  "cleanupEdgesDropped",
  "watcherRunCalls",
  "watcherScheduleAttempts",
  "watcherScheduleSuccesses",
  "watcherScheduleDedupSkipped",
  "watcherScheduleReleases",
  "watcherFrontierInvokes",
  "watcherFrontierEdgesVisited",
  "watcherFrontierChangedDeps",
  "watcherFrontierInvalidDeps",
  "watcherFrontierCleanDeps",
  "watcherCleanSkips",
  "watcherStableSkips",
  "watcherDisposedSkips",
  "watcherExecutions",
  "watcherExecutionExits",
  "watcherCleanupChecks",
  "watcherCleanups",
  "watcherDisposals",
  "contextRunCalls",
  "contextSwitches",
  "contextPropagationEnter",
  "contextPropagationLeave",
  "contextSettledChecks",
  "contextSettledEmits",
  "contextSettledDeferred",
  "nodeInvalidatedEmits",
  "computeContextEnters",
  "computeContextRestores",
  "pushStackTrimEvents",
  "pushStackTrimExcess",
  "pullStackTrimEvents",
  "pullStackTrimExcess",
] as const satisfies readonly RuntimeProfileCounterName[];

function createCounters(): RuntimeProfileCounters {
  const counters = {} as RuntimeProfileCounters;

  for (const name of COUNTER_NAMES) {
    counters[name] = 0;
  }

  return counters;
}

export const runtimeProfileCounters: RuntimeProfileCounters =
  /* @__PURE__ */ createCounters();

export let runtimeProfileCountersEnabled = false;

function createTopologyWalker(): RuntimeProfileTopologyWalker {
  return {
    total: 0,
    maxDepth: 0,
    maxStack: 0,
    fanIn: {},
    fanOut: {},
    depth: {},
    branch: {},
    shape: {},
    hotPaths: [],
  };
}

function createTopology(): RuntimeProfileTopology {
  return {
    push: createTopologyWalker(),
    pull: createTopologyWalker(),
  };
}

const runtimeProfileTopology: RuntimeProfileTopology = createTopology();

function bucket(value: number, maxBucketStart: number): string {
  if (value <= 0) return "0";
  if (value === 1) return "1";

  let start = 2;
  let end = 3;

  while (end < maxBucketStart && value > end) {
    start = end + 1;
    end = end * 2 + 1;
  }

  if (value > end) {
    return `${maxBucketStart}+`;
  }

  return `${start}-${end}`;
}

const bucketSize = (size: number) => bucket(size, 64);
const bucketDepth = (depth: number) => bucket(depth, 32);

function incrementBucket(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function recordHotPath(
  walker: RuntimeProfileTopologyWalker,
  path: string,
): void {
  const paths = walker.hotPaths;

  for (let index = 0; index < paths.length; index += 1) {
    const item = paths[index]!;

    if (item.path === path) {
      item.count += 1;

      while (index > 0 && paths[index - 1]!.count < item.count) {
        paths[index] = paths[index - 1]!;
        index -= 1;
      }

      paths[index] = item;
      return;
    }
  }

  if (paths.length < 16) {
    paths.push({ path, count: 1 });
    return;
  }

  if (paths[paths.length - 1]!.count <= 1) {
    paths[paths.length - 1] = { path, count: 1 };
  }
}

function cloneRecord(record: Record<string, number>): Record<string, number> {
  return { ...record };
}

function cloneTopologyWalker(
  walker: RuntimeProfileTopologyWalker,
): RuntimeProfileTopologyWalker {
  return {
    total: walker.total,
    maxDepth: walker.maxDepth,
    maxStack: walker.maxStack,
    fanIn: cloneRecord(walker.fanIn),
    fanOut: cloneRecord(walker.fanOut),
    depth: cloneRecord(walker.depth),
    branch: cloneRecord(walker.branch),
    shape: cloneRecord(walker.shape),
    hotPaths: walker.hotPaths.map((item) => ({ ...item })),
  };
}

function resetTopologyWalker(walker: RuntimeProfileTopologyWalker): void {
  walker.total = 0;
  walker.maxDepth = 0;
  walker.maxStack = 0;
  walker.fanIn = {};
  walker.fanOut = {};
  walker.depth = {};
  walker.branch = {};
  walker.shape = {};
  walker.hotPaths = [];
}

export function setRuntimeProfilingEnabled(enabled: boolean): void {
  runtimeProfileCountersEnabled = enabled;
}

export function isRuntimeProfilingEnabled(): boolean {
  return runtimeProfileCountersEnabled;
}

export function profileRuntimeCounter(name: RuntimeProfileCounterName): void {
  if (__PROFILE__ && runtimeProfileCountersEnabled) {
    runtimeProfileCounters[name] += 1;
  }
}

export function profileRuntimeCounterBy(
  name: RuntimeProfileCounterName,
  amount: number,
): void {
  if (__PROFILE__ && runtimeProfileCountersEnabled) {
    runtimeProfileCounters[name] += amount;
  }
}

export function profileRuntimePushPath(
  branch: string,
  depth: number,
  fanIn: number,
  fanOut: number,
  stackDepth: number,
): void {
  if (__PROFILE__ && runtimeProfileCountersEnabled) {
    const walker = runtimeProfileTopology.push;
    const fanInBucket = bucketSize(fanIn);
    const fanOutBucket = bucketSize(fanOut);
    const depthBucket = bucketDepth(depth);
    const path = `${branch}|d:${depthBucket}|in:${fanInBucket}|out:${fanOutBucket}`;

    walker.total += 1;
    if (depth > walker.maxDepth) walker.maxDepth = depth;
    if (stackDepth > walker.maxStack) walker.maxStack = stackDepth;
    incrementBucket(walker.branch, branch);
    incrementBucket(walker.depth, depthBucket);
    incrementBucket(walker.fanIn, fanInBucket);
    incrementBucket(walker.fanOut, fanOutBucket);
    incrementBucket(walker.shape, path);
    recordHotPath(walker, path);
  }
}

export function profileRuntimePullPath(
  branch: string,
  depth: number,
  fanIn: number,
  fanOut: number,
  stackDepth: number,
): void {
  if (__PROFILE__ && runtimeProfileCountersEnabled) {
    const walker = runtimeProfileTopology.pull;
    const fanInBucket = bucketSize(fanIn);
    const fanOutBucket = bucketSize(fanOut);
    const depthBucket = bucketDepth(depth);
    const path = `${branch}|d:${depthBucket}|in:${fanInBucket}|out:${fanOutBucket}`;

    walker.total += 1;
    if (depth > walker.maxDepth) walker.maxDepth = depth;
    if (stackDepth > walker.maxStack) walker.maxStack = stackDepth;
    incrementBucket(walker.branch, branch);
    incrementBucket(walker.depth, depthBucket);
    incrementBucket(walker.fanIn, fanInBucket);
    incrementBucket(walker.fanOut, fanOutBucket);
    incrementBucket(walker.shape, path);
    recordHotPath(walker, path);
  }
}

export function profileRuntimeReadConsumerPath(isDirty: boolean): void {
  if (__PROFILE__ && runtimeProfileCountersEnabled) {
    if (isDirty) runtimeProfileCounters.readConsumerDirtyPath += 1;
    else runtimeProfileCounters.readConsumerCleanFastPath += 1;
  }
}

export function resetRuntimeProfileCounters(): void {
  for (const name of COUNTER_NAMES) {
    runtimeProfileCounters[name] = 0;
  }

  resetTopologyWalker(runtimeProfileTopology.push);
  resetTopologyWalker(runtimeProfileTopology.pull);
}

export function readRuntimeProfileCounters(): RuntimeProfileCounters {
  return { ...runtimeProfileCounters };
}

export const snapshotRuntimeProfileCounters = readRuntimeProfileCounters;

export function readRuntimeProfileTopology(): RuntimeProfileTopology {
  return {
    push: cloneTopologyWalker(runtimeProfileTopology.push),
    pull: cloneTopologyWalker(runtimeProfileTopology.pull),
  };
}

export const snapshotRuntimeProfileTopology = readRuntimeProfileTopology;

export function diffRuntimeProfileCounters(
  after: RuntimeProfileCounters,
  before: RuntimeProfileCounters,
): RuntimeProfileCounters {
  const diff = {} as RuntimeProfileCounters;

  for (const name of COUNTER_NAMES) {
    diff[name] = after[name] - before[name];
  }

  return diff;
}

export function profileRuntime<T>(fn: () => T): RuntimeProfileResult<T> {
  const wasEnabled = runtimeProfileCountersEnabled;

  resetRuntimeProfileCounters();
  runtimeProfileCountersEnabled = true;

  try {
    const value = fn();
    return {
      value,
      counters: readRuntimeProfileCounters(),
      topology: readRuntimeProfileTopology(),
    };
  } finally {
    runtimeProfileCountersEnabled = wasEnabled;
  }
}

export async function profileRuntimeAsync<T>(
  fn: () => Promise<T>,
): Promise<RuntimeProfileResult<T>> {
  const wasEnabled = runtimeProfileCountersEnabled;

  resetRuntimeProfileCounters();
  runtimeProfileCountersEnabled = true;

  try {
    const value = await fn();
    return {
      value,
      counters: readRuntimeProfileCounters(),
      topology: readRuntimeProfileTopology(),
    };
  } finally {
    runtimeProfileCountersEnabled = wasEnabled;
  }
}

export function createRuntimeProfileSession(
  options: RuntimeProfileSessionOptions = {},
): RuntimeProfileSession {
  if (options.reset ?? true) {
    resetRuntimeProfileCounters();
  }

  if (options.enabled ?? true) {
    runtimeProfileCountersEnabled = true;
  }

  const baseline = readRuntimeProfileCounters();

  return {
    baseline,
    read: readRuntimeProfileCounters,
    readTopology: readRuntimeProfileTopology,
    delta(from = baseline) {
      return diffRuntimeProfileCounters(readRuntimeProfileCounters(), from);
    },
    reset() {
      resetRuntimeProfileCounters();
    },
    stop() {
      const counters = readRuntimeProfileCounters();
      runtimeProfileCountersEnabled = false;
      return counters;
    },
  };
}
