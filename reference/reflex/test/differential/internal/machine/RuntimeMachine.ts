import type {
  Machine,
  NodeId,
  EffectEvent,
  Op,
  Observation,
  Value,
  Expr,
} from "../../api";
import { normalizeError, evaluate } from "./eval";

export interface RuntimePort<P, C, W> {
  createProducer(value: Value): P;
  createComputed(compute: () => Value): C;
  createWatcher(compute: () => void | (() => void)): W;

  readProducer(node: P): Value;
  writeProducer(node: P, value: Value): void;
  readComputed(node: C): Value;

  runWatcher(node: W): void;
  disposeWatcher(node: W): void;
  enterBatch(): void;
  leaveBatch(): void;
}

export type RuntimeNode<P, C, W> =
  | { kind: "producer"; node: P }
  | { kind: "computed"; node: C }
  | { kind: "watcher"; node: W };

export class RuntimeMachine<P, C, W> implements Machine {
  private readonly nodes = new Map<NodeId, RuntimeNode<P, C, W>>();
  private readonly watchers = new Map<NodeId, W>();

  private effects: EffectEvent[] = [];

  constructor(private readonly runtime: RuntimePort<P, C, W>) {}

  execute(op: Op): Observation {
    this.effects = [];

    try {
      const value = this.executeUnsafe(op);

      return value === undefined
        ? { effects: this.effects }
        : { value, effects: this.effects };
    } catch (error) {
      return {
        error: normalizeError(error),
        effects: this.effects,
      };
    }
  }

  private executeUnsafe(op: Op): Value | undefined {
    switch (op.type) {
      case "signal":
        this.assertNew(op.id);

        this.nodes.set(op.id, {
          kind: "producer",
          node: this.runtime.createProducer(op.value),
        });

        return;

      case "computed":
        this.assertNew(op.id);

        this.nodes.set(op.id, {
          kind: "computed",
          node: this.runtime.createComputed(() =>
            evaluate(op.expression, (id) => this.read(id)),
          ),
        });

        return;

      case "effect": {
        this.assertNew(op.id);

        const watcher = this.runtime.createWatcher(
          this.effectCallback(op.id, op.expression, op.cleanup),
        );

        this.nodes.set(op.id, {
          kind: "watcher",
          node: watcher,
        });

        this.watchers.set(op.id, watcher);
        return;
      }

      case "set":
        this.runtime.writeProducer(this.producer(op.id), op.value);
        return;

      case "read":
        return this.read(op.id);

      case "flush":
        for (const watcher of this.watchers.values()) {
          this.runtime.runWatcher(watcher);
        }
        return;

      case "enterBatch":
        this.runtime.enterBatch();
        return;

      case "leaveBatch":
        this.runtime.leaveBatch();
        return;

      case "dispose":
        this.runtime.disposeWatcher(this.watcher(op.id));
        this.watchers.delete(op.id);
        return;
    }
  }

  private effectCallback(
    id: NodeId,
    expression: Expr,
    cleanup?: Expr,
  ): () => void | (() => void) {
    return () => {
      this.effects.push({
        effect: id,
        phase: "run",
        value: evaluate(expression, (node) => this.read(node)),
      });

      if (cleanup === undefined) return;

      return () => {
        this.effects.push({
          effect: id,
          phase: "cleanup",
          value: evaluate(cleanup, (node) => this.read(node)),
        });
      };
    };
  }

  private read(id: NodeId): Value {
    const entry = this.node(id);

    switch (entry.kind) {
      case "producer":
        return this.runtime.readProducer(entry.node);

      case "computed":
        return this.runtime.readComputed(entry.node);

      case "watcher":
        throw new TypeError(`Cannot read watcher '${id}'`);
    }
  }

  private producer(id: NodeId): P {
    const entry = this.node(id);

    if (entry.kind !== "producer") {
      throw new TypeError(`'${id}' is not a signal`);
    }

    return entry.node;
  }

  private watcher(id: NodeId): W {
    const entry = this.node(id);

    if (entry.kind !== "watcher") {
      throw new TypeError(`'${id}' is not an effect`);
    }

    return entry.node;
  }

  private node(id: NodeId): RuntimeNode<P, C, W> {
    const entry = this.nodes.get(id);

    if (entry === undefined) {
      throw new ReferenceError(`Unknown node '${id}'`);
    }

    return entry;
  }

  private assertNew(id: NodeId): void {
    if (this.nodes.has(id)) {
      throw new Error(`Duplicate node '${id}'`);
    }
  }
}
