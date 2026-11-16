import { isDeepStrictEqual } from "node:util";
import type { Node } from "../../src/graph";
import {
  ImperativeMachine,
  DomainError,
  type IBody,
  type Instruction,
  type ImperativePort,
} from "./imperative-language";
import { ImperativeSpec, type ModelNode } from "./imperative-spec";
import { loadResearchQuant, type ResearchOptions } from "./research-quant";

export function specImperative(auto: boolean) {
  const runtime = new ImperativeSpec(auto);
  const machine = new ImperativeMachine(runtime);
  const publicState = () =>
    [...machine.handles]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, { kind, node }]) => ({
        id,
        kind,
        disposed: node.disposed,
        ...(kind === "effect"
          ? { cleanup: node.cleanup !== undefined }
          : { value: node.value }),
      }));
  const relations = () => {
    const names = new Map(
      [...machine.handles].map(([id, entry]) => [entry.node, id]),
    );
    return [...runtime.births]
      .flatMap(([source, subscribers]) =>
        [...subscribers.keys()].map(
          (consumer) => `${names.get(source)}>${names.get(consumer)}`,
        ),
      )
      .sort();
  };
  const checkpoint = () => {
    const names = new Map(
      [...machine.handles].map(([id, handle]) => [handle.node, id]),
    );
    const frontier = (deps: Map<ModelNode, number>) =>
      [...deps].map(([source, observed]) => ({
        id: names.get(source),
        current: source.version === observed,
      }));
    const states = [...machine.handles]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, { node }]) => ({
        id,
        ...(node.kind === "signal" || node.disposed
          ? {}
          : {
              initialized: node.initialized,
              failed: node.failed,
              pending: node.pending,
              deliveryOwed: node.redeliver,
              deps: frontier(node.deps),
              retry: node.retry === undefined ? null : frontier(node.retry),
            }),
      }));
    const ready =
      runtime.queue.size === 0 &&
      runtime.hold === 0 &&
      [...machine.handles.values()].every(
        ({ node }) =>
          node.kind === "signal" ||
          node.disposed ||
          (node.initialized &&
            !node.failed &&
            !node.pending &&
            node.retry === undefined &&
            [...node.deps].every(
              ([source, observed]) => source.version === observed,
            )),
      );
    const order = [...runtime.births]
      .filter(([source]) => names.has(source))
      .map(([source, subscribers]) => [
        names.get(source),
        [...subscribers]
          .filter(([consumer]) => names.has(consumer))
          .sort((a, b) => a[1] - b[1])
          .map(([consumer]) => names.get(consumer)),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return {
      ready,
      public: publicState(),
      program: machine.programState(),
      states,
      hostPolicy: {
        auto,
        order,
        queued: [...runtime.queue].map((node) => names.get(node)),
        hold: runtime.hold,
      },
    };
  };
  return { runtime, machine, publicState, checkpoint, relations };
}

export async function quantImperative(
  auto: boolean,
  options: ResearchOptions = {},
) {
  const runtime = await loadResearchQuant(options);
  let machine: ImperativeMachine<Node>;
  const port: ImperativePort<Node> = {
    signal: (value) => runtime.api.signal(value) as unknown as Node,
    computed: (fn) => runtime.api.computed(fn) as unknown as Node,
    effect: (fn) =>
      auto
        ? (runtime.api.effect(fn) as unknown as Node)
        : runtime.host.watcher(fn, false),
    read: (node) => runtime.kernel.read(node) as never,
    write: (node, value) => {
      if (auto) runtime.api.set(node as never, value as never);
      else runtime.kernel.write(node, value);
    },
    dispose: (node) => runtime.api.dispose(node as never),
    run: runtime.host.run,
    batch: runtime.host.batch,
    untracked: runtime.kernel.untracked,
    flush: () => {
      if (auto) return runtime.host.flush();
      let failed = false,
        first: unknown;
      for (const handle of machine.handles.values())
        if (handle.kind === "effect") {
          try {
            runtime.host.run(handle.node);
          } catch (error) {
            if (!failed) first = error;
            failed = true;
          }
        }
      if (failed) throw first;
    },
  };
  machine = new ImperativeMachine(port);
  const publicState = () =>
    [...machine.handles]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, { kind, node }]) => ({
        id,
        kind,
        disposed: kind !== "signal" && node.fn === null,
        ...(kind === "effect"
          ? { cleanup: typeof node.value === "function" }
          : { value: node.value }),
      }));
  const relations = () => {
    const names = new Map(
      [...machine.handles].map(([id, entry]) => [entry.node, id]),
    );
    const pairs: string[] = [];
    for (const [id, entry] of machine.handles)
      for (let edge = entry.node.firstDep; edge !== null; edge = edge.nextDep)
        pairs.push(`${names.get(edge.from)}>${id}`);
    return pairs.sort();
  };
  return {
    runtime,
    machine,
    publicState,
    relations,
    execute(op: Instruction) {
      const observation = runtime.operation(() => machine.execute(op));
      runtime.audit();
      return observation;
    },
  };
}

