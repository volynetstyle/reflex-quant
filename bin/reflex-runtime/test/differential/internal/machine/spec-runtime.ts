export type SpecCleanup = () => void;
export type SpecComputation<T> = () => T;

type Dependency = SpecProducer<unknown> | SpecComputed<unknown>;
type DependencySnapshot = Map<Dependency, number>;

interface DependencyState {
  /** True only after at least one successful computation has committed. */
  initialized: boolean;

  /**
   * The committed semantic dependency frontier from the last successful run.
   *
   * Each entry means: "this node successfully observed this direct dependency
   * at this semantic version".
   *
   * Failed attempts never replace or partially mutate this frontier.
   */
  dependencies: DependencySnapshot;

  /**
   * Conservative causal wake evidence captured after a failed lifecycle or
   * computation attempt.
   *
   * This is NOT a semantic dependency frontier and it is NOT an execution
   * obligation. It answers only:
   *
   *   "Has anything in the causal region of the failed attempt changed since
   *    failure, so trying the unresolved operation again may now be useful?"
   *
   * Therefore this snapshot may recursively cross computed boundaries. A
   * computed remains a semantic boundary for `dependencies`; recursive retry
   * evidence does not claim that an internal leaf changed the computed value.
   *
   * Versions are baselined at failure time, so a plain flush immediately after
   * cleanup/computation failure is suppressed until some retained causal
   * evidence changes.
   */
  retryDependencies: DependencySnapshot | undefined;
}

export interface SpecProducer<T> {
  readonly kind: "producer";
  value: T;

  /**
   * Semantic version. It changes iff the committed producer value changes under
   * Object.is.
   */
  version: number;
}

export interface SpecComputed<T> extends DependencyState {
  readonly kind: "computed";
  readonly compute: SpecComputation<T>;

  /** Last successfully committed semantic value. */
  value: T | undefined;

  /**
   * Semantic version of the committed value.
   *
   * Re-evaluation alone does not change this version. It advances only after a
   * successful Object.is-visible value change.
   */
  version: number;

  /**
   * Oracle-only validation cache keyed by the runtime-wide producer revision.
   *
   * This is an optimization of the executable model, not a semantic timestamp
   * and not observable behavior.
   */
  validatedAt: number;
}

export interface SpecWatcher extends DependencyState {
  readonly kind: "watcher";

  /** Undefined means terminally disposed. */
  compute: SpecComputation<void | SpecCleanup> | undefined;

  /**
   * Cleanup committed by the last successful watcher execution.
   *
   * Cleanup is irreversible lifecycle work. It is consumed before invocation
   * and can never be resurrected if cleanup itself throws.
   */
  cleanup: SpecCleanup | undefined;

  /**
   * Independent semantic obligation to execute this watcher.
   *
   * `executionPending` is established once execution has been justified:
   * - by initial execution, or
   * - by a confirmed semantic change in a committed dependency.
   *
   * It survives validation, cleanup and watcher-computation failures until a
   * watcher computation succeeds or the watcher is disposed.
   *
   * This is deliberately separate from:
   * - validation work: whether dependencies still need to be checked;
   * - retry evidence: whether a failed cold attempt is allowed to wake again.
   *
   * Production Reflex encodes this obligation with `Changed`; the oracle keeps
   * it explicit so correctness is not inferred indirectly from version mismatch.
   */
  executionPending: boolean;
}

/**
 * Deliberately slow executable correctness model.
 *
 * Semantic core:
 *
 *   committed value
 *   + semantic versions
 *   + committed direct dependency frontier
 *   + tentative observations
 *   + commit / abort
 *
 * Watcher semantics adds two independent obligations:
 *
 *   validation obligation
 *   + execution obligation
 *
 * Failure recovery adds a separate non-semantic mechanism:
 *
 *   conservative causal wake evidence
 *
 * The three facts that must never be conflated are:
 *
 *   causal change != semantic change != execution obligation
 *
 * In particular:
 *
 * - A computed is a semantic boundary for committed observations.
 * - Retry evidence may recursively cross that boundary because it only wakes a
 *   failed attempt; it does not assert downstream semantic change.
 * - Waking a failed watcher does not create its execution obligation. That
 *   obligation was established before the failed lifecycle/computation began
 *   and remains pending until successful completion.
 *
 * There is no subscriber graph, dirty-bit state machine, scheduler, push
 * propagation, edge reuse, cursor traversal, ownership or batching here.
 * Those are production refinements, not sources of observable truth.
 *
 * Correctness rules encoded by this model:
 *
 * 1. Successful dependency observations are tentative until their enclosing
 *    computation succeeds.
 * 2. Failed computation does not commit value, semantic version or dependency
 *    frontier.
 * 3. A computed is a semantic boundary: downstream commits only the computed's
 *    semantic version, never versions of its internal leaves.
 * 4. A computed read is observed only after successful stabilization: a
 *    computed read that throws is not a semantic dependency and not retry
 *    evidence. Failure creates no reactive evidence (R3, F18 boundary): a
 *    later repair of that computed's cause does not wake the enclosing failed
 *    attempt; re-entry is the host's decision.
 * 5. Watcher validation and execution are independent obligations.
 * 6. The complete committed watcher frontier must validate before irreversible
 *    watcher lifecycle begins, even when execution is already pending.
 * 7. Cleanup is consumed before invocation and cannot be resurrected on error.
 * 8. Failed cleanup/computation preserves an already-established watcher
 *    execution obligation.
 * 9. Retry evidence is a failure-time causal wake set only. It may recursively
 *    cross computed boundaries, but never becomes a semantic dependency
 *    frontier and never creates an execution obligation.
 *
 * The model assumes synchronous, acyclic evaluation. Writes during reactive
 * execution, scheduler ownership and cycle semantics are outside this oracle's
 * current boundary and must not be inferred from this implementation.
 */
