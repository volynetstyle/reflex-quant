// Successful, quiescent boundaries in the existing explicit-flush DSL.
// The spec certifies a pair before either isolated Quant world is created.
import { isDeepStrictEqual } from "node:util";
import { vi } from "vitest";
import type {
  Expr,
  Machine,
  Observation,
  Op,
  Value,
} from "../../reference/reflex/test/differential/api";
import {
  RuntimeMachine,
  type RuntimeNode,
  type RuntimePort,
} from "../../reference/reflex/test/differential/internal/machine/RuntimeMachine";
import {
  format,
  observationsEqual,
} from "../../reference/reflex/test/differential/internal/machine/eval";
import type {
  SpecComputed,
  SpecProducer,
  SpecWatcher,
} from "../../reference/reflex/test/differential/internal/machine/spec-runtime";
import { Flag, KEEP, TRIM } from "../../src/graph";
import type { Edge, Node } from "../../src/graph";
import type { stats } from "../../src/instrumentation";
import { ContractSpecRuntime } from "./contract-spec";
import { checkGraph } from "./graph";
import {
  auditRetiredEdges,
  type RetirementCounts,
  type RetirementPort,
} from "./history-retirement";

type Declaration = Extract<Op, { type: "signal" | "computed" | "effect" }>;
type SpecNode = SpecProducer<Value> | SpecComputed<Value> | SpecWatcher;
export type Work = typeof stats;

export interface HistoryCase {
  readonly id: string;
  readonly rule: string;
  /** Coverage provenance, never an equivalence axiom. */
  readonly histories?: {
    readonly a: readonly string[];
    readonly b: readonly string[];
  };
  /** Public names at the boundary; private disposed watchers cannot be named by S. */
  readonly handles: readonly string[];
  readonly prefixA: readonly Op[];
  readonly prefixB: readonly Op[];
  readonly suffix: readonly Op[];
  /** Per-operation counter envelopes, independently of pairwise work equality. */
  readonly bounds?: readonly {
    readonly at: number;
    readonly max: Partial<Work>;
  }[];
}

interface AbstractNode {
  id: string;
  kind: "producer" | "computed" | "watcher";
  state: "ready" | "disposed";
  value?: Value;
  expression?: Expr;
  cleanupExpression?: Expr;
  cleanup?: boolean;
  deps?: string[];
}

export interface Checkpoint {
  readonly nodes: readonly AbstractNode[];
  /** Explicit flush visits watchers in this order; we do not sort event traces. */
  readonly watchers: readonly string[];
}

export interface EquivalenceWitness {
  readonly boundary: "successful-quiescent";
  readonly callbackState: "stateless-expression-dsl";
  readonly nodes: number;
  readonly relations: number;
  readonly facts: readonly string[];
}

interface RecordedWorld<P, C, W> extends Machine {
  readonly nodes: Map<string, RuntimeNode<P, C, W>>;
  readonly declarations: Map<string, Declaration>;
}

/** Capture names through the port rather than accessing RuntimeMachine's private fields. */
function record<P, C, W>(port: RuntimePort<P, C, W>): RecordedWorld<P, C, W> {
  const nodes = new Map<string, RuntimeNode<P, C, W>>();
  const declarations = new Map<string, Declaration>();
  let declaration: Declaration;
  const keep = <T extends RuntimeNode<P, C, W>>(entry: T): T["node"] => {
    nodes.set(declaration.id, entry);
    declarations.set(declaration.id, declaration);
    return entry.node;
  };
  const machine = new RuntimeMachine({
    ...port,
    createProducer: (value) =>
      keep({ kind: "producer", node: port.createProducer(value) }) as P,
    createComputed: (fn) =>
      keep({ kind: "computed", node: port.createComputed(fn) }) as C,
    createWatcher: (fn) =>
      keep({ kind: "watcher", node: port.createWatcher(fn) }) as W,
  });
  return {
    nodes,
    declarations,
    execute(operation) {
      if (
        operation.type === "signal" ||
        operation.type === "computed" ||
        operation.type === "effect"
      )
        declaration = operation;
      return machine.execute(operation);
    },
  };
}