export interface ImperativeProgram {
  readonly id: string;
  readonly auto: boolean;
  readonly operations: IBody;
}
export async function compareImperative(
  program: ImperativeProgram,
  options: ResearchOptions = {},
) {
  const spec = specImperative(program.auto);
  try {
    for (const operation of program.operations) {
      spec.machine.execute(operation);
      if (
        spec.runtime.invalid !== undefined ||
        spec.machine.domainViolation !== undefined
      )
        throw new DomainError(
          spec.runtime.invalid ?? spec.machine.domainViolation!,
        );
    }
  } catch (error) {
    if (error instanceof DomainError)
      return { kind: "ineligible" as const, message: error.message };
    throw error;
  }
  const quant = await quantImperative(program.auto, options);
  const reference = specImperative(program.auto);
  const observations = [];
  for (let at = 0; at < program.operations.length; at++) {
    const expected = {
      observation: reference.machine.execute(program.operations[at]!),
      public: reference.publicState(),
      program: reference.machine.programState(),
      relations: reference.relations(),
    };
    observations.push(expected.observation);
    let actual;
    try {
      actual = {
        observation: quant.execute(program.operations[at]!),
        public: quant.publicState(),
        program: quant.machine.programState(),
        relations: quant.relations(),
      };
    } catch (error) {
      return { kind: "structure" as const, at, message: String(error) };
    }
    if (!isDeepStrictEqual(expected, actual))
      return {
        kind: "implementation" as const,
        at,
        expected,
        actual,
        message: `imperative mismatch ${program.id}@${at}`,
      };
  }
  return {
    kind: "pass" as const,
    message: program.id,
    observations,
    checkpoint: reference.checkpoint(),
    fingerprint: quant.runtime.fingerprint(),
  };
}

export interface ImperativeHistory {
  readonly id: string;
  readonly auto: boolean;
  readonly prefixA: IBody;
  readonly prefixB: IBody;
  readonly suffix: IBody;
}
export async function compareImperativeHistories(
  test: ImperativeHistory,
  options: ResearchOptions = {},
) {
  const snapshots = [];
  for (const prefix of [test.prefixA, test.prefixB]) {
    const world = specImperative(test.auto);
    try {
      for (const op of prefix) world.machine.execute(op);
    } catch (error) {
      return { kind: "ineligible" as const, message: String(error) };
    }
    if (world.runtime.invalid !== undefined)
      return { kind: "ineligible" as const, message: world.runtime.invalid };
    snapshots.push(world.checkpoint());
  }
  if (
    !snapshots[0]!.ready ||
    !snapshots[1]!.ready ||
    !isDeepStrictEqual(snapshots[0], snapshots[1])
  )
    return {
      kind: "ineligible" as const,
      message: "imperative checkpoints differ or owe work",
    };
  const runs = [];
  for (const prefix of [test.prefixA, test.prefixB]) {
    const result = await compareImperative(
      { id: test.id, auto: test.auto, operations: [...prefix, ...test.suffix] },
      options,
    );
    if (result.kind !== "pass") return result;
    runs.push({
      suffix: result.observations.slice(prefix.length),
      checkpoint: result.checkpoint,
      fingerprint: result.fingerprint,
    });
  }
  if (
    !isDeepStrictEqual(runs[0]!.suffix, runs[1]!.suffix) ||
    !isDeepStrictEqual(runs[0]!.checkpoint, runs[1]!.checkpoint)
  )
    return {
      kind: "history-leak" as const,
      message: "imperative suffixes differ",
      runs,
    };
  return {
    kind: "pass" as const,
    message: test.id,
    runs,
    checkpoint: snapshots[0],
  };
}
