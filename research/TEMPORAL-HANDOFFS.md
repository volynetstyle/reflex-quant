# Coupled ownership and handoff mutations (LOG 57)

This extends [TEMPORAL-OWNERSHIP.md](./TEMPORAL-OWNERSHIP.md) without adding
production facts. The original 17-row lifetime matrix remains the inventory.
Eight protocols describe migration between those facts, including the alias-role
constraint; they are not eight new fields or invariants. Main stays at its
isolated F3 repair, `5c847db`. All new machinery is research code.

| Protocol | Source ownership | Destination ownership | Boundary |
| --- | --- | --- | --- |
| queue | Queued plus physical cell | local delivery, then possibly a new queue entry | dequeue / callback |
| wake | pre-body Woken | Busy, then fresh Stale and delivery | body entry / in-body write |
| debt | earlier Dirty | Busy, then new failed Dirty | body entry / failure unwind |
| slots | source.slot | displaced stack cell, then restored slot | nested claim / unindex |
| relation | tentative edge | same committed edge | successful commit |
| cleanup | old cleanup closure | consumed callback, then a replacement closure | consume / body / success |
| error | callback's thrown value | drain's retained first error / caller | catch / remaining obligations / rollback |
| alias | Checking on computed; Woken on watcher | the same immutable node role | validation / body boundary |

Watch is not a convertible role in the API. Alias tests exercise concurrent
owners on different nodes, rather than inventing a legitimate conversion from
computed to watcher. A watcher can hold Woken during cleanup while a nested
computed validation holds Checking. All three DEV alias witnesses record this
coexistence. Production never needs the computed Checking role. Birth-role
audits reject mutations that change Watch later.

## Witnesses and observations

`test/support/temporal-handoffs.ts` generates 60 valid programs:

- 24 attempt transfers: manual, scheduled, nested-start and recovery entry;
  success/failure/disposal; cleanup-write versus body-write.
- Four dequeue/requeue cases with success, failure, self-disposal and sibling
  disposal; two cleanup epoch cases; three simultaneous alias-role cases and one
  cold manual-reentry case.
- Two tentative-to-committed identity witnesses, 16 overlapping index witnesses,
  the four-error chain, three epoch/frontier cases and a failed-debt/cutoff twin.
- Three width-32/64/128 slot restoration/work witnesses.

The interpreter's optional `epochEffect` models a normal application closure
capturing its body-attempt ordinal. An old cleanup logs its own ordinal even
after a newer body has run. The ordinal is application state, included in the
model projection, not Quant's node generation. A failed replacement body cannot
publish a cleanup. Explicit tests pin cleanup epochs `[1,3]` after body failure
and `[1,2]` after consumed-cleanup failure. Programs without this opt-in keep
their original observations and program-state shape.

Identity witnesses retain an actual edge only while comparing its failed-read
checkpoint with successful recovery. The committed relation must be that same
object (S2). Native reports expose only the boolean result; this is not a physical
GC experiment. Existing graph/retirement/root audits run after every operation.
Shadow index-owner counters certify coverage; actual Node.slot and runtime roots
decide storage correctness, not the probe's bookkeeping alone.

DEV and PROD each pass the independent model on **60 programs / 3,076 top-level
operations**, with full counters and mask 7. Actual DEV/PROD observation arrays
also compare equal directly in each domain. These are total operations across
the 60 programs, not 3,076 operations per program. The older 176-program domain
still has its original 4,465-operation trace hash.

## A survivor that exposed a missing witness

The first handoff campaign passed a source mutant that omitted saving a displaced
slot owner. Existing nested cases had observable restoration coverage, but this
edit could fall back to other lookup paths without a semantic discrepancy there.

The first attempted amplification was also inadequate: a child with nine sources
could reorder within the bounded scan budget. The probe reported no overlapping
indexed owners, so that fixture did not establish the intended transfer. It was
repaired instead of claiming work coverage from its name.

The final child has fixed degree 26 including its order signal. A wide parent
keeps a source cursor, then demands that child untracked. The child's index
overlaps the cursor's source; on return, a lost displaced cell invalidates the
parent's index certificate. Dense older subscribers force a full parent index
walk on subsequent misses. There are linearly many constant-degree child calls,
so repeating a wide parent rebuild creates the quadratic-work mechanism. The
pristine indexed-work envelope for this finite family is `48 * width + 128`.

| Width | Quant indexed work | Missing-save mutant indexed work | Retained mutant source slots |
| ---: | ---: | ---: | ---: |
| 32 | 1,198 | 1,924 | 30 |
| 64 | 2,350 | 5,990 | 60 |
| 128 | 4,654 | 19,876 | 120 |

The mutant's first verdict is **structural**, from real retained source slots;
the work counts are captured at that same failure. They are not presented as
three timing measurements proving an asymptotic theorem. The source-level
family explains the repeated full walks, and the counts corroborate it. The
pristine family also requires actual overlap/displacement coverage before its
work result is admitted.

Another survivor needed an explicit manual demand after an unchanged-computed
cutoff. A spurious alias-derived Woken could be consumed before body entry in
other witnesses, but this case left it after a clean check and exposed it on the
next manual run. Both additions improve the corpus; neither is a Quant defect.

## Handoff mutants and classification coverage

Eight protocols times five operators yield 40 source seeds: destination missing,
source survives, overlap, phase-early transfer, and identity theft. Operators are
concrete edits to each protocol, including composed edits where appropriate.
Some shared boundaries necessarily overlap earlier seeds; these are catalogue
entries, not 40 independent bug classes. Original source is never modified by
a campaign. Invalid builds, timeouts and coverage gaps stay separate.

The final result is **39/40 killed**, one survivor, zero invalid/timeout/coverage
gaps. All seeds remain in the denominator. The surviving queue variant clears
Queued before the callback but retains the old physical entry until a `finally`
after delivery. Requeued work gets its own entry; both normal return and throw
release the older one. It passes the stated semantic/root domain with different
transient occupancy. This is a policy alternative by construction inspection and
bounded experiment, not a universal equivalence or cost proof.

The first naive early-delivery edit also moved the call out of the drain's
exception protection. It was replaced with the protected `try/finally` variant
so the outcome measures the ownership-transfer choice rather than an unrelated
first-error failure.

Both this campaign and the older 84-seed report now include
`explanationCoverage`: survivors, assessed survivors and `unexplainedSurvivors`.
Their values are respectively **1/1/0** and **16/16/0**. This means every survivor
has a stated domain/representation explanation. It does not turn a surviving
edit into a kill, prove it equivalent, or close the older SKIPPED work question
or every-commit SETTLE alternative. The two kill scores remain separate.

[HANDOFF-MUTANTS.json](./HANDOFF-MUTANTS.json) stores exact edits, variants,
first discrepancies, alias/index coverage, identity witnesses, the work table
and classification notes. [HANDOFF-PARITY.json](./HANDOFF-PARITY.json) stores
the pristine counterpart; raw observations are in the named cache artifacts.
No new Quant defect was found in this bounded sweep, and no production mechanism
or representation change follows from it.

## Reproduction

```sh
npm run test:history-handoffs
npm run test:history-handoffs -- --mode production
npm run research:handoffs
npm run research:handoff-mutants
npm run typecheck:history
```

The complete suite passes 434 DEV tests and 427 PROD tests with seven diagnostic
skips. Strict oracle/source typechecks and formatting checks pass. The installed
TypeScript ESLint recommended rules are used with the temporary config because
the checkout still lacks its declared eslint-config-prettier installation.
The physical-GC and engine-history domains are unchanged.