function specWorld() {
  const runtime = new ContractSpecRuntime();
  const world = record({
    createProducer: (value) => runtime.createProducer(value),
    createComputed: (fn) => runtime.createComputed(fn),
    createWatcher: (fn) => runtime.createWatcher(fn),
    readProducer: (node: SpecProducer<Value>) => runtime.readProducer(node),
    writeProducer: (node: SpecProducer<Value>, value) =>
      runtime.writeProducer(node, value),
    readComputed: (node: SpecComputed<Value>) => runtime.readComputed(node),
    runWatcher: (node: SpecWatcher) => runtime.runWatcher(node),
    disposeWatcher: (node: SpecWatcher) => runtime.disposeWatcher(node),
    enterBatch: () => {},
    leaveBatch: () => {},
  });
  return {
    ...world,
    failed: (node: SpecComputed<Value>) => runtime.isFailedComputed(node),
  };
}

type SpecWorld = ReturnType<typeof specWorld>;
type Kernel = typeof import("../../src/kernel") & {
  __historyRoots(): {
    active: Node | null;
    cursor: Edge | null;
    top: number;
    slots: (Edge | null)[];
  };
};
type Host = typeof import("../../src/host") & {
  __historyRoots(): { size: number; hold: number; slots: (Node | null)[] };
};

export interface Resources {
  readonly nodes: number;
  readonly relations: number;
  readonly reachableEdges: number;
  readonly stackSlots: number;
  readonly queueSlots: number;
  readonly retirement?: Readonly<RetirementCounts>;
}

export interface QuantWorld extends RecordedWorld<Node, Node, Node> {
  counters(): Work;
  audit(): Resources;
}

/** Fresh module globals, not just fresh nodes on a previously exercised kernel. */
export async function createHistoryQuantWorld(): Promise<QuantWorld> {
  vi.resetModules();
  const kernel = (await import("../../src/kernel")) as Kernel;
  const host = (await import("../../src/host")) as Host;
  const graph =
    (await import("../../src/graph")) as typeof import("../../src/graph") &
      RetirementPort;
  const retirement: RetirementCounts = {
    edges: 0,
    cutRuns: 0,
    cutEdges: 0,
    singleEdges: 0,
  };
  const world = record<Node, Node, Node>({
    createProducer: (value) => kernel.createNode(null, value, 0),
    createComputed: (fn) => kernel.createNode(fn, undefined, Flag.Dirty),
    createWatcher: (fn) => host.watcher(fn, false),
    readProducer: (node) => kernel.read(node) as Value,
    writeProducer: kernel.write,
    readComputed: (node) => kernel.read(node) as Value,
    runWatcher: host.run,
    disposeWatcher: host.stop,
    enterBatch: () => {},
    leaveBatch: () => {},
  });
  return {
    ...world,
    execute(operation) {
      graph.__historyBeginRetirement();
      try {
        return world.execute(operation);
      } finally {
        const counts = auditRetiredEdges(graph.__historyTakeRetirements());
        retirement.edges += counts.edges;
        retirement.cutRuns += counts.cutRuns;
        retirement.cutEdges += counts.cutEdges;
        retirement.singleEdges += counts.singleEdges;
      }
    },
    counters: () => ({ ...kernel.stats }),
    audit: () => ({
      ...auditHistoryRoots(
        world,
        kernel.__historyRoots(),
        host.__historyRoots(),
      ),
      retirement: { ...retirement },
    }),
  };
}

