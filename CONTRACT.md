# Quant contract

Quant owns its contract. The contract is a **frozen local research object**: the invariants below, executed by `test/support/contract-spec.ts`, plus the structural bounds. It is not a mirror of any other runtime.

Provenance (where each obligation was originally taken from, the source snapshot, exclusions, and deviations from the source) is research history and lives only in `research/REPORT.md`. It carries no authority.

Nothing outside this contract defines correctness: not explanatory documents, not the current implementation, not another runtime, not a framework convention, not a benchmark. An external behavior change is evidence only. To adopt it:

1. state the invariant it would add or change;
2. show it belongs to the research question;
3. justify the contract change explicitly;
4. update the executable contract and `research/REPORT.md` before changing the runtime.

### Semantic invariants

P5, F5 and W5 lie outside the executable spec: its program language has no write inside a computation, no batch, and creating a watcher there runs nothing. `test/semantics.test.ts` executes them through the public API. D7 additionally describes automatic watcher delivery, which that spec leaves to its caller. `test/watcher-validation.test.ts` executes D7 through the public API.

`test/failure-boundary.test.ts` exercises D8 in the demand-based model and F6 for a caught exception in an enclosing callback. `test/interrupted-validation.test.ts` exercises D8 through the public API. Native stack exhaustion is covered in [the research report](research/REPORT.md#failure-boundary-d8-f6-and-s7).

Graph and tracking
- **T1 exact tracking.** A computation observes exactly the sources it read; dynamic branches add and drop relations.
- **T2 relation uniqueness.** One relation per (source, consumer) pair, under repeats, reorders, nesting, and failures.
- **T3 nesting isolation.** Nested evaluation never corrupts the outer pass.

Change and propagation
- **P1 change is a version fact.** Decided by `Object.is` at commit; A→B→A counts as a change.
- **P2 cutoff.** An unchanged computed does not propagate.
- **P3 glitch freedom.** No inconsistent intermediate observation; one execution per node per wave.
- **P4 validate is not execute.** A watcher validates its whole committed source set before any lifecycle step.
- **P5 in-pass invalidation.** Once a computation has observed a source in an execution, a later committed change to that source leaves it owing another execution; rereading the source in the same execution does not discharge the obligation.

Failure

Quant owns the reactive evidence and obligations established by its machine, and the transient state of its own activations. A failure alone establishes no change, execution obligation, demand, delivery, or retry. Recovery proceeds when the contract supplies a cause, such as an explicit demand or a newly delivered invalidation. An established obligation survives until it can be discharged. Hidden JavaScript state, external side effects, and unrelated activity supply no evidence that a failed computation will now succeed.

- **F1 failed computed.** A failed computed commits nothing and executes on its next demand.
- **F2 failed read.** A read that threw is not an observation.
- **F3 failed watcher.** An established watcher (W5) whose run fails is cold and wakes on committed sources ∪ last-attempt reads.
- **F4 established obligation survives.** Once execution is owed, a failure does not discharge that obligation. Validation interrupted before a change is established creates no execution obligation for the validator or any ancestor solely because of the interruption. Retaining an obligation does not independently schedule delivery (D7).
- **F5 first error.** An operation that fails rethrows the first error raised in it. Obligations it still discharges afterwards run, and their errors do not replace that first error. Those obligations are the later watchers of the same drain, the watchers a failing batch body deferred, and the rollback of a failed `effect()` call (W5).
- **F6 abandoned activation is no longer live.** When an exception unwinds an evaluation or validation in a contract-valid program, Quant releases that activation's transient state and restores any enclosing activation. Later valid work can proceed without a spurious cycle or stale tracking state from the abandoned activation. This guarantee entails neither retry of the failed operation nor rollback of user side effects.

Watchers and lifecycle
- **W1 cleanup first.** The previous cleanup is consumed before a rerun.
- **W2 self-invalidation.** A watcher invalidated during its own run is delivered again; cutoff stays exact.
- **W3 disposal.** Terminal; cleanup runs after teardown; no ghost relations; safe inside the node's own pass and its own validation.
- **W4 batching.** Defers watcher execution only.
- **W5 construction atomicity.** A watcher is established when `effect()` returns its handle. A call to `effect()` that throws returns no handle and leaves no live watcher: it is detached and never runs again, the cleanup of a successful run is consumed, and the error reaches the caller. This holds whichever run in the drain the call opened threw. A first run deferred by a batch or an open drain happens after the handle is returned, so its failure is F3.

### Preconditions

A program that breaks a precondition is erroneous, and no invariant covers it. The production build gives it no defined result beyond graph integrity and the structural bounds, and pays nothing for a diagnosis. The development build (`__DEV__`, chosen through the package's `development` export condition) diagnoses it. Whatever the public types can rule out, they rule out; a precondition covers only what they cannot.

- **C1 no demand on an evaluation in progress.** A demand (a read, or the validation of a computed or a watcher) never reaches a node whose own execution or validation is in progress, however that node was invalidated. This covers a cycle in the graph, and a write during an evaluation whose synchronous drain demands such a node. Types cannot rule it out: the demand is made through a closure, and it depends on the order of evaluation.
  - The development build fails such a demand with a cycle error, so the node's committed value never answers it. The error is a failed read (F2), and in validation a failed validation (P4). `test/semantics.test.ts` executes the diagnosis against the development build.
  - The production build keeps only the check it always had: a read of a node whose run is on the stack. Otherwise it may answer with a committed value, and a node may stay clean while holding a value its sources have moved past.
  - The provenance spec assumes acyclic evaluation, so C1 is no contract decision.

### Contract decisions

- **D1 existential validation.** Computed validation stops at the first changed committed source, in read order, and executes: if an earlier source changed and a later one now throws, the computed executes rather than throwing from validation. The provenance spec validates the whole frontier and throws (research/REPORT.md).
- **D2 failed computed re-entry.** A failed computed executes on its next demand without validating its old frontier first, even if that frontier now throws (F1). The provenance spec validates the old frontier first (research/REPORT.md).
- **D6 in-pass invalidation.** A relation keeps the version of its source's first successful observation in an execution, and an execution is validated as of its start (P5). The provenance spec refreshes the version on every reread and stamps its validation after the execution, so a change an execution makes to a source it already observed is never seen (research/REPORT.md).
- **D7 failed watcher validation is a barrier.** Failed validation aborts that delivery before any watcher lifecycle step (P4). Invalidations already coalesced into it remain pending and create no independent retry obligation. A later delivered invalidation retries the full committed source set, using the latest states of pending branches and preserving any established execution obligation (F4). The barrier alone schedules no further attempt. F1 continues to require execution of a failed computed on its next demand.
- **D8 interrupted computed validation.** When validation is interrupted before a change is established, the computed validates its committed dependencies on its next demand in D1 order. If their versions are unchanged, cutoff is preserved (P2). An execution owed on independent evidence still runs (F1, F4). A later invalidation that would reach the consumer through the interrupted validation path must still be able to reach it. D7 governs branches already coalesced outside that path.

### Structural bounds

- **S1** no allocation and no lookup per stable read;
- **S2** no new relation when one already exists;
- **S3** no Θ(d²) tracking;
- **S4** graph size proportional to live relations;
- **S5** repeated failures do not accumulate relations;
- **S6** nesting does not rebuild global state;
- **S7 kernel traversal is bounded and stack-safe.** Quant's graph walks use bounded work and do not consume JavaScript call stack proportional to graph depth. Synchronous nesting of user callbacks that demand other computations is outside this stack bound. If such nesting unwinds with a catchable exception, F6 applies.
- **S8** host queue storage is O(W) plus constant slack, where W is the most scheduled watchers queued at once. Completed deliveries do not accumulate queue storage.

