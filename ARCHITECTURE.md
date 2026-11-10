# Quant architecture and research rules

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

The frozen obligations are in [CONTRACT.md](CONTRACT.md).

## Order of evidence

1. Semantic invariants, as executed by `test/support/contract-spec.ts`.
2. Structural bounds, as encoded by graph-integrity, complexity, allocation, stack-depth, and bounded-work tests.
3. Research evidence in `research/LOG.md` and `research/REPORT.md`.
4. Performance evidence from controlled benchmarks and structural counters.
5. Other runtimes (Alien Signals, Vue, Preact, Solid, proposed standards).

Other runtimes are counterexample generators and workload sources. They create no obligations.

## Architectural boundary

Quant separates four concerns.

### 1. Kernel mechanism

The kernel consists of the graph representation in `src/graph.ts` and the
machine in `src/kernel.ts`. The graph holds node and edge types, flags and
local intrusive-list operations. The machine owns execution context,
dependency tracking, propagation and validation, including the work stack.
The release build bundles these into a standalone module per format, with
research instrumentation and development diagnostics eliminated; a separate
development build keeps the diagnostics. The release check verifies these
properties and that only the development build diagnoses a precondition.

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

#### State lifetime in the current construction

Persistent state must carry a fact needed after the current phase that cannot
be reconstructed from graph topology, execution context or committed evidence
within the structural bounds. A recoverable phase fact does not need a node
field or flag (research/LOG.md, entry 43).

- Nodes and edges retain graph relations, semantic state, observed versions
  and committed/tentative evidence (`Node.gen`, `Edge.gen`, `SETTLE`).
- `active` and `cursor` belong to one execution. Nested execution saves and
  restores both on success and failure; `untracked` suspends `active` while
  preserving the enclosing cursor.
- An indexed pass owns its cursor's source slot:
  `cursor !== null && cursor.from.slot === cursor`. The displaced-edge stack
  restores this certificate before an enclosing execution resumes.
- All remaining `UNREAD` edges form a continuous dependency suffix. Its head's
  `ver === UNREAD` certifies that it is already marked. Consuming, moving or
  inserting an edge preserves this shape; failure prunes tentative edges
  without breaking it.
- The shared work stack stores an existing `Edge` for each suspended walk or
  displaced slot. `edge.from` already identifies the displaced source.

These are implementation lemmas of the current generation-based construction,
not a proof that every correct runtime must use this representation. In
particular, overloading `Edge.ver` with tentative state would require a new
proof of the unread-suffix certificate and S3. Watcher delivery remains a
separate kernel/host protocol: `Woken` and `Queued` are not merged by these
tracking lemmas.

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
- **development diagnostic** — detects the breach of a precondition in the development build only; compiled out of the production build, so it is no mechanism and is not counted in the mechanism basis;
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
