# History erasure: the first executable slice

This is test infrastructure for the existing Quant contract, not a new core
mechanism or a change to its semantic/resource guarantees. Implementation:
`test/support/history-erasure.ts`; candidates:
`test/support/history-erasure-generator.ts`; suite:
`test/history-erasure.test.ts`.

Run both runtime modes:

```sh
npm test -- test/history-erasure.test.ts
npm run test:production -- test/history-erasure.test.ts
```

## What is compared

A case contains two prefixes, the public handles at their boundary, one common
suffix, a candidate transformation name, and optional per-suffix-operation work
envelopes. It executes four worlds:

```text
contract spec(H1) -- S --> outputs A, next A
contract spec(H2) -- S --> outputs B, next B
Quant(H1)         -- S --> outputs C, next C
Quant(H2)         -- S --> outputs D, next D
```

The spec certifies the two checkpoints before Quant is constructed. Both spec
suffix outputs and next states must agree. Each Quant prefix and checkpoint is
also checked against its own spec. The lower comparison then detects either
different Quant continuations or the same incorrect continuation in both worlds.
Different prefix outputs are allowed across histories; each remains subject to
its own implementation-versus-spec check.

The language is the existing acyclic expression DSL with explicit `flush`.
Expressions have no mutable callback registers and cannot write, allocate
reactive nodes, or perform arbitrary JavaScript effects. The abstract program
state is their expression/cleanup definitions and the live watcher iteration
order. Batch operations are rejected: this adapter is not a test of the public
host's automatic scheduling or W4/F5/W5 behavior.

## Boundary and certificate

The initial slice accepts only successful, quiescent checkpoints:

- every public live computed/watcher has successfully initialized;
- each committed dependency's observed version is current;
- there is no remaining retry frontier or watcher execution obligation;
- public values, liveness, ordered committed frontiers, callback definitions,
  cleanup presence and explicit-flush order coincide.

The spec snapshot reads model fields without demanding or repairing nodes.
Quant is projected independently from graph fields, also without repair.
Absolute versions and generations are omitted only after these conditions are
checked. In particular, pending A-B-A debt is rejected; settled A-B-A histories
can be certified. A failed attempt requires actual successful recovery.

Public names match literally in this slice. A private prefix node may be omitted
only if it is a disposed watcher; public callbacks cannot capture private names.
The suffix cannot access them or reuse any prefix name for a declaration. This
restricts the continuation interface explicitly rather than pretending the test
proved equivalence for arbitrary programs that can inspect private handles.
Suffix declarations are supported and become part of the final checkpoint.
Both endpoints must meet the successful boundary conditions; transient suffix
failures are allowed. Checking non-quiescent final states is future work.

The resulting `EquivalenceWitness` records the boundary, DSL restriction, node
and relation counts and checked equalities. A transformation name is provenance,
not proof. The six candidate transformations are reorder/inverse, branch/return,
computed failure/recovery, watcher failure/recovery, temporary watcher disposal,
and settled value ABA. They are composed before independently checked boundaries.

## Observation policy

The existing comparator preserves value presence, `Object.is`, normalized error
name/message, and the exact run/cleanup event sequence. There is no event sorting.
The explicit-flush interpreter chooses a common watcher iteration order, and
that order is part of the checkpoint. This does not promote arbitrary sibling
scheduling order into a Quant invariant.

`HistoryResult.at` reports the first observed differing operation index; an
index equal to the suffix length means only the final projection differed.
This is a location in the tested suffix, not the shortest distinguishing depth
over all possible continuations. `describeHistoryFailure` emits the replayable
case and normalized first-difference evidence without cyclic runtime objects.

## Isolation, roots and bounds

Each Quant world gets newly evaluated kernel/host/instrumentation modules via
Vitest's module reset. Graphs alone are not sufficient isolation: queue storage,
work-stack storage and counters must not carry the other world's history.
Worlds run sequentially; this factory is not for concurrent test execution.

A Vitest-only transform adds read-only root snapshots to kernel and host modules.
No export or branch is added to production source. The oracle inspects every
physical stack/queue slot, including logically inactive ones, and persistent
`active`/`cursor`/`top`/`size`/`hold` registers after every operation, including
failures. In this language the automatic host queue is unused, so it must remain
empty at its initial size; this asserts no queue-hysteresis policy.

Graph traversal follows all Node/Edge graph pointers from every retained handle
and the runtime roots. Reachable edges must be active relations, intrusive lists
must be consistent and unique, slots must be restored, and disposed watchers must
release dependencies and cleanup. The stack's existing at-rest bound is checked.
Private disposed handles deliberately remain retained by the interpreter: their
presence is not a node-allocation leak, but they must not retain graph relations.

The oracle covers the controlled DSL's graph topology and known runtime roots.
It does not inspect arbitrary closure environments, V8 backing-store capacity,
remembered sets, or physical GC collection. Small generation domains, scheduled
queue high-water histories, GC schedules, nested user callbacks and JIT history
are separate later extensions.

Counter deltas are saved for every suffix operation. Candidate cases enforce
zero relation allocation/lookup/execution on stable reads and zero new relations
for an unchanged relation set under reordering. Other counter differences are
reported as work data and do not fail semantic comparison. Optional envelopes
are checked independently for each world; no equal-capacity or equal-work rule
is inferred from equal semantic checkpoints.

## Verdicts and shrinking

- `ineligible`: malformed language/interface or uncertified boundary; Quant is
  never consulted to establish equivalence.
- `spec-divergence`: certified states have different spec suffix outputs/next
  projections; investigate the abstraction/spec/observation policy.
- `history-leak`: correct prefixes lead to different Quant suffix outputs/next
  projections while the spec agrees.
- `implementation`: a vertical comparison fails, including a common wrong
  continuation that pairwise Quant comparison would miss.
- `structure`: graph/root integrity, retained storage or a specified counter
  envelope fails.
- `pass`: the four comparisons and selected structural checks pass.

The custom shrinker deletes chunks from both prefixes and the suffix, remaps
counter-envelope positions, and attempts to remove public handles together with
their declarations/operations. Thus it can reduce checkpoint nodes and relations
as well as operation counts. Every candidate is revalidated and recertified by
the spec, must retain the original verdict class, and must satisfy the caller's
failure predicate. No minimum-size or minimum-depth claim is made. Random test
failures invoke this shrinker before reporting; invalid generator candidates
fail the suite rather than being silently discarded.

The suite includes fault fixtures for history-specific outputs, shared wrong
outputs, divergent next states with equal outputs, stale graph/physical slots,
work envelopes, and shrinking. These validate the oracle, not evidence of real
Quant defects. Successful bounded cases and seeded sampling support state
sufficiency on that corpus; they do not prove equivalence for all DSL programs
or minimality of the implementation.
