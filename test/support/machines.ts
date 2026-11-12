import { Flag } from "../../src/graph";
// The quant runtime behind the differential testkit's RuntimePort, and a
// four-way runner: the executable spec, the contract spec (spec + D1/D2),
// current Reflex and quant execute the same program operation by operation.
import { resetRuntimeContext } from "../../reference/reflex/src";
import {
  ReflexMachine,
  SpecMachine,
  observationsEqual,
} from "../../reference/reflex/test/differential/harness";
import type { Observation, Op, Program } from "../../reference/reflex/test/differential/api";
import { RuntimeMachine } from "../../reference/reflex/test/differential/internal/machine/RuntimeMachine";
import { createNode, read, write } from "../../src/kernel";
import type { Node } from "../../src/graph";
import { run, stop, watcher } from "../../src/host";
import { ContractSpecMachine } from "./contract-spec";

/** Every node the current quant machine created, for structural checks. */
export const quantNodes: Node[] = [];

export class QuantMachine extends RuntimeMachine<Node, Node, Node> {
  constructor() {
    quantNodes.length = 0;
    const keep = (n: Node) => (quantNodes.push(n), n);
    super({
      createProducer: (value) => keep(createNode(null, value, 0)),
      createComputed: (compute) => keep(createNode(compute as Node["fn"], undefined, Flag.Dirty)),
      createWatcher: (compute) => keep(watcher(compute, false)),
      readProducer: (n) => read(n) as never,
      writeProducer: (n, value) => write(n, value),
      readComputed: (n) => read(n) as never,
      runWatcher: run,
      disposeWatcher: stop,
      // Batches only defer host notification; watchers here are unscheduled.
      enterBatch: () => undefined,
      leaveBatch: () => undefined,
    });
  }
}

export interface ThreeWay {
  readonly program: Program;
  readonly spec: Observation[];
  readonly contract: Observation[];
  readonly reflex: Observation[];
  readonly quant: Observation[];
  /** First operation index where the two traces differ, or -1. */
  readonly quantVsSpec: number;
  readonly quantVsContract: number;
  readonly reflexVsSpec: number;
  readonly reflexVsContract: number;
  readonly quantVsReflex: number;
  readonly contractVsSpec: number;
}

const firstDifference = (a: Observation[], b: Observation[]) => {
  for (let i = 0; i < a.length; i++) if (!observationsEqual(a[i]!, b[i]!)) return i;
  return -1;
};

export function runThreeWay(program: Program, after?: (op: Op, index: number) => void): ThreeWay {
  resetRuntimeContext();
  const machines = [new SpecMachine(), new ContractSpecMachine(), new ReflexMachine(), new QuantMachine()];
  const traces: Observation[][] = [[], [], [], []];
  program.operations.forEach((op, index) => {
    machines.forEach((m, k) => traces[k]!.push(m.execute(op)));
    after?.(op, index);
  });
  const [spec, contract, reflex, quant] = traces as [Observation[], Observation[], Observation[], Observation[]];
  return {
    program,
    spec,
    contract,
    reflex,
    quant,
    quantVsSpec: firstDifference(quant, spec),
    quantVsContract: firstDifference(quant, contract),
    reflexVsSpec: firstDifference(reflex, spec),
    reflexVsContract: firstDifference(reflex, contract),
    quantVsReflex: firstDifference(quant, reflex),
    contractVsSpec: firstDifference(contract, spec),
  };
}

export const brief = (trace: Observation[]) =>
  trace.map(
    (o) =>
      o.error?.message ??
      (o.value === undefined ? "-" : String(o.value)) +
        (o.effects.length ? `[${o.effects.map((e) => `${e.effect}:${e.phase}:${e.value}`).join(",")}]` : ""),
  );
