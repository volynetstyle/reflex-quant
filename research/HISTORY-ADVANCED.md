# History search with imperative callbacks, host state and physical experiments

LOG 55 implements stages 2–8 of [HISTORY-SEARCH.md](./HISTORY-SEARCH.md).
The contract is unchanged. This is a collection of finite semantic domains,
source mutation witnesses and two engine experiments; their results have
different meanings and must not be combined into a history-independence theorem.

The subsequent [temporal ownership sweep](./TEMPORAL-OWNERSHIP.md) (LOG 56)
targets causal extinction boundaries and adds direct DEV/PROD observations and
an automatically discovered conditional-mask mutation axis. Its catalogue and
negative results are separate from the 12-seed score recorded here.

## Independent imperative oracle: stages 2 and 3

`test/support/imperative-language.ts` interprets scalar expressions and bounded
instruction bodies. Instructions can read, write, publish computed/watchers,
dispose, explicitly run, log, assign registers, branch, return, fail, catch,
batch and execute untracked code. The same instructions run inside computed
bodies, watcher bodies and consumed cleanups. Callback execution, cleanup
execution, returned values, errors and explicit logs are observations. Published
definitions and registers are part of the program state, so equal graph values
alone cannot certify a history pair.

`imperative-spec.ts` implements the reactive semantics independently with Maps,
unbounded versions, committed/attempt frontiers, causal retry evidence and a Set
queue. It does not import Quant's graph, flags, generation, stack or ring
algorithms. The interpreter is shared language semantics; the reactive ports are
separate implementations. C1-invalid demands are rejected by model preflight
before executing Quant. A 200,000-instruction fuel bound per operation and a
10,000-delivery model bound exclude unbounded executions from this domain.

The model preserves the first successful source observation (P5), distinguishes
computed execution debt from watcher wake evidence, consumes cleanup before
calling it, preserves the first operation error, and rolls back an unpublished
effect if any delivery in its opened drain fails. Deferred constructors have
already returned their handle and use F3. A child established by a failed parent
has its own lifetime; there is no ownership extension.

Automatic delivery uses the actual Quant public API. Manual delivery remains
available as a separate mode. The model selects FIFO with per-source relation
birth order as its scheduling convention; this convention is included in its
checkpoint, not promoted to a new contract invariant. Model versions are
unbounded JavaScript integers within the campaign's finite safe-integer range.

`imperative-worlds.ts` compares each top-level operation vertically: observations,
public cached values/lifecycles, registers/definitions and live relation pairs,
including failed-attempt relations. Each Quant operation also receives graph,
retirement, physical slot, disposed-watcher and queue-token audits. Prefix pairs
are admitted only at equal successful ready model checkpoints; suffixes compare
both outputs and the next model state. Absolute counters and implementation
fingerprints do not decide admission.

The reentrant corpus has 13 named witnesses, including one deliberately invalid
C1 demand, plus all 60 combinations of two delivery modes, three callback
positions, five actions and optional failure. The five actions are write-self,
write-other, dispose-self, dispose-other and nested read. Additional pairs cover
P5 discharge, different batch partitions and a 1,024-watcher burst versus steady
construction/disposal. The latter share the same published disposed handles;
2,048 subsequent small deliveries return both rings to mask 255. Exact shrink
timing is a check of the selected host policy; the general storage envelope is
audited separately. Host fingerprints include head/mask/size/hold/spare/calm,
peak queued occupancy and every physical queue slot.

### Production defect found

The previous production `exec` entry cleared `Pending` but retained `WOKEN`;
development cleared `PendingMarked`, which includes that bit. A cleanup writes
an observed source **before** the next body begins; that body reads the source
and throws. Production incorrectly retained the earlier wake as permission to
retry the failed body in the same drain. The retry could succeed and install a
new cleanup even though no source changed after the failed attempt began. This
violates F3's cold failed watcher rule.

The public API regression in `test/semantics.test.ts` and the imperative witness
`cleanup-write-before-failed-body-is-not-in-pass-invalidation` pin the case. The
repair makes the existing entry store clear `PendingMarked` in both builds.
Writes during the body still set a fresh wake and retain W2/F4 redelivery. This
is a semantic repair with no added field, flag, allocation or mechanism. The
`pre-run-woken` source mutant restores the faulty production expression.

