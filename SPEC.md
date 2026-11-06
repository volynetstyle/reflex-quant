# SPEC: quant

Instructions for coding and research agents working on Quant.

## Research objective

Quant is an experiment in deriving the **smallest known runtime architecture implied by the Quant contract**.

It is not:

- a feature-complete signals library;
- a smaller clone of any existing runtime;
- an Alien Signals compatibility layer;
- a collection of useful reactive features;
- a framework runtime.

The research question is:

> Given the frozen Quant contract (semantic invariants plus structural bounds), what is the smallest known mechanism set that realizes them?

“Smallest” is always relative to the declared contract, structural bounds, and machine model. It does not mean minimum line count, minimum API surface, or minimum object size in isolation.

## Quant contract

Quant owns its contract. The contract is a **frozen local research object**: the invariants below, executed by `test/support/contract-spec.ts`, plus the structural bounds. It is not a mirror of any other runtime.

Provenance (where each obligation was originally taken from, the source snapshot, exclusions, and deviations from the source) is research history and lives only in `research/REPORT.md`. It carries no authority.

Nothing outside this contract defines correctness: not this prose, not explanatory documents, not the current implementation, not another runtime, not a framework convention, not a benchmark. An external behavior change is evidence only. To adopt it:

1. state the invariant it would add or change;
2. show it belongs to the research question;
3. justify the contract change explicitly;
4. update the executable contract and `research/REPORT.md` before changing the runtime.

### Semantic invariants

Graph and tracking
- **T1 exact tracking.** A computation observes exactly the sources it read; dynamic branches add and drop relations.
- **T2 relation uniqueness.** One relation per (source, consumer) pair, under repeats, reorders, nesting, and failures.
- **T3 nesting isolation.** Nested evaluation never corrupts the outer pass.

Change and propagation
- **P1 change is a version fact.** Decided by `Object.is` at commit; A→B→A counts as a change.
- **P2 cutoff.** An unchanged computed does not propagate.
- **P3 glitch freedom.** No inconsistent intermediate observation; one execution per node per wave.
- **P4 validate is not execute.** A watcher validates its whole committed source set before any lifecycle step.

Failure
- **F1 failed computed.** A failed computed commits nothing and executes on its next demand.
- **F2 failed read.** A read that threw is not an observation.
- **F3 failed watcher.** It is cold and wakes on committed sources ∪ last-attempt reads.
- **F4 obligation survives.** An execution obligation survives a failure.

Watchers and lifecycle
- **W1 cleanup first.** The previous cleanup is consumed before a rerun.
- **W2 self-invalidation.** A watcher invalidated during its own run is delivered again; cutoff stays exact.
- **W3 disposal.** Terminal; cleanup runs after teardown; no ghost relations; safe inside the node's own pass.
- **W4 batching.** Defers watcher execution only.

### Contract decisions

- **D1 universal validation.** Computed validation checks the whole frontier: if an earlier source changed and a later one now throws, validation throws.
- **D2 failed computed re-entry.** A failed computed whose old frontier now throws validates that frontier first, rather than executing.

### Structural bounds

- **S1** no allocation and no lookup per stable read;
- **S2** no new relation when one already exists;
- **S3** no Θ(d²) tracking;
- **S4** graph size proportional to live relations;
- **S5** repeated failures do not accumulate relations;
- **S6** nesting does not rebuild global state;
- **S7** traversal is bounded and stack-safe.

### Order of evidence

1. Semantic invariants, as executed by `test/support/contract-spec.ts`.
2. Structural bounds, as encoded by graph-integrity, complexity, allocation, stack-depth, and bounded-work tests.
3. Research evidence in `research/LOG.md` and `research/REPORT.md`.
4. Performance evidence from controlled benchmarks and structural counters.
5. Other runtimes (Alien Signals, Vue, Preact, Solid, proposed standards).

Other runtimes are counterexample generators and workload sources. They create no obligations.

## Architectural boundary

Quant separates four concerns.

### 1. Kernel mechanism

The kernel mechanism spans `src/model.ts`, `src/flags.ts`, `src/graph.ts`,
`src/tracking.ts`, and `src/kernel.ts`. The model defines types, flags declares
the bit layout, graph contains context-independent operations, and tracking
resolves dependencies. The kernel owns execution context, stack-dependent
tracking, propagation, and validation; slot walks and edge creation remain
there because they mutate the shared work stack.
These source boundaries do not introduce runtime state or indirection. The
release build bundles them into a standalone module per format, with research
instrumentation eliminated; the release check verifies these properties.