export interface SpecRuntimeOptions {
  /**
   * Skip re-validating a computed when no producer changed since its last
   * successful validation (default true). The cache is an optimization of the
   * model and adds a hypothesis to it, so the direct model (`false`) must
   * agree with the cached one on every program
   * (runtime.spec-self-consistency.test.ts).
   */
  readonly validationCache?: boolean;
}

export class SpecRuntime {
  private readonly validationCache: boolean;

  constructor({ validationCache = true }: SpecRuntimeOptions = {}) {
    this.validationCache = validationCache;
  }

  /**
   * Monotone count of semantic producer writes.
   *
   * This only skips redundant computed validation when no producer anywhere in
   * the model could have changed since the last successful validation. It is an
   * oracle optimization, not part of node semantics.
   */
  private revision = 0;

  /**
   * Tentative dependency frontier of the computation currently being evaluated.
   * `undefined` means reads are intentionally untracked, for example cleanup.
   */
  private collector: DependencySnapshot | undefined;

  createProducer<T>(value: T): SpecProducer<T> {
    return {
      kind: "producer",
      value,
      version: 0,
    };
  }

  createComputed<T>(compute: SpecComputation<T>): SpecComputed<T> {
    return {
      kind: "computed",
      compute,
      value: undefined,
      version: 0,
      validatedAt: -1,
      ...createDependencyState(),
    };
  }

  createWatcher(compute: SpecComputation<void | SpecCleanup>): SpecWatcher {
    return {
      kind: "watcher",
      compute,
      cleanup: undefined,
      executionPending: false,
      ...createDependencyState(),
    };
  }

  readProducer<T>(node: SpecProducer<T>): T {
    // Producer reads cannot fail, so this is immediately a successful tentative
    // semantic observation.
    this.track(node);
    return node.value;
  }

  writeProducer<T>(node: SpecProducer<T>, value: T): void {
    // A no-op write is not a semantic change and is invisible downstream.
    if (Object.is(node.value, value)) return;

    node.value = value;
    node.version += 1;
    this.revision += 1;
  }

  readComputed<T>(node: SpecComputed<T>): T {
    /**
     * Stabilize before tracking.
     *
     * The outer computation observes a computed only if that computed actually
     * yields a stable semantic value. If stabilization throws, no semantic read
     * occurred: no direct dependency and no retry evidence is recorded (rule 4).
     */
    this.stabilize(node);
    this.track(node);

    return node.value as T;
  }

  runWatcher(node: SpecWatcher): void {
    /**
     * Resolve cold-retry wake and complete semantic validation before crossing
     * the irreversible cleanup boundary.
     *
     * `prepareWatcherRun()` may preserve an already-pending execution obligation
     * even when current validation finds no new semantic change. Wake, semantic
     * change and execution obligation are intentionally different facts.
     */
    if (!this.prepareWatcherRun(node)) return;

    if (node.cleanup !== undefined) {
      const cleanup = node.cleanup;

      // Consume before call. Throwing cleanup can never be invoked a second time
      // as though the failed lifecycle transition had rolled back.
      node.cleanup = undefined;

      try {
        // Cleanup reads are lifecycle work, never reactive observations.
        this.withCollector(undefined, cleanup);
      } catch (error) {
        /**
         * Execution was already justified before cleanup began. Keep that
         * obligation pending and only install a failure-time causal baseline to
         * prevent a hot plain-flush retry loop.
         */
        this.markRetry(node);
        throw error;
      }

      // Cleanup may dispose the watcher. Disposal is terminal.
      if (node.compute === undefined) return;
    }

    const compute = node.compute;
    if (compute === undefined) return;

    // Semantic reads of this attempt stay tentative until successful completion.
    const nextDependencies: DependencySnapshot = new Map();

    try {
      const cleanup = this.withCollector(nextDependencies, compute);

      /**
       * Successful watcher computation is the commit point:
       * - install the new cleanup,
       * - replace the committed semantic frontier,
       * - clear cold retry evidence,
       * - discharge the execution obligation.
       */
      node.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      node.dependencies = nextDependencies;
      node.retryDependencies = undefined;
      node.initialized = true;
      node.executionPending = false;
    } catch (error) {
      /**
       * Abort semantic commit.
       *
       * The previous committed frontier remains authoritative. Successful reads
       * from the failed attempt may contribute only to causal retry evidence.
       * The execution obligation remains pending because the justified watcher
       * run did not complete successfully.
       */
      this.markRetry(node, nextDependencies);
      throw error;
    }
  }

