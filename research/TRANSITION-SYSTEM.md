# Production ownership transition map (LOG 58)

The [17 facts](./TEMPORAL-OWNERSHIP.md) and
[eight handoffs](./TEMPORAL-HANDOFFS.md) now have an executable transition map
and a source write audit. The accepted production view has **197 mapped sites,
zero unknown stores/calls and 11 explicit public entry contracts**. Every site
maps to a transition schema with allowed births, handoffs, extinctions and
residue. The audit checks the public **effect alphabet** to a fixed point,
including arbitrary finite synchronous callback reentry.

This is not yet a proof that every concrete public operation preserves the
combined runtime invariant. In particular, assigning a store to a schema does
not prove that the schema's source state is enabled at that instruction. The
artifact reports both `wholeHeapForwardSimulationProved` and
`allConcretePublicOperationsStateClosureProved` as **false**. Local flag
transfers have a stronger, conditional finite check; whole-heap refinement
remains an explicit obligation below.

No production code, representation or contract changed. Main remains at its
isolated F3 repair, `5c847db`.

## Model and state domain

[transition-model.mjs](./transition-model.mjs) defines 13 local control
protocols, with 60 states and 105 edges in total:

| Protocol | Control states describe                                                      |
| -------- | ---------------------------------------------------------------------------- |
| queue    | empty, flagged, published, popped, local delivery and independent requeue    |
| attempt  | old debt, body entry, Busy, fresh invalidation, failure debt and terminality |
| cleanup  | slot, borrowed reference, consumed invocation right and callback completion  |
| slots    | saved outer owner, inner claim, pop and exact restoration                    |
| stack    | reservation, physical cell, pop, clearing and local continuation             |
| relation | absent, tentative, same committed identity and retirement                    |
| marker   | observed version, UNREAD, SKIPPED and retirement                             |
| graph    | private allocation, linked storage, rewiring and severing                    |
| scope    | saved caller, callee/untracked interval and restoration                      |
| error    | no error, retained first error and rethrow                                   |
| host     | rest, nested hold and drain                                                  |
| payload  | initial or committed opaque payload                                          |
| startup  | unconfigured roots, registered wake dispatch and public entry                |

These are local carriers, **not 60 possible global runtime states**. Node/edge
identities, payloads, exact counters, list contents, queue contents and frame
tails are parameters. There is no artificial one-node heap limit. Conversely,
the file does not secretly prove a consistent product of all parameterized
protocol instances. The missing relational lemmas are precisely what would
connect them into a concrete heap simulation.

The original facts describe ownership, not every data component of a machine.
The map therefore includes cache/version stores, endpoint initialization,
buffer creation and immutable startup configuration. These add no runtime
facts or fields. `Checking` has no computed birth in the production profile;
the Checking/Woken alias handoff is an immutable-kind constraint, not a
conversion between computed and watcher.

For a protocol `p`, the executable relation is
`δp ⊆ Qp × Event × Qp`. Checks establish that all declared edges stay in its
carrier, all declared states are reachable and every schema event has an edge.
Additional constraints forbid retired identity resurrection, callback return
to an old cleanup slot, terminal attempt resurrection, callbacks before queue
ownership transfer and an uncleared popped stack cell. These checks establish
consistency of the declared finite protocols, not refinement of arbitrary
source paths to them.

The generated [Mermaid map](./TRANSITION-MAP.mmd) contains every local edge.
[TRANSITION-AUDIT.json](./TRANSITION-AUDIT.json) contains the original lifetime
rows, all eight handoff bindings, entry contracts, local transitions,
per-site transfer classifications and unresolved premises.

## External events and source coverage

The 11 external operations and their direct protocol entries are:

| Operation | Direct entry and obligations                                                       |
| --------- | ---------------------------------------------------------------------------------- |
| signal    | fresh signal, empty graph/slot and zero flags/counters                             |
| computed  | fresh computed with initial Dirty; body is not called                              |
| effect    | watcher birth, start/schedule, body attempt and unpublished-constructor rollback   |
| get       | pull, successful observation and preservation of the caller's tracking frame       |
| peek      | pull without recording a caller dependency                                         |
| set       | Object.is commit/version, propagation, wake and eligible drain                     |
| update    | untracked updater; set only after normal callback return                           |
| dispose   | terminal callback identity, detach or deferred Busy unwind, consumed cleanup       |
| batch     | nested host hold, exit drain and first-error precedence                            |
| untracked | suspend observation and restore the caller on return/throw                         |
| typeOf    | read-only live-handle query; disposed computed is excluded by its API precondition |

