// Independent slow semantic/host model: Maps, unbounded versions and a Set
// queue. No Quant flags, intrusive pointers, generation or ring algorithms.
import {
  DomainError,
  type ImperativePort,
  type Scalar,
} from "./imperative-language";

export interface ModelNode {
  kind: "signal" | "computed" | "effect";
  value: Scalar;
  version: number;
  fn: (() => unknown) | undefined;
  cleanup: (() => void) | undefined;
  deps: Map<ModelNode, number>;
  attempt: Map<ModelNode, number>;
  retry: Map<ModelNode, number> | undefined;
  initialized: boolean;
  failed: boolean;
  pending: boolean;
  wake: boolean;
  redeliver: boolean;
  disposed: boolean;
  running: boolean;
  cleaning: boolean;
  validating: boolean;
}
interface Frame {
  node: ModelNode;
  reads: Map<ModelNode, number>;
}

export class ImperativeSpec implements ImperativePort<ModelNode> {
  readonly nodes: ModelNode[] = [];
  readonly queue = new Set<ModelNode>();
  readonly births = new Map<ModelNode, Map<ModelNode, number>>();
  invalid: string | undefined;
  hold = 0;
  private serial = 0;
  private collector: Frame | undefined;
  private deliveries = 0;
  constructor(readonly auto: boolean) {}
  private violate(message: string): never {
    this.invalid = message;
    throw new DomainError(message);
  }
  private node(
    kind: ModelNode["kind"],
    fn?: () => unknown,
    value?: Scalar,
  ): ModelNode {
    const node: ModelNode = {
      kind,
      fn,
      value,
      version: 0,
      cleanup: undefined,
      deps: new Map(),
      attempt: new Map(),
      retry: undefined,
      initialized: kind === "signal",
      failed: false,
      pending: kind === "effect",
      wake: kind === "effect",
      redeliver: false,
      disposed: false,
      running: false,
      cleaning: false,
      validating: false,
    };
    this.nodes.push(node);
    return node;
  }
  signal(value: Scalar) {
    return this.node("signal", undefined, value);
  }
  computed(fn: () => Scalar) {
    return this.node("computed", fn);
  }
  effect(fn: () => void | (() => void)) {
    const node = this.node("effect", fn);
    if (this.auto) {
      this.queue.add(node);
      try {
        this.flush();
      } catch (first) {
        try {
          this.dispose(node);
        } catch {
          /* first error owns rollback */
        }
        throw first;
      }
    }
    return node;
  }
  private observe(source: ModelNode) {
    const frame = this.collector;
    if (frame === undefined || frame.node.disposed || frame.reads.has(source))
      return;
    frame.reads.set(source, source.version);
    let subscribers = this.births.get(source);
    if (subscribers === undefined)
      this.births.set(source, (subscribers = new Map()));
    if (!subscribers.has(frame.node))
      subscribers.set(frame.node, ++this.serial);
  }
  private prune(node: ModelNode, keep: Set<ModelNode>) {
    for (const [source, subscribers] of this.births) {
      if (!keep.has(source)) subscribers.delete(node);
      if (subscribers.size === 0) this.births.delete(source);
    }
  }
  private invoke(node: ModelNode): {
    value: unknown;
    reads: Map<ModelNode, number>;
  } {
    if (node.running || node.validating)
      this.violate("C1 execution in progress");
    const frame = { node, reads: new Map<ModelNode, number>() };
    const previous = this.collector;
    this.collector = frame;
    node.running = true;
    try {
      return { value: node.fn!(), reads: frame.reads };
    } catch (error) {
      if (!node.disposed) {
        node.attempt = frame.reads;
        node.retry = this.retrySnapshot(node);
        this.prune(
          node,
          new Set([...node.deps.keys(), ...node.attempt.keys()]),
        );
      }
      throw error;
    } finally {
      node.running = false;
      this.collector = previous;
    }
  }
  private retrySnapshot(node: ModelNode): Map<ModelNode, number> {
    const result = new Map<ModelNode, number>();
    const visit = (source: ModelNode) => {
      if (result.has(source)) return;
      result.set(source, source.version);
      if (source.kind === "computed" && !source.disposed)
        for (const child of (source.retry ?? source.deps).keys()) visit(child);
    };
    for (const source of [...node.deps.keys(), ...node.attempt.keys()])
      visit(source);
    return result;
  }
  private validate(node: ModelNode, universal: boolean): boolean {
    if (node.running || node.validating)
      this.violate("C1 validation in progress");
    node.validating = true;
    try {
      return this.untracked(() => {
        let changed = false;
        for (const [source, observed] of node.deps) {
          if (source.kind === "computed") this.stabilize(source);
          if (source.version !== observed) {
            changed = true;
            if (!universal) break;
          }
        }
        return changed;
      });
    } finally {
      node.validating = false;
    }
  }
  private stabilize(node: ModelNode) {
    if (node.running || node.validating)
      this.violate("C1 demand on evaluation in progress");
    if (node.disposed) return;
    if (node.initialized && !node.failed) {
      let changed: boolean;
      try {
        changed = this.validate(node, false);
      } catch (error) {
        // F1: a failed demand commits nothing and owes execution next time,
        // including when the demand failed while validating the old frontier.
        if (!node.disposed) {
          node.failed = true;
          node.retry = this.retrySnapshot(node);
        }
        throw error;
      }
      // A child may dispose this validating ancestor (W3).
      if (node.disposed) return;
      if (!changed) {
        node.retry = undefined;
        return;
      }
    }
    try {
      const { value, reads } = this.invoke(node);
      if (node.disposed) return;
      if (!node.initialized || !Object.is(node.value, value)) {
        node.value = value as Scalar;
        node.version++;
      }
      node.deps = reads;
      node.attempt = new Map();
      node.retry = undefined;
      node.failed = false;
      node.initialized = true;
      this.prune(node, new Set(reads.keys()));
    } catch (error) {
      if (!node.disposed) {
        node.failed = true;
        node.retry ??= this.retrySnapshot(node);
      }
      throw error;
    }
  }
  read(node: ModelNode): Scalar {
    if (node.kind === "effect") this.violate("watcher is not readable");
    if (node.kind === "computed") this.stabilize(node);
    this.observe(node);
    return node.value;
  }
  write(node: ModelNode, value: Scalar) {
    if (node.kind !== "signal") this.violate("write requires a signal");
    if (Object.is(node.value, value)) return;
    node.value = value;
    node.version++;
    const visited = new Set<ModelNode>();
    const notify = (source: ModelNode) => {
      if (visited.has(source)) return;
      visited.add(source);
      const subscribers = [...(this.births.get(source) ?? [])].sort(
        (a, b) => a[1] - b[1],
      );
      for (const [consumer] of subscribers)
        if (!consumer.disposed) {
          if (consumer.kind === "effect") {
            consumer.wake = true;
            if (consumer.running || consumer.cleaning)
              consumer.redeliver = true;
            if (this.auto) this.queue.add(consumer);
          } else notify(consumer);
        }
    };
    notify(node);
    if (this.auto) this.flush();
  }
  run(node: ModelNode) {
    if (node.kind !== "effect") this.violate("run requires watcher");
    if (node.disposed || !node.wake) return;
    if (node.running || node.validating)
      this.violate("C1 watcher demand in progress");
    node.wake = false;
    const owedDelivery = node.redeliver;
    node.redeliver = false;
    if (node.retry !== undefined) {
      if (
        !owedDelivery &&
        ![...node.retry].some(
          ([source, observed]) => source.version !== observed,
        )
      )
        return;
      node.retry = undefined;
    }
    try {
      if (!node.initialized || this.validate(node, true)) node.pending = true;
    } catch (error) {
      node.wake = true;
      throw error;
    }
    if (!node.pending || node.disposed) return;
    if (node.cleanup !== undefined) {
      const cleanup = node.cleanup;
      node.cleanup = undefined;
      node.cleaning = true;
      try {
        this.untracked(cleanup);
      } catch (error) {
        if (!node.disposed) node.retry = this.retrySnapshot(node);
        throw error;
      } finally {
        node.cleaning = false;
      }
    }
    if (node.disposed) return;
    // An invalidation before the body begins is included in this attempt.
    // A new invalidation during the attempt creates a distinct W2 delivery.
    node.wake = false;
    node.redeliver = false;
    try {
      const { value, reads } = this.invoke(node);
      if (node.disposed) return;
      node.cleanup =
        typeof value === "function" ? (value as () => void) : undefined;
      node.deps = reads;
      node.attempt = new Map();
      node.retry = undefined;
      node.initialized = true;
      node.pending = false;
      this.prune(node, new Set(reads.keys()));
    } catch (error) {
      if (!node.disposed) {
        node.pending = true;
        node.retry ??= this.retrySnapshot(node);
      }
      throw error;
    }
  }
  dispose(node: ModelNode) {
    if (node.kind === "signal") this.violate("cannot dispose signal");
    if (node.disposed) return;
    const cleanup = node.cleanup;
    node.cleanup = undefined;
    node.disposed = true;
    node.fn = undefined;
    node.deps.clear();
    node.attempt.clear();
    node.retry = undefined;
    node.pending = false;
    node.redeliver = false;
    this.prune(node, new Set());
    if (cleanup !== undefined) this.untracked(cleanup);
  }
  flush() {
    if (!this.auto) {
      let first: unknown,
        failed = false;
      for (const node of this.nodes)
        if (node.kind === "effect" && !node.disposed) {
          try {
            this.run(node);
          } catch (error) {
            if (!failed) first = error;
            failed = true;
          }
        }
      if (failed) throw first;
      return;
    }
    if (this.hold > 0 || this.queue.size === 0) return;
    this.hold++;
    let first: unknown,
      failed = false;
    this.deliveries = 0;
    try {
      while (this.queue.size !== 0) {
        if (++this.deliveries > 10000) this.violate("delivery fuel exhausted");
        const node = this.queue.values().next().value!;
        this.queue.delete(node);
        try {
          this.run(node);
        } catch (error) {
          if (!failed) first = error;
          failed = true;
        }
      }
    } finally {
      this.hold--;
    }
    if (failed) throw first;
  }
  batch<T>(fn: () => T): T {
    this.hold++;
    let value: T;
    try {
      value = fn();
    } catch (first) {
      if (--this.hold === 0 && this.auto) {
        try {
          this.flush();
        } catch {
          /* body first */
        }
      }
      throw first;
    }
    if (--this.hold === 0 && this.auto) this.flush();
    return value;
  }
  untracked<T>(fn: () => T): T {
    const previous = this.collector;
    this.collector = undefined;
    try {
      return fn();
    } finally {
      this.collector = previous;
    }
  }
}