  disposeWatcher(node: SpecWatcher): void {
    // Disposal is terminal and idempotent, including when cleanup throws.
    if (node.compute === undefined) return;

    const cleanup = node.cleanup;

    /**
     * Commit disposal before invoking user cleanup so a throwing cleanup cannot
     * resurrect the watcher or make disposal repeatable.
     */
    node.compute = undefined;
    node.cleanup = undefined;
    node.executionPending = false;

    node.dependencies.clear();
    node.retryDependencies?.clear();
    node.retryDependencies = undefined;

    if (cleanup !== undefined) {
      // Disposal cleanup obeys the same rule as rerun cleanup: lifecycle reads
      // are untracked and cannot leak into an enclosing reactive computation.
      this.withCollector(undefined, cleanup);
    }
  }

  /**
   * Decide whether watcher lifecycle may begin.
   *
   * This method keeps three questions separate:
   *
   * 1. Causal wake:
   *    did something retained after a failed attempt change?
   *
   * 2. Semantic validation:
   *    can every committed dependency be validated successfully, and did any
   *    dependency prove a new execution obligation?
   *
   * 3. Execution obligation:
   *    is there already a justified watcher execution that has not successfully
   *    completed yet?
   */
  private prepareWatcherRun(node: SpecWatcher): boolean {
    if (node.compute === undefined) return false;

    if (node.retryDependencies !== undefined) {
      /**
       * Cold failure state: a plain flush is intentionally a no-op. A causal
       * change only grants permission to re-enter validation/attempt.
       */
      if (!this.retryEvidenceChanged(node.retryDependencies)) return false;

      /**
       * The cold retry gate has opened. Clear it BEFORE semantic validation.
       *
       * If validation now throws, that is a validation failure, not another cold
       * cleanup/computation failure. An explicit later flush must therefore be
       * able to retry validation without waiting for yet another causal change.
       */
      node.retryDependencies = undefined;

      if (!node.initialized) {
        // Initial execution failed before any semantic frontier was committed.
        // The original initial-execution obligation remains pending.
        return node.executionPending;
      }

      /**
       * Even though execution may already be pending, validate the complete
       * committed frontier before cleanup. Validation can discover another
       * throwing dependency and must finish before irreversible lifecycle work.
       */
      this.validateWatcherDependencies(node);
      return node.executionPending;
    }

    if (!node.initialized) {
      // Initial watcher execution is itself an execution obligation.
      node.executionPending = true;
      return true;
    }

    this.validateWatcherDependencies(node);
    return node.executionPending;
  }

  /**
   * Validate the entire committed watcher frontier.
   *
   * Every confirmed direct semantic change establishes `executionPending`.
   * Once established, the obligation is monotone until successful watcher
   * computation or disposal.
   *
   * Do NOT early-return after the first change. A later dependency may throw,
   * and watcher cleanup must not begin until the complete frontier validates.
   */
  private validateWatcherDependencies(node: SpecWatcher): void {
    for (const [dependency, observedVersion] of node.dependencies) {
      if (dependency.kind === "computed") {
        this.stabilize(dependency);
      }

      if (dependency.version !== observedVersion) {
        node.executionPending = true;
      }
    }
  }