function demand(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** All graph fields, all physical array slots, and the persistent host/kernel registers. */
export function auditHistoryRoots(
  world: RecordedWorld<Node, Node, Node>,
  kernel: ReturnType<Kernel["__historyRoots"]>,
  host: ReturnType<Host["__historyRoots"]>,
): Resources {
  demand(
    kernel.active === null && kernel.cursor === null && kernel.top === 0,
    "kernel registers retain a pass at rest",
  );
  demand(
    host.size === 0 && host.hold === 0,
    "explicit-flush world retains host work",
  );
  demand(
    kernel.slots.every((entry) => entry === null),
    "inactive work-stack slot retains an edge",
  );
  demand(
    host.slots.every((entry) => entry === null),
    "inactive queue slot retains a watcher",
  );
  demand(kernel.slots.length <= TRIM, "work stack exceeds its at-rest bound");
  // No scheduled watchers exist in this DSL, so the queue must stay at KEEP.
  demand(host.slots.length === KEEP, "unscheduled world grew the host queue");
  const nodes = [...world.nodes.values()].map((entry) => entry.node);
  const relations = new Set<Edge>();
  for (const node of nodes) {
    for (const field of ["firstDep", "firstSub"] as const) {
      const seen = new Set<Edge>();
      for (
        let edge = node[field];
        edge !== null;
        edge = field === "firstDep" ? edge.nextDep : edge.nextSub
      ) {
        demand(!seen.has(edge), `cyclic ${field} list`);
        seen.add(edge);
        if (field === "firstDep") relations.add(edge);
      }
    }
  }
  checkGraph(nodes, "history-erasure");
  for (const entry of world.nodes.values()) {
    if (entry.kind === "watcher" && entry.node.fn === null)
      demand(
        entry.node.firstDep === null &&
          entry.node.lastDep === null &&
          entry.node.slot === null &&
          typeof entry.node.value !== "function",
        "disposed watcher retains dependencies or cleanup",
      );
  }
  const seen = new Set<Node | Edge>();
  const pending: (Node | Edge | null)[] = [
    ...nodes,
    kernel.active,
    kernel.cursor,
    ...kernel.slots,
    ...host.slots,
  ];
  let reachableEdges = 0;
  while (pending.length !== 0) {
    const item = pending.pop()!;
    if (item === null || seen.has(item)) continue;
    seen.add(item);
    if ("from" in item) {
      reachableEdges++;
      demand(
        relations.has(item),
        "retired relation is reachable from retained handles/runtime roots",
      );
      pending.push(
        item.from,
        item.to,
        item.prevDep,
        item.nextDep,
        item.prevSub,
        item.nextSub,
      );
    } else pending.push(item.firstDep, item.lastDep, item.firstSub, item.slot);
  }
  return {
    nodes: nodes.length,
    relations: relations.size,
    reachableEdges,
    stackSlots: kernel.slots.length,
    queueSlots: host.slots.length,
  };
}

function reads(expression: Expr): string[] {
  switch (expression.type) {
    case "read":
      return [expression.id];
    case "constant":
    case "throw":
      return [];
    case "if":
      return [
        ...reads(expression.condition),
        ...reads(expression.then),
        ...reads(expression.else),
      ];
    default:
      return [...reads(expression.left), ...reads(expression.right)];
  }
}

/** Reject malformed programs before their errors can become a differential oracle. */
function validate(test: HistoryCase, prefix: readonly Op[]): void {
  demand(
    new Set(test.handles).size === test.handles.length,
    "duplicate public handle",
  );
  const known = new Map<string, Declaration["type"]>();
  const step = (operation: Op) => {
    if (
      operation.type === "signal" ||
      operation.type === "computed" ||
      operation.type === "effect"
    ) {
      demand(!known.has(operation.id), `duplicate declaration ${operation.id}`);
      if (operation.type !== "signal") {
        for (const id of [
          ...reads(operation.expression),
          ...(operation.type === "effect" && operation.cleanup
            ? reads(operation.cleanup)
            : []),
        ])
          demand(
            known.has(id) && known.get(id) !== "effect",
            `invalid expression read ${id}`,
          );
      }
      known.set(operation.id, operation.type);
    } else if (operation.type === "set")
      demand(
        known.get(operation.id) === "signal",
        `invalid write ${operation.id}`,
      );
    else if (operation.type === "read")
      demand(
        known.has(operation.id) && known.get(operation.id) !== "effect",
        `invalid read ${operation.id}`,
      );
    else if (operation.type === "dispose")
      demand(
        known.get(operation.id) === "effect",
        `invalid disposal ${operation.id}`,
      );
    else
      demand(
        operation.type === "flush",
        "batch scheduling is outside the explicit-flush history language",
      );
  };
  prefix.forEach(step);
  for (const id of test.handles)
    demand(known.has(id), `missing public handle ${id}`);
  const reserved = new Set(known.keys());
  // Private prefix names are outside the suffix interface, including in callbacks.
  for (const id of known.keys())
    if (!test.handles.includes(id)) known.delete(id);
  for (const operation of test.suffix) {
    if (
      operation.type === "signal" ||
      operation.type === "computed" ||
      operation.type === "effect"
    )
      demand(
        !reserved.has(operation.id),
        `suffix reuses prefix name ${operation.id}`,
      );
    step(operation);
  }
  for (const bound of test.bounds ?? []) {
    demand(
      Number.isInteger(bound.at) &&
        bound.at >= 0 &&
        bound.at < test.suffix.length,
      "counter bound is outside the suffix",
    );
    demand(
      Object.values(bound.max).every(
        (limit) =>
          typeof limit === "number" && Number.isFinite(limit) && limit >= 0,
      ),
      "invalid counter envelope",
    );
  }
}

/** Syntactic/domain admissibility only; this does not certify the checkpoint. */
export function historyContinuationIsValid(test: HistoryCase): boolean {
  try {
    validate(test, test.prefixA);
    validate(test, test.prefixB);
    return true;
  } catch {
    return false;
  }
}

function snapshot<P, C, W>(
  world: RecordedWorld<P, C, W>,
  handles: readonly string[],
  project: (
    entry: RuntimeNode<P, C, W>,
    id: string,
    names: Map<P | C | W, string>,
  ) => Omit<AbstractNode, "id" | "expression" | "cleanupExpression">,
): Checkpoint {
  const names = new Map(
    [...world.nodes].map(([id, entry]) => [entry.node, id]),
  );
  const publicNames = new Set(handles);
  const nodes = [...publicNames].sort().map((id): AbstractNode => {
    const entry = world.nodes.get(id);
    demand(entry !== undefined, `missing boundary handle ${id}`);
    const projected = project(entry, id, names);
    const declaration = world.declarations.get(id)!;
    if (declaration.type === "signal" || projected.state === "disposed")
      return { id, ...projected };
    for (const dependency of [
      ...reads(declaration.expression),
      ...(declaration.type === "effect" && declaration.cleanup
        ? reads(declaration.cleanup)
        : []),
    ])
      demand(
        publicNames.has(dependency),
        `${id} callback captures private handle ${dependency}`,
      );
    return {
      id,
      ...projected,
      expression: declaration.expression,
      ...(declaration.type === "effect" && declaration.cleanup !== undefined
        ? { cleanupExpression: declaration.cleanup }
        : {}),
    };
  });
  for (const [id, entry] of world.nodes) {
    if (!publicNames.has(id))
      demand(
        entry.kind === "watcher" &&
          project(entry, id, names).state === "disposed",
        `private handle ${id} is still live`,
      );
  }
  return {
    nodes,
    watchers: [...world.nodes.keys()].filter((id) =>
      nodes.some(
        (node) =>
          node.id === id && node.kind === "watcher" && node.state === "ready",
      ),
    ),
  };
}

function specCheckpoint(
  world: SpecWorld,
  handles: readonly string[],
): Checkpoint {
  return snapshot(world, handles, ({ node }, id, names) => {
    if (node.kind === "producer")
      return { kind: node.kind, state: "ready", value: node.value };
    if (node.kind === "watcher" && node.compute === undefined)
      return { kind: node.kind, state: "disposed" };
    demand(
      node.initialized && node.retryDependencies === undefined,
      `${id} has no successful recovered boundary`,
    );
    if (node.kind === "watcher")
      demand(!node.executionPending, `${id} still owes execution`);
    const deps = [...node.dependencies].map(([source, observed]) => {
      demand(source.version === observed, `${id} has unvalidated version debt`);
      const name = names.get(source as SpecNode);
      demand(
        name !== undefined && handles.includes(name),
        `${id} has a private dependency`,
      );
      return name;
    });
    return node.kind === "computed"
      ? { kind: node.kind, state: "ready", value: node.value as Value, deps }
      : {
          kind: node.kind,
          state: "ready",
          cleanup: node.cleanup !== undefined,
          deps,
        };
  });
}

function quantCheckpoint(
  world: QuantWorld,
  handles: readonly string[],
): Checkpoint {
  return snapshot(world, handles, ({ node, kind }, id, names) => {
    if (kind === "producer")
      return { kind, state: "ready", value: node.value as Value };
    if (kind === "watcher" && node.fn === null)
      return { kind, state: "disposed" };
    demand(
      // STALE can be redundant validation work: a computed may already have
      // validated unchanged while its watcher still awaits an explicit flush.
      // Current observations below, not that representation bit, decide debt.
      node.fn !== null && (node.flags & Flag.Dirty) === 0,
      `${id} is not recovered in Quant`,
    );
    const deps: string[] = [];
    for (let edge = node.firstDep; edge !== null; edge = edge.nextDep) {
      demand(edge.ver === edge.from.ver, `${id} has a stale Quant observation`);
      const name = names.get(edge.from);
      demand(
        name !== undefined && handles.includes(name),
        `${id} has a private Quant dependency`,
      );
      deps.push(name);
    }
    return kind === "computed"
      ? { kind, state: "ready", value: node.value as Value, deps }
      : {
          kind,
          state: "ready",
          cleanup: typeof node.value === "function",
          deps,
        };
  });
}

interface PublicNode {
  id: string;
  kind: "producer" | "computed" | "watcher";
  live: boolean;
  value?: Value | undefined;
  cleanup?: boolean;
}

interface PublicState {
  nodes: PublicNode[];
  watchers: string[];
}

/** Open states retain debts/failure gates; only absolute historical counters disappear. */
export interface ContinuationState {
  readonly public: PublicState;
  readonly computations: readonly {
    readonly id: string;
    readonly initialized: boolean;
    readonly failed?: boolean;
    readonly executionPending?: boolean;
    readonly deps: readonly {
      readonly id: string;
      readonly current: boolean;
    }[];
    readonly retry:
      | readonly { readonly id: string; readonly current: boolean }[]
      | null;
    readonly expression: Expr;
    readonly cleanupExpression?: Expr;
  }[];
}

interface OpenBoundary {
  public: PublicState;
  recovered?: Checkpoint;
}

export interface HistoryRunOptions {
  /** Open suffix endpoints are for continuation search; initial checkpoints stay strict. */
  readonly endpoint?: "successful" | "open";
}

function publicState<P, C, W>(
  world: RecordedWorld<P, C, W>,
  handles: readonly string[],
  project: (entry: RuntimeNode<P, C, W>, id: string) => PublicNode,
): PublicState {
  const nodes = [...handles]
    .sort()
    .map((id) => project(world.nodes.get(id)!, id));
  return {
    nodes,
    watchers: [...world.nodes.keys()].filter((id) =>
      nodes.some(
        (node) => node.id === id && node.kind === "watcher" && node.live,
      ),
    ),
  };
}

function specContinuation(
  world: SpecWorld,
  handles: readonly string[],
): ContinuationState {
  const names = new Map(
    [...world.nodes].map(([id, entry]) => [entry.node, id]),
  );
  const frontier = (deps: Map<unknown, number>) =>
    [...deps].map(([source, observed]) => {
      const id = names.get(source as SpecNode);
      demand(
        id !== undefined && handles.includes(id),
        "continuation has a private dependency",
      );
      return {
        id,
        current: (source as { version: number }).version === observed,
      };
    });
  return {
    public: publicState(world, handles, ({ node, kind }, id) =>
      kind === "watcher"
        ? {
            id,
            kind,
            live: (node as SpecWatcher).compute !== undefined,
            cleanup: (node as SpecWatcher).cleanup !== undefined,
          }
        : {
            id,
            kind,
            live: true,
            value: (node as SpecProducer<Value> | SpecComputed<Value>).value,
          },
    ),
    computations: [...handles].sort().flatMap((id) => {
      const { node } = world.nodes.get(id)!;
      if (
        node.kind === "producer" ||
        (node.kind === "watcher" && node.compute === undefined)
      )
        return [];
      const declaration = world.declarations.get(id)!;
      demand(
        declaration.type !== "signal",
        "computation has a producer declaration",
      );
      return [
        {
          id,
          initialized: node.initialized,
          ...(node.kind === "computed"
            ? { failed: world.failed(node) }
            : { executionPending: node.executionPending }),
          deps: frontier(node.dependencies),
          retry:
            node.retryDependencies === undefined
              ? null
              : frontier(node.retryDependencies),
          expression: declaration.expression,
          ...(declaration.type === "effect" && declaration.cleanup !== undefined
            ? { cleanupExpression: declaration.cleanup }
            : {}),
        },
      ];
    }),
  };
}

function quantPublicState(
  world: QuantWorld,
  handles: readonly string[],
): PublicState {
  return publicState(world, handles, ({ node, kind }, id) =>
    kind === "watcher"
      ? {
          id,
          kind,
          live: node.fn !== null,
          cleanup: typeof node.value === "function",
        }
      : {
          id,
          kind,
          live: kind === "producer" || node.fn !== null,
          value: node.value as Value | undefined,
        },
  );
}

interface SpecRun {
  prefix: Observation[];
  suffix: Observation[];
  checkpoint: Checkpoint;
  next: Checkpoint | OpenBoundary;
  continuation?: ContinuationState;
}

export interface PrefixTraceStep {
  readonly at: number;
  readonly observation: Observation;
  readonly state: ContinuationState;
}

export type PrefixCertification =
  | {
      readonly kind: "certified";
      readonly checkpoint: Checkpoint;
      readonly trace: readonly PrefixTraceStep[];
    }
  | {
      readonly kind: "invalid" | "open";
      readonly message: string;
      readonly trace: readonly PrefixTraceStep[];
    };

/** Spec-only admission of an exact prefix: no Quant, demands or healing suffix. */
export function certifyHistoryPrefix(
  test: HistoryCase,
  prefix: readonly Op[],
  traceStates = false,
): PrefixCertification {
  const candidate = { ...test, suffix: [], bounds: [] };
  const trace: PrefixTraceStep[] = [];
  try {
    validate(candidate, prefix);
  } catch (error) {
    return { kind: "invalid", message: String(error), trace };
  }
  const world = specWorld();
  prefix.forEach((operation, at) => {
    const observation = world.execute(operation);
    if (traceStates)
      trace.push({
        at,
        observation,
        state: specContinuation(world, [...world.nodes.keys()]),
      });
  });
  try {
    return {
      kind: "certified",
      checkpoint: specCheckpoint(world, test.handles),
      trace,
    };
  } catch (error) {
    return { kind: "open", message: String(error), trace };
  }
}

function runSpec(
  test: HistoryCase,
  prefix: readonly Op[],
  options: HistoryRunOptions,
): SpecRun {
  validate(test, prefix);
  const world = specWorld();
  const before = prefix.map((operation) => world.execute(operation));
  const checkpoint = specCheckpoint(world, test.handles);
  const after = test.suffix.map((operation) => world.execute(operation));
  const added = test.suffix
    .filter(
      (operation): operation is Declaration =>
        operation.type === "signal" ||
        operation.type === "computed" ||
        operation.type === "effect",
    )
    .map((operation) => operation.id);
  const handles = [...test.handles, ...added];
  const continuation =
    options.endpoint === "open" ? specContinuation(world, handles) : undefined;
  let next: Checkpoint | OpenBoundary;
  if (continuation === undefined) next = specCheckpoint(world, handles);
  else {
    next = { public: continuation.public };
    try {
      next.recovered = specCheckpoint(world, handles);
    } catch {
      /* Debts, uninitialized nodes and cold failures remain open. */
    }
  }
  return {
    prefix: before,
    suffix: after,
    checkpoint,
    next,
    ...(continuation === undefined ? {} : { continuation }),
  };
}

export type HistoryVerdict =
  | "pass"
  | "ineligible"
  | "spec-divergence"
  | "history-leak"
  | "implementation"
  | "structure";
export interface HistoryResult {
  readonly kind: HistoryVerdict;
  readonly message: string;
  readonly at?: number;
  readonly checkpoint?: Checkpoint;
  readonly witness?: EquivalenceWitness;
  readonly work?: { readonly a: readonly Work[]; readonly b: readonly Work[] };
  readonly resources?: { readonly a: Resources; readonly b: Resources };
  readonly continuation?: ContinuationState;
  readonly lastObservation?: Observation;
  readonly difference?: {
    readonly edge: "spec" | "quant" | "A/spec" | "B/spec";
    readonly phase: "prefix" | "suffix" | "checkpoint" | "next";
    readonly expected: unknown;
    readonly actual: unknown;
  };
}

function difference(
  a: readonly Observation[],
  b: readonly Observation[],
): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (
      a[i] === undefined ||
      b[i] === undefined ||
      !observationsEqual(a[i]!, b[i]!)
    )
      return i;
  return -1;
}