Callbacks may call any permitted public operation, so their transitive effect
sets are wider than these direct entry descriptions. Entry contracts also
preserve C1; the model does not turn invalid cyclic programs into obligations.

[transition-source.mjs](./transition-source.mjs) uses the TypeScript AST and
symbol/type checker, specializes `__DEV__=false` and `__STATS__=false`, resolves
the actual exported aliases and follows internal calls. An unused module
binding with an effectful initializer is still scanned. There are 54 reachable
procedures in this conservative view. Diagnostic/statistics-only stores and
unreachable internal test queries are outside this profile.

The inventory includes:

- assignments, compound assignments and increment/decrement;
- Node/Edge object-literal initialization, including immutable `from/to`;
- module roots/configuration, array cells and length, fresh bulk fill and
  writes through typed local aliases;
- 23 scoped ownership snapshots, catch bindings and selected parameter bindings,
  in addition to 174 global/object/array sites.

Ordinary scalar temporaries are counted separately. Fresh-array construction
is represented by its owning allocation/store schema; this is a source-level
inventory, not a count of hidden VM or allocator writes. Constants subsequently
inlined by the release minifier are conservatively included.

Calls with unclassified effects fail the audit. For example, inserting
`Object.assign` is rejected rather than silently treated as read-only. Ordinary
unmodified `Object.is`, fresh Array/Error allocation and checked null-fill are
trusted intrinsics. The indirect kernel wake call has a checked premise:
exactly one startup `onWake` registration, with `host.wake` as its actual
argument. Eighteen declared graph/index/write/queue helpers must be transitively
free of user callbacks. Their intermediate pointer/token stores can therefore
be treated as private microsteps, subject to their unproved data invariants.

[transition-write-ledger.json](./transition-write-ledger.json) is the reviewed
inventory, separate from generated output. Every row pins its target, normalized
store, enclosing body, constant environment, complete source fingerprint and
schema. Complete-source hashing normalizes line endings. A changed guard or
helper is a review gate even if its store text is unchanged. Regenerating the
ledger requires both an explicit switch and `QUANT_REVIEW_WRITES=1`; normal
verification cannot accept new source by regenerating its own expected input.
Pins enforce review, not semantic correctness of a newly reviewed row.

The readable [write table](./TRANSITION-WRITES.md) links all 197 sites to source.
Each schema expands to one or more allowed edges in the JSON artifact: for
example, a queue cell store and a queue pop have different concrete guards even
though both use the queue schema. The audit proves total mapping to allowed
schemas, **not automatic selection of an enabled edge** at every site.

## What closure is checked

Let `Wf` be the mapped write schemas directly present in procedure `f`. Let
`C(f)` be its resolved internal callees and `P` the 11 public entries. The audit
computes the least fixed point:

```text
Ef = Wf ∪ ⋃ Eg                    g ∈ C(f)
        ∪ ⋃ Ep                   p ∈ P, if f invokes an opaque callback
        ∪ effects of lexical callback bodies potentially passed by f
```

The finite alphabet has 24 store schemas. Every resolved procedure and public
entry closes over it; unknown effects and uncontracted public entries fail.
`signal` and `computed` additionally have allocation-only footprints and cannot
invoke a callback; `typeOf` has an empty footprint. This calculation has no BFS
depth or callback nesting bound.

Under the accepted-source and environment assumptions, induction on any finite
execution prefix gives: each explicit tracked store performed by a public
operation, including its synchronous callback reentry, belongs to the mapped
effect alphabet of that entry. This is **effect-alphabet closure**. It does not
imply that its execution preserves graph shape, cell ownership or causal
provenance. Those require source-state/target-state simulation, not set union.

## Conditional flag transfer verification

Flags have an independently declared carrier of 39 role-tagged combinations:
signal flags are zero; computed flags are limited to Stale/Dirty/Busy in PROD;
watcher combinations preserve Watch and Auto, require Queued ⇒ Auto,
Woken ⇒ Dirty and exclude Busy with Woken. Kind is a ghost capability established
at allocation, not inferred from `fn === null` after disposal.

For each of the 20 flag assignments, the model declares an action with born
bits, dead bits, preserved other bits and either a current or historical input.
The checker evaluates the actual RHS AST against that action on **1,114 cases**
after the listed role/phase/path/snapshot premises. It checks both the expected
transfer and closure in the role-tagged carrier. Constructors independently
establish the initial role/flag combinations.