  private stabilize<T>(node: SpecComputed<T>): void {
    // If no producer anywhere changed since this node's last validation, its
    // committed frontier cannot have become stale.
    if (
      this.validationCache &&
      node.initialized &&
      node.validatedAt === this.revision
    ) {
      return;
    }

    if (node.initialized) {
      let changed: boolean;

      try {
        changed = this.dependenciesChanged(node.dependencies);
      } catch (error) {
        /**
         * Validation failed before this computed could begin a new semantic
         * commit. Keep committed value/frontier untouched.
         *
         * The computed's recursive retry evidence is useful only as causal data
         * if an enclosing watcher/computed failure later snapshots this node.
         */
        this.markRetry(node);
        throw error;
      }

      if (!changed) {
        // Freshness validation commits only the oracle validation cache.
        node.validatedAt = this.revision;
        node.retryDependencies = undefined;
        return;
      }
    }

    // Recompute against a fresh tentative direct dependency frontier.
    const nextDependencies: DependencySnapshot = new Map();

    try {
      const nextValue = this.withCollector(nextDependencies, node.compute);

      /**
       * Re-evaluation is not semantic change. Only a successfully computed value
       * that differs under Object.is advances the semantic version.
       */
      if (!node.initialized || !Object.is(node.value, nextValue)) {
        node.value = nextValue;
        node.version += 1;
      }

      // Successful evaluation commits value/frontier atomically in this model.
      node.dependencies = nextDependencies;
      node.retryDependencies = undefined;
      node.initialized = true;
      node.validatedAt = this.revision;
    } catch (error) {
      /**
       * Abort value/version/frontier commit. Partial successful direct reads are
       * not semantic dependencies, but they may be retained as causal retry
       * evidence for an enclosing failed attempt.
       */
      this.markRetry(node, nextDependencies);
      throw error;
    }
  }

  /**
   * Semantic dependency validation for computeds.
   *
   * This deliberately validates the ENTIRE direct frontier rather than
   * returning after the first mismatch. A later dependency may throw and that
   * failure must remain observable.
   */
  private dependenciesChanged(dependencies: DependencySnapshot): boolean {
    let changed = false;

    for (const [dependency, observedVersion] of dependencies) {
      if (dependency.kind === "computed") {
        this.stabilize(dependency);
      }

      if (dependency.version !== observedVersion) {
        changed = true;
      }
    }

    return changed;
  }

  /**
   * Causal wake test.
   *
   * This is intentionally NOT semantic validation:
   * - no computed is stabilized here;
   * - no semantic-change conclusion is produced;
   * - no execution obligation is created.
   *
   * It only checks whether any failure-time causal version changed.
   */
  private retryEvidenceChanged(dependencies: DependencySnapshot): boolean {
    for (const [dependency, observedVersion] of dependencies) {
      if (dependency.version !== observedVersion) return true;
    }

    return false;
  }

  private markRetry(
    node: Pick<DependencyState, "dependencies" | "retryDependencies">,
    partial?: DependencySnapshot,
  ): void {
    node.retryDependencies = this.retrySnapshot(node.dependencies, partial);
  }

  /**
   * Capture a conservative failure-time causal wake set.
   *
   * Recursive traversal is intentional. This map is not a semantic dependency
   * frontier, so crossing a computed boundary does not assert that the leaf is a
   * direct semantic input of the outer node.
   *
   * At each computed:
   * - if it is itself recovering from failure, follow its retry evidence;
   * - otherwise follow its last committed semantic frontier.
   *
   * Every version is sampled at FAILURE TIME. Therefore the change that already
   * caused the failed attempt is consumed into the baseline and cannot create an
   * immediate retry loop.
   */
  private retrySnapshot(
    committed: DependencySnapshot,
    partial?: DependencySnapshot,
  ): DependencySnapshot {
    const snapshot: DependencySnapshot = new Map();

    const visit = (dependency: Dependency): void => {
      if (snapshot.has(dependency)) return;

      snapshot.set(dependency, dependency.version);

      if (dependency.kind !== "computed") return;

      const nested = dependency.retryDependencies ?? dependency.dependencies;

      for (const child of nested.keys()) {
        visit(child);
      }
    };

    // Previous committed dependencies remain causally relevant to the unresolved
    // operation even though retry state is not itself a semantic frontier.
    for (const dependency of committed.keys()) {
      visit(dependency);
    }

    // Successful direct reads from the failed attempt are not committed, but
    // they can conservatively explain what later change may make retry useful.
    if (partial !== undefined) {
      for (const dependency of partial.keys()) {
        visit(dependency);
      }
    }

    return snapshot;
  }

  private track(node: Dependency): void {
    /**
     * Re-reading the same dependency refreshes the semantic version observed by
     * the current tentative attempt.
     *
     * Only successfully stabilized computed reads reach this method.
     */
    this.collector?.set(node, node.version);
  }

  private withCollector<T>(
    collector: DependencySnapshot | undefined,
    computation: SpecComputation<T>,
  ): T {
    const previous = this.collector;
    this.collector = collector;

    try {
      return computation();
    } finally {
      // Nested evaluation always restores the outer tentative frontier.
      this.collector = previous;
    }
  }
}

function createDependencyState(): DependencyState {
  return {
    initialized: false,
    dependencies: new Map(),
    retryDependencies: undefined,
  };
}