function subtract(after: Work, before: Work): Work {
  const delta = { ...after };
  for (const key of Object.keys(delta) as (keyof Work)[])
    delta[key] -= before[key];
  return delta;
}

/** Four executions; pair eligibility and upper-edge checks never consult Quant. */
export async function runHistoryCase(
  test: HistoryCase,
  factory: () => Promise<QuantWorld> = createHistoryQuantWorld,
  options: HistoryRunOptions = {},
): Promise<HistoryResult> {
  let a: SpecRun, b: SpecRun;
  try {
    a = runSpec(test, test.prefixA, options);
    b = runSpec(test, test.prefixB, options);
  } catch (error) {
    return { kind: "ineligible", message: String(error) };
  }
  if (!isDeepStrictEqual(a.checkpoint, b.checkpoint))
    return { kind: "ineligible", message: "spec checkpoints differ" };
  const common = {
    checkpoint: a.checkpoint,
    ...(a.continuation === undefined ? {} : { continuation: a.continuation }),
    ...(a.suffix.length === 0 ? {} : { lastObservation: a.suffix.at(-1)! }),
    witness: {
      boundary: "successful-quiescent" as const,
      callbackState: "stateless-expression-dsl" as const,
      nodes: a.checkpoint.nodes.length,
      relations: a.checkpoint.nodes.reduce(
        (sum, node) => sum + (node.deps?.length ?? 0),
        0,
      ),
      facts: [
        "same public program",
        "same values and liveness",
        "same ordered committed frontiers",
        "all observations current",
        "no retry frontier or execution debt",
        "same cleanup presence",
        "same explicit-flush order",
      ],
    },
  };
  const upper = difference(a.suffix, b.suffix);
  if (
    upper >= 0 ||
    !isDeepStrictEqual(a.next, b.next) ||
    !isDeepStrictEqual(a.continuation, b.continuation)
  )
    return {
      ...common,
      kind: "spec-divergence",
      message: "equivalent checkpoints have different spec continuations",
      at: upper >= 0 ? upper : test.suffix.length,
      difference: {
        edge: "spec",
        phase: upper >= 0 ? "suffix" : "next",
        expected: upper >= 0 ? a.suffix[upper] : (a.continuation ?? a.next),
        actual: upper >= 0 ? b.suffix[upper] : (b.continuation ?? b.next),
      },
    };
  const runs: {
    suffix: Observation[];
    work: Work[];
    next: Checkpoint | OpenBoundary | { error: string };
    resources: Resources;
  }[] = [];
  for (const [label, prefix, spec] of [
    ["A", test.prefixA, a],
    ["B", test.prefixB, b],
  ] as const) {
    // A loader/factory error is a harness failure, not a structural verdict.
    const world = await factory();
    let stage = "prefix";
    let position = 0;
    try {
      world.audit();
      const before = prefix.map((operation, at) => {
        position = at;
        const observation = world.execute(operation);
        world.audit();
        return observation;
      });
      const mismatch = difference(before, spec.prefix);
      if (mismatch >= 0)
        return {
          ...common,
          kind: "implementation",
          message: `Quant ${label} differs from its spec prefix`,
          at: mismatch,
          difference: {
            edge: `${label}/spec`,
            phase: "prefix",
            expected: spec.prefix[mismatch],
            actual: before[mismatch],
          },
        };
      let checkpoint: Checkpoint;
      try {
        checkpoint = quantCheckpoint(world, test.handles);
      } catch (error) {
        return {
          ...common,
          kind: "implementation",
          message: `Quant ${label} boundary: ${String(error)}`,
          at: prefix.length,
        };
      }
      if (!isDeepStrictEqual(checkpoint, spec.checkpoint))
        return {
          ...common,
          kind: "implementation",
          message: `Quant ${label} differs from its spec checkpoint`,
          at: prefix.length,
          difference: {
            edge: `${label}/spec`,
            phase: "checkpoint",
            expected: spec.checkpoint,
            actual: checkpoint,
          },
        };
      const work: Work[] = [];
      stage = "suffix";
      const after = test.suffix.map((operation, at) => {
        position = at;
        const counters = world.counters();
        const observation = world.execute(operation);
        const delta = subtract(world.counters(), counters);
        work.push(delta);
        world.audit();
        for (const bound of test.bounds ?? [])
          if (bound.at === at) {
            for (const key of Object.keys(bound.max) as (keyof Work)[])
              demand(
                delta[key] <= bound.max[key]!,
                `suffix[${at}] ${key}=${delta[key]} exceeds ${bound.max[key]}`,
              );
          }
        return observation;
      });
      const added = test.suffix
        .filter(
          (operation): operation is Declaration =>
            operation.type === "signal" ||
            operation.type === "computed" ||
            operation.type === "effect",
        )
        .map((operation) => operation.id);
      let next: Checkpoint | OpenBoundary | { error: string };
      try {
        const handles = [...test.handles, ...added];
        next =
          options.endpoint === "open"
            ? {
                public: quantPublicState(world, handles),
                ...("recovered" in spec.next
                  ? { recovered: quantCheckpoint(world, handles) }
                  : {}),
              }
            : quantCheckpoint(world, handles);
      } catch (error) {
        next = { error: String(error) };
      }
      runs.push({ suffix: after, work, next, resources: world.audit() });
    } catch (error) {
      return {
        ...common,
        kind: "structure",
        message: `Quant ${label} ${stage}[${position}]: ${String(error)}`,
        at: position,
      };
    }
  }
  const [qa, qb] = runs as [(typeof runs)[number], (typeof runs)[number]];
  const measured = {
    ...common,
    work: { a: qa.work, b: qb.work },
    resources: { a: qa.resources, b: qb.resources },
  };
  const lower = difference(qa.suffix, qb.suffix);
  if (lower >= 0 || !isDeepStrictEqual(qa.next, qb.next))
    return {
      ...measured,
      kind: "history-leak",
      message: "Quant continuations distinguish spec-equivalent histories",
      at: lower >= 0 ? lower : test.suffix.length,
      difference: {
        edge: "quant",
        phase: lower >= 0 ? "suffix" : "next",
        expected: lower >= 0 ? qa.suffix[lower] : qa.next,
        actual: lower >= 0 ? qb.suffix[lower] : qb.next,
      },
    };
  const vertical = difference(qa.suffix, a.suffix);
  if (vertical >= 0 || !isDeepStrictEqual(qa.next, a.next))
    return {
      ...measured,
      kind: "implementation",
      message: "both Quant worlds agree but differ from the spec continuation",
      at: vertical >= 0 ? vertical : test.suffix.length,
      difference: {
        edge: "A/spec",
        phase: vertical >= 0 ? "suffix" : "next",
        expected: vertical >= 0 ? a.suffix[vertical] : a.next,
        actual: vertical >= 0 ? qa.suffix[vertical] : qa.next,
      },
    };
  return {
    ...measured,
    kind: "pass",
    message:
      "certified histories have equivalent continuations within the checked bounds",
  };
}