For example, body entry must implement:

```text
current → (current minus Stale, Dirty, Woken) plus Busy
```

The old F3 expression leaves Woken beside Busy and is rejected even with source
pins bypassed. A representative incoming watcher byte is 242: repaired entry
produces 212; the old expression produces 244. A different negative control
clears fresh Stale at successful body exit: the result can remain a legal flag
byte, but violates the declared transfer and is rejected too.

Snapshot premises matter. After `host.deliver` calls `check(w)`, incoming `flags`
is historical: a nested callback may have mutated or disposed `w`. That catch
store is checked with independently enumerated same-kind/same-Auto entry
snapshots and current flags; pre-callback mutable guards are not reused. A
mutant restoring `flags | Stale` instead of preserving current `w.flags` fails.
Other local proofs retain their explicitly listed phase and snapshot premises;
establishing all of those from arbitrary callers remains an obligation.

Additional source lemmas check the nine-field fresh Node shape and six
zero/null defaults, immutable edge endpoints, terminal-only callback nulling,
factory roles, negative disjoint marker domains and masked counter ranges.
Range preservation does **not** prove counter-age/ABA safety or SETTLE's age
invariant.

## Concrete trace bridge and controls

`npm run research:transition-traces` wraps the original flag assignments in a
private build. Each assignment still executes once; the monitor checks actual
before/after flags against the action, role bits and body-entry/exit premises.
This is a DEV=false instrumented build with statistics enabled, full counters
and no source mutants. It is not a release-size or timing measurement.

The existing 176 boundary programs plus 60 handoff programs produce **236
programs / 7,541 top-level operations / 11,812 flag transfers**, exercising all
20/20 assignment sites. The independent imperative oracle, graph integrity,
retirement and retained-root audits remain enabled. This corpus includes the
existing manual-host extension as well as public-API programs; it is a bounded
execution check, not an exhaustive public-operation proof. One intentional C1
violation is excluded by preflight. Results, source fingerprint and raw trace
path are in [TRANSITION-TRACES.json](./TRANSITION-TRACES.json).

Seventeen audit/regression tests cover inventory and negative controls:
alias writes, hidden mutators/startup effects, changed guards/configuration,
callback insertion in an atomic slot helper, an extra public entry, incorrect
wake registration, invalid factory birth/defaults, out-of-range counter writes,
marker overlap, F3, fresh-mark extinction, stale callback snapshots and protocol
resurrection. They test the checker separately from the reviewed source pins.

Validation: **451 DEV tests; 444 PROD tests plus seven diagnostic skips**.
Source and strict oracle typechecks pass. These counts include the 17 new
tests; older experiment scores retain their original denominators.

## Remaining simulation obligations

To claim that all concrete public operations preserve the full transition
invariant, the following still need proofs over arbitrary identities and sizes:

1. Intrusive dependency/subscriber list shape, identity uniqueness and retired
   runs, including pointers held across user callbacks.
2. A stack/slot frame lemma for arbitrarily nested indexed owners, exact saved
   owners, top/cell intermediate states and unwind restoration.
3. Queue ring/hold/capacity arithmetic and the logical-token/physical-cell
   relation over arbitrary watcher sets and reentrant drains.
4. Version/generation age and SETTLE simulation, including **counter wrap**.
5. Caller/callback admission of every local phase/snapshot premise, and a
   cross-protocol forward simulation connecting each concrete store to an
   enabled edge while preserving the other protocol instances.

The environment assumes typed opaque handles, no direct replacement/mutation
of runtime fields or prototypes/accessors/proxies, ordinary intrinsics,
successful allocation, and synchronous contract-valid public callback reentry.
Application payload contents are opaque. Physical GC, engine/JIT history and
the sufficiency of a global history-erasure projection are not proved here.

## Reproduction

```sh
npm run research:transitions
npm run test:transitions
npm run research:transition-traces
npm run typecheck:history
npm run typecheck
npm test
npm run test:production
```

Only after reviewing a deliberate source/model change, ledger maintenance is:

```powershell
$env:QUANT_REVIEW_WRITES = '1'
node research/transition-audit.mjs --review-ledger
Remove-Item Env:QUANT_REVIEW_WRITES
```

Regeneration records the new reviewed mapping; it does not discharge the five
remaining simulation obligations.
