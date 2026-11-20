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

`test/failure-boundary.test.ts` exercises D8 in the demand-based model and T3 for a caught exception in an enclosing callback. `test/interrupted-validation.test.ts` exercises D8 through the public API.

Graph and tracking
- **T1 exact tracking.** A computation observes exactly the sources it read; dynamic branches add and drop relations.
- **T2 relation uniqueness.** One relation per (source, consumer) pair, under repeats, reorders, nesting, and failures.
- **T3 nesting isolation.** Nested evaluation never corrupts the outer pass.

Change and propagation
- **P1 change is a version fact.** Decided by `Object.is` at commit; A→B→A counts as a change.
- **P2 cutoff.** An unchanged computed does not propagate.
- **P3 glitch freedom.** No inconsistent intermediate observation; one execution per node per wave.
- **P4 validate is not execute.** A live watcher delivery validates its whole committed source set before rerun cleanup or execution.
- **P5 in-pass invalidation.** Once a computation has observed a source in an execution, a later committed change to that source leaves it owing another execution; rereading the source in the same execution does not discharge the obligation.

Failure

Quant owns the reactive evidence and obligations established by its machine, and the transient state of its own activations. A failure alone establishes no change, execution obligation, demand, delivery, or retry. Recovery proceeds when the contract supplies a cause, such as an explicit demand or a newly delivered invalidation. An established obligation survives until it can be discharged. Hidden JavaScript state, external side effects, and unrelated activity supply no evidence that a failed computation will now succeed.

The contract ends where synchronous nesting of user callbacks exhausts the
native JavaScript stack. That is a host resource failure, not a callback
failure. If the program catches the overflow and goes on, the runtime state
that follows is outside this contract. S7 still bounds Quant's own graph
walks. The boundary is a condition on the program, not on the exception: an
exception a callback throws, including a user-thrown `RangeError`, remains
subject to F1–F5.

- **F1 failed computed.** A failed computed commits nothing and executes on its next demand.
- **F2 failed read.** A read that threw is not an observation.
- **F3 failed watcher.** An established watcher (W5) whose run fails is cold and wakes on committed sources ∪ last-attempt reads.
- **F4 established obligation survives.** Once execution is owed, a failure does not discharge that obligation. Validation interrupted before a change is established creates no execution obligation for the validator or any ancestor solely because of the interruption. Retaining an obligation does not independently schedule delivery (D7).
- **F5 first error.** An operation that fails rethrows the first error raised in it. Obligations it still discharges afterwards run, and their errors do not replace that first error. Those obligations are the later watchers of the same drain, the watchers a failing batch body deferred, and the rollback of a failed `effect()` call (W5).

Watchers and lifecycle
- **W1 cleanup first.** The previous cleanup is consumed before a rerun.
- **W2 self-invalidation.** A watcher invalidated during its own run is delivered again; cutoff stays exact.
- **W3 disposal.** Disposal is terminal: a disposed node never executes again, and a disposed computed's last committed value stays readable. Disposal is safe inside the node's own execution or validation. Teardown leaves no ghost relations and precedes disposal cleanup. When a computed is disposed during its own execution, by its own callback or by any callback that execution calls, the execution still ends as usual. If it returns, its value is committed as any returned value is (P1, P2), so the demand that started the execution reads that value; no relation from that execution remains. If it throws, it commits nothing (F1), and the computed still never executes again. A watcher disposed during its own execution never runs the cleanup that execution returns. Disposing a watcher cancels its current delivery. A source pull already in progress can finish or throw. Validation starts no further source pulls for that delivery. `test/validation-delivery.test.ts` exercises this boundary.
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
- **D7 failed watcher validation is a barrier.** Failed validation aborts that delivery before rerun lifecycle begins (P4). Invalidations already coalesced into it remain pending and create no independent retry obligation. A later delivered invalidation of a live watcher retries the full committed source set, using the latest states of pending branches and preserving any established execution obligation (F4). The barrier alone schedules no further attempt. F1 continues to require execution of a failed computed on its next demand.
- **D8 interrupted computed validation.** When validation is interrupted before a change is established, the computed validates its committed dependencies on its next demand in D1 order. If their versions are unchanged, cutoff is preserved (P2). An execution owed on independent evidence still runs (F1, F4). A later invalidation that would reach the consumer through the interrupted validation path must still be able to reach it. D7 governs branches already coalesced outside that path.

### Implementation lemma for SKIPPED

Before the version-tagged tracker resolves a read in an active execution
of `c`, its accepted prefix records the first observations of this
attempt. It runs from `c.firstDep` through `cursor` and is empty when
`cursor` is null.

The lemma relies on five premises.

1. **Exact pair identity.** Establish `e.from === s` and `e.to === c`
   independently of the `SKIPPED` tag.
2. **Liveness.** At the point of use, `e` is still linked in both the
   subscriber list of `s` and the dependency list of `c`.
3. **First acceptance.** Every path that first accepts an edge in this
   execution stores the version observed at that read. Writing the
   nonnegative `s.ver` replaces any `SKIPPED` tag on that edge.
4. **Repeats.** A reread preserves the version of the first observation,
   including when `s.ver` has since changed (D6 and P5).
5. **Expiry.** The only other write that can reach an accepted edge is the
   version wrap of its source (RQ5). It turns a nonnegative version into
   `EXPIRED` and leaves every negative tag in place.

Let `exactPair(e, s, c)` denote the first two premises.

```text
exactPair(e, s, c) and e.ver == SKIPPED  ⇒  e is in c's unread suffix
```

**Proof.** The invariant is that no edge of the accepted prefix carries
`SKIPPED`. The prefix starts empty. A first acceptance writes a
nonnegative version, a repeat writes nothing, and expiry writes `EXPIRED`,
never `SKIPPED`. `skip` assigns `SKIPPED` only to the first unread edge.
The other sentinel writes (`UNREAD` in a mark, an index or a deferral)
also stay in the unread suffix, and nested passes preserve the enclosing
prefix (T3). So an exact live edge tagged `SKIPPED` lies outside the
prefix. A tag that survived a failed execution gives the same evidence in
the new attempt, whose prefix starts empty again, and so does a tag that
survived its source's wrap. The implication is one-way: unread edges can
also carry versions from earlier executions, `UNREAD` or `EXPIRED`.

**Consequence.** Once `s` has been read successfully and the pair is known,
the tracker can accept `e` directly. If `e` is the first unread edge
(`next`), advance the cursor. If it lies strictly after `next`, splice it
before `next` and advance the cursor. Record the observed version in
both cases. This preserves first-read order for D1 and the first version
for P5. Given the exact pair, acceptance costs O(1) and needs no
Θ(u) marking pass over the unread suffix.

### Structural bounds

- **S1** no allocation and no lookup per stable read;
- **S2** no new relation when one already exists;
- **S3** no Θ(d²) tracking;
- **S4** graph size proportional to live relations;
- **S5** repeated failures do not accumulate relations;
- **S6** nesting does not rebuild global state;
- **S7 kernel traversal is bounded and stack-safe.** Quant's graph walks use bounded work and do not consume JavaScript call stack proportional to graph depth. Synchronous nesting of user callbacks that demand other computations is outside this stack bound.
- **S8** host queue storage is O(W) plus constant slack, where W is the most scheduled watchers queued at once. Completed deliveries do not accumulate queue storage.