While developing the independent model, its own handling of F1 validation
failure, F4 body/cleanup writes and pre-body versus in-body invalidation needed
correction. Those corrections are model defects, not additional Quant findings.

## Small actual counters: stage 4

`research-quant.ts` loads fresh actual Quant modules with a scoped test mock of
the exported graph constants: `Mask = 3, 7, 15` and `SETTLE = Mask >> 1`.
Production source and its algorithms are unchanged. A native check proves both
version and generation wrap occurred. The independent model keeps unbounded
versions.

For each mask, a fixed prelude performs more than four full cycles of source
changes and computed executions, with repeated failure/recovery. Every word of
length 1–4 over toggle-source/read-computed/flush is then compared: 120 words per
mask, 360 total. These are exhaustive continuations of the stated preludes, not
an enumeration of every possible multi-cycle history, disposal pattern or
unbounded counter run. No divergence was found in this domain.

## Feedback-guided scars: stage 5

`history-greybox.ts` has separate spec admission, implementation fingerprinting,
distance and continuation search. Fingerprints include flags, absolute ver/gen,
edge identities/order, cumulative births/retirements/work, stack capacity and
high-water, plus host registers. Edge identity bookkeeping uses WeakMaps; no
edge object escapes in a fingerprint. Numeric distance is the sum of signed
log-scale differences, with categorical differences counted separately.

The seeded generator mutates genomes of at most eight blocks by insertion,
deletion, replacement and reversal. Blocks interleave failure, branch changes
and source ABA before recovering. Only vertically correct, spec-admitted novel
fingerprints become mutation parents; parent selection is weighted by scar
distance. Fingerprints guide discovery, never semantic judgment.

The recorded production campaign uses seed `0x55ace`, candidate budget 256 and
stagnation bound 16. It admitted 153 candidates, found 34 fingerprints in one
model checkpoint class, and stopped after 16 consecutive admitted candidates
without novelty. The farthest observed pair was fresh versus genome
`0.1.0.0.0.2.0.2`, distance 63.96076532432932. This is empirical saturation under
one generator/seed/bound, not exhaustive saturation of Quant states. Its common
suffix BFS completed depth 2 over read-c/write-a=2/flush: all 12 nonempty words,
without spec-only path pruning. No distinguishing continuation was found.

[SCAR-SEARCH.json](./SCAR-SEARCH.json) stores the concrete prefixes, both
fingerprints, checkpoint and continuation result. The static smoke corpus also
checks that different model states cannot become a pair merely because their
fingerprints are distant.

## Source mutation score: stage 6

`temporal-mutants.mjs` copies source into isolated cache directories, applies one
catalogued edit, then runs named production witnesses against that source via
`QUANT_SRC`. Original source is never edited. Every selected witness must pass
with pristine source first. A failed assertion is a kill; import/compile errors
are invalid, timeouts are separate, and all 12 seeds remain in the denominator.
Adapter fault fixtures are not counted.

The seeds restore the pre-body WOKEN bug, preserve consumed cleanup, retain
QUEUED, disable ring shrink, omit SETTLE, retain popped stack slots, retain
retired nextSub/prevDep, keep Dirty on entry, refresh a reread's version, lose
failed watcher execution debt, and replace the first drain error. The final
score is **12 killed / 12 seeded**, zero surviving/invalid/timeout.

The first campaign killed 11/12: the stack-slot seed survived because its chosen
wide graph did not push a sibling on the propagation stack. A branching graph
with separate sibling sources repaired the witness; the rerun killed it. This
was a coverage gap, not evidence that the mutation was harmless.

[TEMPORAL-MUTANTS.json](./TEMPORAL-MUTANTS.json) records source hash, exact edits,
test selection and assertion evidence. Where the interpreter reports a first
different operation, `firstDivergenceStep` records its one-based position in that
fixed witness. It is **not** a globally minimal continuation depth; selected
direct structural assertions can have no such interpreter position. The ring
shrink seed is qualified by the chosen host policy, rather than a claim that
this exact shrink schedule is universally necessary.

## Physical collection: stage 7

`experiment-runtime.mjs` builds clean production source without Vitest's
allocation registry, root snapshots, stats or retirement hooks. Every physical
cohort runs in a fresh `--expose-gc` Node process. Retired trial edges must have
all four neighbour pointers null. Their immutable `from`/`to` are preserved.