The kernel mechanism owns facts intrinsic to maintaining the reactive dependency graph and satisfying the selected contract:

- dependency relations and graph integrity;
- exact dynamic dependency tracking;
- relation uniqueness;
- invalidation evidence;
- lazy validation and recomputation;
- change/cutoff detection;
- failure bookkeeping required to preserve committed reactive evidence;
- graph-safe disposal primitives;
- bounded traversal and stack-safety;
- notification of the host when externally scheduled work becomes eligible.

A mechanism belongs here only when a semantic or structural obligation forces some mechanism of that kind.

### 2. Reference host policy

`src/host.ts` owns policy required to realize the selected watcher contract:

- watcher delivery;
- queue ownership and draining;
- cleanup execution lifecycle;
- retry delivery required by the contract;
- batching where the contract says batching defers watcher execution.

Here **cleanup lifecycle** means only the observable lifecycle of one watcher required by the selected contract: when its previously returned cleanup is consumed, whether it runs tracked or untracked, and its ordering relative to rerun or disposal.

It does **not** mean ownership of multiple effects, cleanups, resources, components, or scopes. Deciding that a component, scope, or parent effect owns other reactive objects is framework/lifecycle policy and remains outside the Quant boundary.

The host may decide **when** eligible watcher work runs. The kernel decides only **what reactive evidence exists** and when the host must be notified.

Do not move scheduling, ownership, or lifecycle policy into the kernel merely because another runtime does so.

### 3. Surface API

`src/index.ts` exposes the existing machine through handles and convenience operations.

The surface must not invent new reactive semantics.

An ergonomic API difference is not evidence for a new kernel mechanism.

### 4. Framework and application policy

The following are outside the Quant research boundary unless a new contract or structural obligation explicitly brings them in:

- effect scopes;
- nested-effect ownership;
- component or subtree lifetime;
- ownership of groups of effects, cleanups, or resources;
- DOM/render scheduling;
- framework execution contexts;
- asynchronous resource semantics;
- loading, pending, or blocker protocols;
- retry delays, backoff, authentication, or error UI policy;
- transactional/forked application state;
- manual invalidation APIs for mutable containers;
- automatic liveness or dependency-cone suspension.

A watcher executing its own previous cleanup according to the selected contract belongs to the reference host. A framework deciding **which larger owner controls that watcher or cleanup** does not.

These may be good designs. That does not make them consequences of the Quant contract.

## Admission rule for a core mechanism

A new persistent field, state bit, relation field, index, edge class, global register, traversal phase, lifecycle rule, or algorithmic subsystem counts as a **mechanism**.

Do not add a mechanism unless all of the following are recorded:

1. **Obligation**  
   Name the semantic invariant or structural bound that must hold.

2. **Witness**  
   Provide a minimized program, graph, or workload that violates the obligation without the mechanism.

3. **Failure mode**  
   Show exactly what breaks: observable semantics, graph integrity, uniqueness, asymptotic work, retained memory, allocation bound, or stack-depth bound.

4. **Alternatives**  
   Consider simpler repairs. A mutant killed by a test proves that the current implementation needs a replacement for that behavior; it does **not** prove that the removed implementation mechanism is uniquely necessary.

5. **Minimal repair**  
   Prefer the smallest known mechanism satisfying the obligation under Quant's machine and cost model.

6. **Layer**  
   State why the repair belongs in the kernel rather than the host, surface, or framework layer.

7. **Evidence**  
   Add the test, structural counter, proof argument, or benchmark that keeps the claim falsifiable.

If no semantic or structural witness exists, reject the mechanism from the derived core.

## Semantic-neutral optimizations

A local optimization may be accepted without being a derived mechanism when it:

- preserves the exact semantic contract;
- preserves all structural bounds;
- introduces no new observable lifecycle or ownership semantics;
- introduces no new persistent semantic state unless independently justified;
- has repeated measurement evidence for a material improvement.

Examples include bounded fast paths, proven absence shortcuts, pointer cleanup that prevents garbage retention, and equivalent machine-code reshaping.

Such optimizations must be classified as **optimization**, not counted as mechanisms forced by the contract.

A benchmark win can choose between admissible implementations. It cannot expand the semantic contract.

## Conventions

An implementation choice may remain for determinism or reproducibility even when the contract does not require it.

Examples include unspecified sibling ordering.

Classify these as **conventions**.

A convention:

- is not a semantic invariant;
- is not evidence of a required mechanism;
- must not be counted in the derived mechanism basis;
- may be changed if semantic and structural obligations remain intact.

Tests that intentionally pin a convention must be identified as representation or convention tests, not semantic proofs.

## External runtimes

Treat Alien Signals, Vue, Preact, Solid, TC39 Signals, and other systems as **counterexample generators and alternative-design evidence**, not specifications.

When another runtime has a feature Quant lacks:

1. identify the problem the feature solves;
2. express that problem as a minimal witness;
3. determine whether the witness lies inside Quant's selected contract or structural model;
4. if it does not, make no architectural change;
5. if it does, derive the smallest repair independently.

Do not import a solution before establishing that Quant has the problem.

Feature parity is explicitly not a goal.

## Contract boundary

Only behavior stated in the Quant contract, or a declared structural bound, creates an obligation. A feature existing elsewhere does not.

Distinguish:

- reactive graph semantics;
- observable watcher semantics in the contract;
- structural/runtime constraints;
- host scheduling policy;
- integration helpers;
- framework policy.

## Minimality claims

Use precise language.

A successful ablation means:

> this implementation, with this mechanism removed and no replacement, violates a named obligation.

It does not by itself mean:

> every correct implementation must contain this exact mechanism.

Prefer claims such as:

- “required by the current architecture under the stated cost model”;
- “smallest known repair for this witness”;
- “the contract requires equivalent information”;
- “a per-relation fact is required by the lower-bound argument”.

Reserve stronger necessity claims for cases with an actual lower-bound or representation-independent argument.

## Classification of changes

Every nontrivial change should be classified as one of:

- **semantic mechanism** — required by the selected observable contract;
- **structural mechanism** — required by a graph/resource/asymptotic bound;
- **optimization** — semantics-preserving constant-factor improvement;
- **convention** — deterministic representation choice not required by the contract;
- **implementation lemma** — needed only by the chosen construction, not by the contract;
- **safety contract** — chosen guarantee against lost execution, graph corruption, or stack death;
- **host policy** — scheduling or single-watcher lifecycle realization outside graph semantics;
- **surface API** — exposes existing semantics only;
- **framework/application policy** — ownership or behavior not implied by the selected contract;
- **out of scope** — useful behavior unrelated to the research question.

Do not silently promote an optimization, convention, host policy, or framework policy into a derived mechanism.

## Research workflow

Before implementing a proposed mechanism:

- locate or construct its witness;
- identify its exact semantic source or structural obligation;
- classify the violated obligation;
- test the simpler machine without it;
- consider alternative repairs;
- implement the smallest surviving repair;
- add the evidence to `research/LOG.md`;
- update `research/REPORT.md` if the mechanism basis or architectural claim changes;
- add or update semantic/structural tests before using benchmarks as evidence.

`research/mutants.mjs` is evidence about necessity within the tested architecture. It is not an oracle of universal architectural necessity.

## Performance rule

Performance work happens **inside** the admissible semantic and structural design space.

Do not:

- weaken semantics to win a benchmark;
- add framework semantics to match a competitor benchmark;
- introduce an index, cache, ownership model, or lifecycle rule solely because another runtime uses it;
- treat a competitor's faster behavior as evidence that Quant is missing a feature.

First determine whether the performance problem exists under Quant's own obligations. Then optimize that problem.

> Benchmarks select among admissible implementations; they do not define the admissible semantics.

## Examples

`effectScope` and nested-effect ownership solve lifetime-management problems. They are not implied by Quant's dependency-graph contract.

A watcher running the cleanup returned by its own previous successful execution is different: cleanup ordering is part of the selected watcher contract and is therefore implemented by the reference host.

Transactional pending writes change the semantics of batching and source commitment. They are not an optimization of Quant's current write semantics.

A generic “became unwatched” event may be useful in other signal systems, but usefulness alone does not admit it. The Quant contract admits retained dependency subscriptions; Quant needs an independent semantic or structural witness before introducing liveness semantics.

Clearing pointers from detached edges does not add reactive semantics. If stale intrusive pointers retain garbage across collections, severing them is a structural/resource-correctness repair.

A cheap exact fast path that avoids an expensive fallback without changing any answer is an optimization, not a new semantic mechanism.

## Working principle

> Competitors are sources of counterexamples, not sources of obligations.

## Non-goal

Do not make Quant more capable merely because capability is available.

The experiment succeeds when unnecessary machinery can be removed while the declared obligations remain true.
