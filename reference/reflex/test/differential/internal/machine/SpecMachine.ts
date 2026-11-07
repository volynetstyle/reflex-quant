import type { Value } from "../../api";

import type { RuntimePort } from "./RuntimeMachine";
import { RuntimeMachine } from "./RuntimeMachine";
import type { SpecProducer, SpecComputed, SpecWatcher } from "./spec-runtime";
import { SpecRuntime } from "./spec-runtime";

export interface SpecRuntimePort {
  createProducer<T>(value: T): SpecProducer<T>;
  createComputed<T>(compute: () => T): SpecComputed<T>;
  createWatcher(compute: () => void | (() => void)): SpecWatcher;
  readProducer<T>(node: SpecProducer<T>): T;
  writeProducer<T>(node: SpecProducer<T>, value: T): void;
  readComputed<T>(node: SpecComputed<T>): T;
  runWatcher(node: SpecWatcher): void;
  disposeWatcher(node: SpecWatcher): void;
}

export class SpecMachine extends RuntimeMachine<
  SpecProducer<Value>,
  SpecComputed<Value>,
  SpecWatcher
> {
  constructor(runtime: SpecRuntimePort = new SpecRuntime()) {
    super({
      createProducer: (value) => runtime.createProducer(value),
      createComputed: (compute) => runtime.createComputed(compute),
      createWatcher: (compute) => runtime.createWatcher(compute),

      readProducer: (node) => runtime.readProducer(node),
      writeProducer: (node, value) => runtime.writeProducer(node, value),
      readComputed: (node) => runtime.readComputed(node),

      runWatcher: (node) => runtime.runWatcher(node),
      disposeWatcher: (node) => runtime.disposeWatcher(node),
      // The spec observes explicit flushes and values. Batch boundaries only
      // defer Reflex's host idle notification, which is outside this oracle.
      enterBatch: () => undefined,
      leaveBatch: () => undefined,
    } satisfies RuntimePort<
      SpecProducer<Value>,
      SpecComputed<Value>,
      SpecWatcher
    >);
  }
}