/** Replayable programs plus normalized first-difference evidence; never graph objects. */
export function describeHistoryFailure(
  test: HistoryCase,
  result: HistoryResult,
): string {
  return format({
    test,
    verdict: result.kind,
    message: result.message,
    at: result.at,
    witness: result.witness,
    difference: result.difference,
  });
}

/** Operation deletion also removes nodes/relations; recertify every candidate. */
export async function shrinkHistoryCase(
  test: HistoryCase,
  fails: (candidate: HistoryCase, result: HistoryResult) => boolean,
  factory: () => Promise<QuantWorld> = createHistoryQuantWorld,
): Promise<HistoryCase> {
  let current = test;
  const original = await runHistoryCase(current, factory);
  demand(
    original.kind !== "ineligible" &&
      original.kind !== "pass" &&
      fails(current, original),
    "shrinker requires a certified failing case",
  );
  let progress = true;
  while (progress) {
    progress = false;
    for (const field of ["suffix", "prefixA", "prefixB"] as const) {
      for (
        let size = Math.max(1, current[field].length >> 1);
        size >= 1;
        size >>= 1
      ) {
        for (let start = 0; start + size <= current[field].length; start++) {
          const operations = [
            ...current[field].slice(0, start),
            ...current[field].slice(start + size),
          ];
          let bounds = current.bounds;
          if (field === "suffix" && bounds !== undefined)
            bounds = bounds
              .filter((bound) => bound.at < start || bound.at >= start + size)
              .map((bound) => ({
                ...bound,
                at: bound.at >= start + size ? bound.at - size : bound.at,
              }));
          const candidate = {
            ...current,
            [field]: operations,
            ...(bounds === undefined ? {} : { bounds }),
          };
          const result = await runHistoryCase(candidate, factory);
          if (result.kind === original.kind && fails(candidate, result)) {
            current = candidate;
            progress = true;
            break;
          }
        }
      }
    }
    for (const id of current.handles) {
      const prefixA = current.prefixA.filter(
        (operation) => !("id" in operation && operation.id === id),
      );
      const prefixB = current.prefixB.filter(
        (operation) => !("id" in operation && operation.id === id),
      );
      const candidate = {
        ...current,
        handles: current.handles.filter((handle) => handle !== id),
        prefixA,
        prefixB,
      };
      const result = await runHistoryCase(candidate, factory);
      if (result.kind === original.kind && fails(candidate, result)) {
        current = candidate;
        progress = true;
        break;
      }
    }
  }
  return current;
}
