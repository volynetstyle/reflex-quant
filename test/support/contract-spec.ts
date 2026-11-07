// The executable spec with three documented changes (D1, D2, D6), so that every
// difference between quant and the spec can be attributed:
//
//  D1  computed validation is existential: the first changed committed
//      source proves the computed must execute (MODEL §4 "Quantifiers"),
//      where the spec validates the whole frontier;
//  D2  a computed whose last evaluation failed executes on its next demand
//      without validating its old frontier first (SEMANTIC_CONTRACT C3:
//      "its next demand executes the callback exactly once");
//  D6  in-pass invalidation (SPEC P5): a relation keeps the version of its
//      source's first observation in an execution, and the execution is
//      validated as of its start. The spec's track() refreshes the version
//      on every reread, and its validation cache stamps the revision after
//      the execution, so a change the execution makes itself is never seen.
//      The program language has no write inside a computation, so no corpus
//      program can tell D6 apart; test/semantics.test.ts (P5, F1) executes
//      the invariant through the public API.
//
// Everything else is inherited unchanged from SpecRuntime.
import { SpecRuntime, type SpecComputed } from "../../reference/reflex/test/differential/internal/machine/spec-runtime";
import { SpecMachine } from "../../reference/reflex/test/differential/internal/machine/SpecMachine";

type Internals = {
  validationCache: boolean;
  revision: number;
  collector: Map<unknown, number> | undefined;
  withCollector<T>(collector: Map<unknown, number> | undefined, fn: () => T): T;
  markRetry(node: unknown, partial?: Map<unknown, number>): void;
};

const failed = new WeakSet<object>();

export class ContractSpecRuntime extends SpecRuntime {
  constructor(private readonly d1 = true, private readonly d2 = true, private readonly d6 = true) {
    super();
    const self = this as unknown as Record<string, unknown>;
    if (d6) {
      const internals = this as unknown as Internals;
      self.track = (node: { version: number }) => {
        const collector = internals.collector;
        if (collector !== undefined && !collector.has(node)) collector.set(node, node.version);
      };
    }
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
    // D6: the execution is validated as of its start, so a change it makes
    // itself (after observing the source) is seen by the next demand.
    const start = self.revision;
    try {
      const value = self.withCollector(next, node.compute);
      if (!node.initialized || !Object.is(node.value, value)) {
        node.value = value;
        node.version += 1;
      }
      node.dependencies = next as never;
      node.retryDependencies = undefined;
      node.initialized = true;
      node.validatedAt = this.d6 ? start : self.revision;
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
