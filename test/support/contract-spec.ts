// The executable spec with exactly two documented changes, so that every
// difference between quant and the spec can be attributed:
//
//  D1  computed validation is existential: the first changed committed
//      source proves the computed must execute (MODEL §4 "Quantifiers"),
//      where the spec validates the whole frontier;
//  D2  a computed whose last evaluation failed executes on its next demand
//      without validating its old frontier first (SEMANTIC_CONTRACT C3:
//      "its next demand executes the callback exactly once").
//
// Everything else is inherited unchanged from SpecRuntime.
import { SpecRuntime, type SpecComputed } from "../../../reflex-runtime/test/differential/internal/machine/spec-runtime";
import { SpecMachine } from "../../../reflex-runtime/test/differential/internal/machine/SpecMachine";

type Internals = {
  validationCache: boolean;
  revision: number;
  withCollector<T>(collector: Map<unknown, number> | undefined, fn: () => T): T;
  markRetry(node: unknown, partial?: Map<unknown, number>): void;
};

const failed = new WeakSet<object>();

export class ContractSpecRuntime extends SpecRuntime {
  constructor(private readonly d1 = true, private readonly d2 = true) {
    super();
    const self = this as unknown as Record<string, unknown>;
    self.dependenciesChanged = (deps: Map<SpecComputed<unknown> | { kind: "producer"; version: number }, number>) =>
      this.changed(deps);
    self.stabilize = (node: SpecComputed<unknown>) => this.stabilizeContract(node);
  }

  private changed(deps: Map<{ kind: string; version: number }, number>): boolean {
    let changed = false;
    for (const [dependency, observed] of deps) {
      if (dependency.kind === "computed") (this as unknown as { stabilize(n: unknown): void }).stabilize(dependency);
      if (dependency.version !== observed) {
        if (this.d1) return true;
        changed = true;
      }
    }
    return changed;
  }

  private stabilizeContract<T>(node: SpecComputed<T>): void {
    const self = this as unknown as Internals;
    const mustExecute = this.d2 && failed.has(node);
    if (!mustExecute && self.validationCache && node.initialized && node.validatedAt === self.revision) return;
    if (!mustExecute && node.initialized) {
      let changed: boolean;
      try {
        changed = this.changed(node.dependencies as never);
      } catch (error) {
        self.markRetry(node);
        throw error;
      }
      if (!changed) {
        node.validatedAt = self.revision;
        node.retryDependencies = undefined;
        return;
      }
    }
    const next = new Map<unknown, number>();
    try {
      const value = self.withCollector(next, node.compute);
      if (!node.initialized || !Object.is(node.value, value)) {
        node.value = value;
        node.version += 1;
      }
      node.dependencies = next as never;
      node.retryDependencies = undefined;
      node.initialized = true;
      node.validatedAt = self.revision;
      failed.delete(node);
    } catch (error) {
      self.markRetry(node, next);
      failed.add(node);
      throw error;
    }
  }
}

export class ContractSpecMachine extends SpecMachine {
  constructor() {
    super(new ContractSpecRuntime());
  }
}
