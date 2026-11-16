# History erasure and bounded continuations

This is test infrastructure for the existing Quant contract, not a new core
mechanism or a change to its semantic/resource guarantees. Implementation:
`test/support/history-erasure.ts`; candidates:
`test/support/history-erasure-generator.ts`; suite:
`test/history-erasure.test.ts`.

Run both runtime modes:

```sh
npm test -- test/history-erasure.test.ts
npm run test:production -- test/history-erasure.test.ts
npm test -- test/history-continuations.test.ts
npm run test:production -- test/history-continuations.test.ts
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
The original runner defaults to successful endpoints; transient suffix failures
are allowed. The bounded explorer below uses open suffix endpoints instead.

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

An unchanged computed may already be validated while its watcher still has a
redundant `STALE` bit before the next explicit flush. The projection checks
current observations and execution debt rather than equating that representation
bit with a semantic obligation. The three-operation witness `set x=1; set x=0;
read c` exposed this overly strict oracle assumption when bounded search was
added; the oracle was corrected and a regression test added. Quant did not
require a repair.

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

## Bounded continuation search (LOG 52)

`test/support/history-continuations.ts` supplies breadth-first replay over an
explicit finite operation alphabet. `searchHistoryContinuations` certifies the
same successful initial boundary, then visits every admissible word of length
1 through `maxDepth`. It does not restore or rewrite runtime state between
branches: each word replays both prefixes into independent worlds.

```ts
const result = await searchHistoryContinuations(test, {
  maxDepth: 3,
  alphabet: continuationAlphabet(
    test,
    [0, 1],
    continuationDeclarations("a0"),
  ),
  maxTransitions: 20_000,
});
```

`continuationAlphabet` includes reads of every public producer/computed, writes
of the supplied values to every public producer, explicit flush, disposal of
every public watcher, and optional finite declaration templates together with
reads/disposals of those new names. `continuationDeclarations` supplies one small
computed and one watcher template; callers may specify others. A new name is
readable only after declaration; redeclaration and access to private names are
inadmissible. Expected computation/lifecycle errors are observations, not reasons
to discard a continuation. Batch scheduling remains outside this language.

`runHistoryCase(..., factory, { endpoint: "open" })` supports these prefixes
without forcing a successful recovery at their ends. After every BFS step the
two spec worlds compare:

- public cached values, liveness and cleanup presence;
- initialized state, failed-computed re-entry state and watcher execution debt;
- ordered committed observations and retry evidence, distinguishing current
  from stale versions and absent from empty retry frontiers;
- callback definitions and explicit-flush order.

Absolute counters are omitted; the model tests each retained version only
against its source's current version. Validation-cache timestamps are model
optimizations. The read-only failed-computed diagnostic lives in the test spec,
not the runtime. This is an executable projection to be challenged by further
continuations, not a representation-independent sufficiency proof.

Quant is compared vertically and horizontally for outputs, public cached values
and lifecycle state at each step. Whenever the spec can certify a recovered
endpoint, the full existing committed-graph projection is checked too. At open
endpoints the runner does not pretend to reconstruct the spec's debt/retry maps
from Quant's flags and intrusive lists. Their effects are challenged by the
remaining continuations. All existing graph/root audits still run after every
operation, including failed ones.

### What the result establishes

- `equivalent` means every admissible word through `requestedDepth` was checked;
  `completedDepth` equals that bound. This is bounded equivalence for the
  reported alphabet, initial pair, projections and selected envelopes only.
- `counterexample` returns the first failing word, its depth and the four-world
  verdict/evidence. BFS makes this depth minimal for the configured checks on
  that fixed pair and alphabet. A next-state mismatch is distinguished from an
  output mismatch; neither is silently called the globally shortest observable
  suffix over an unrestricted language.
- `incomplete` means `maxTransitions` interrupted a level. `completedDepth`
  reports only fully checked levels; no claim is made for the partial level.
- `ineligible` means the root/candidate could not be certified. An uncertified
  root has `completedDepth = -1`.

Counts include admitted transition words, rejected extensions and per-depth
totals; the initial boundary is separate. Original fixed-suffix envelopes are
cleared rather than accidentally applied to unrelated words. An optional
deterministic `envelopes(suffix)` policy can specify the explorer's own bounds.

### Why equal spec states do not prune paths

Two words that end in the same spec state may leave different hidden Quant
states. Discarding either word on that basis would assume the history-erasure
property under investigation. The explorer counts distinct/repeated canonical
spec states for diagnostics but keeps every implementation path.

A fault fixture makes the same spec state repeat after no-op writes while only
one Quant history accumulates a hidden token. BFS finds `set x=0; set x=0; read x`
at depth 3, after completing depths 1 and 2. Spec-only pruning would remove the
path before the token becomes observable. A sound implementation-state reduction
would need a separately justified product-state equivalence; it is not present.

### Symmetric histories and coverage

The generator now accepts independent `historyA` and `history` (B) sequences.
Both start at the common base and may contain different nonempty churn/recovery
histories. `histories` labels are coverage provenance, not axioms. The existing
fresh-versus-churned corpus remains; additional tests cover all 30 ordered pairs
of different single rules and 80 sampled independently churned pairs.

Every search returns a residue-by-continuation-class matrix with counts. A
`failure` entry counts an actual spec error observation; `new-node` counts an
admitted declaration. These measure attempted distinctions, not causal proof
that a particular operation exercised an internal residue.

The per-rule depth-3 corpus checks all six columns below (nonzero counts), using
eight alphabet operations with seven admissible choices at each step. Both
computed- and watcher-failure modes are writable:

| History label | read | write | flush | dispose | failure | new node |
| --- | --- | --- | --- | --- | --- | --- |
| reorder/inverse | yes | yes | yes | yes | yes | yes |
| branch/return | yes | yes | yes | yes | yes | yes |
| computed recovery | yes | yes | yes | yes | yes | yes |
| watcher recovery | yes | yes | yes | yes | yes | yes |
| disposed neighbor | yes | yes | yes | yes | yes | yes |
| settled ABA | yes | yes | yes | yes | yes | yes |

That corpus checks 399 admitted words per rule (2,394 total). A separate
13-operation public-node/declaration alphabet checks 1,463 admitted words through
depth 3, including a new watcher. A two-operation no-op-write/read alphabet checks
all 62 words through depth 5. These are different bounded domains; the depth-5
result does not extend to the larger alphabets. No GC, JIT, generation-wrap or
scheduled-queue-hysteresis result follows from these checks.