The trial creates a young payload in the source's value (`from`) or disposed
consumer's cached value (`to`). It compares older trial edges, later-born edges
and ordinary Node carriers under fresh, aged and edge-allocation-conditioned
histories. The conditioning holds many real edges through earlier collections
at the allocation site, then releases those training roots before the trial.
These are age/pretenuring **conditions**, not measurements of individual object
generations or proof that V8 promoted any particular edge.

Two trials × two endpoints × three histories × three treatments give 36 endpoint
cases. Four explicitly retained retired edges are positive controls; two bare
WeakRef payloads are baseline controls. All fixture locals/closures and training
roots are dropped, then a new job runs before collection. WeakRef reads occur
after each collection, with a job boundary before the next request.

The collection schedule requests three minor then three major collections.
Observed GC kinds and before/after heap-space sizes are recorded using
[Node's performance API](https://nodejs.org/api/perf_hooks.html); request options
follow the [V8 GC extension](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/extensions/gc-extension.h).
The recorded Node v25.2.0 / V8 14.1.146.11-node.13 run collected all 36 endpoint
payloads and both bare controls at the first major collection. All four retained
edge controls remained alive, and no cohort was invalid.

**Minor-retention attribution is inconclusive:** even bare WeakRef payloads
survived every minor request. Thus this oracle did not distinguish additional
young retention through `from`/`to`, and the experiment does not establish those
endpoints as safe under arbitrary promotion/pretenuring. It does establish
major reclamation within this schedule and working positive controls.
[GC-HISTORY.json](./GC-HISTORY.json) preserves all cohort curves and events.
No endpoint representation change follows from this result.

## Engine history: stage 8

`engine-history.mjs` uses the same clean production construction in separate
processes. Prefixes are fresh, number→object→bigint→number, degree 256→1, and
failure plus dependency churn. Each finishes with the same logical scalar graph
and cached values. A common workload has an independently calculated checksum.
Five common warmups precede nine timed rounds; the last five define the late
median. Five trial groups alternate prefix order, with 200,000 iterations per
round. No timing threshold is a correctness assertion.

The recorded median late ratios `changed / fresh` are 0.731 (polymorphic), 0.823
(high degree), and 0.866 (failure/churn). All checksums and logical graphs agree.
This run shows no persistent slowdown for these prefixes/workload; the differing
costs are observations on this machine, not a performance ranking or proof of a
specific shape/deoptimization cause.

Separate diagnostic children use 20,000 iterations per round and run with
optimization/deoptimization tracing, so
tracing overhead does not enter the timing sample. The JSON retains phase-window
counts, deoptimization examples and raw-trace cache paths. Native trace writes
can interleave with phase markers; counts classify emission windows and do not
attribute background compiler work exactly to an execution phase.
[ENGINE-HISTORY.json](./ENGINE-HISTORY.json) contains the logical graph, runtime
hash, CPU/OS identity, checksums, raw timing rounds and paired ratios. These experiments do not
extend the contract or its structural bounds.

## Reproduction and validation

```sh
npm run test:history-advanced
npm run test:history-advanced -- --mode production
npm run typecheck:history
npm run research:scars
npm run research:temporal-mutants
npm run research:gc
npm run research:engine
```

`QUANT_SCAR_STEPS` controls the greybox candidate budget. `QUANT_GC_TRIALS`,
`QUANT_ENGINE_TRIALS` and `QUANT_ENGINE_ITERATIONS` control physical/timing
budgets. Run timing without concurrent campaigns. JSON reports are replaced
when their campaign is rerun; they are evidence snapshots, not test fixtures.

The complete suite passes 268 development tests and 261 production tests with
seven development-diagnostic skips. Source and strict advanced-oracle typechecks
pass. The production release passes ESM/CJS/declaration checks and 5,400
minified/unminified scenario steps, with one Node and one Edge allocation site;
the standalone production bundle is 2,717 B gzip. Standard `npm run lint` is
unavailable in this checkout because its declared `eslint-config-prettier`
dependency is missing. The installed TypeScript ESLint recommended rules pass
with a temporary config, and source Prettier checks pass separately.
