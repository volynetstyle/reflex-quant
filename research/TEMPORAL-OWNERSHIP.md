# Temporal ownership: extinction boundaries and boundary twins

This is the LOG 56 bounded sweep, following [HISTORY-ADVANCED.md](./HISTORY-ADVANCED.md).
The next [handoff sweep](./TEMPORAL-HANDOFFS.md) (LOG 57) transfers obligations
between these same 17 facts and adds classification-coverage metrics alongside
the original scores. It does not retroactively expand this domain.
The known F3 correction was first backported to main as `5c847db`: only the
existing entry mask, its public API regression and a research-log record. Its
regression failed on the old production machine (three runs instead of two),
then passed on both builds. The new sweep does not count that rediscovery as a
new Quant defect. The infrastructure described here stays on the research branch.

## Ownership matrix

`temporal-facts.mjs` is the machine-readable matrix and source mutation catalogue.
Facts are interpreted with their lifecycle predicates: for example, `fn === null`
is terminal, so uninterpreted Dirty bits on a disposed object do not create a
live execution obligation. This matrix does not require zeroing every field.

| Fact | Birth | Owner interval | Extinction boundary | Allowed residue |
| --- | --- | --- | --- | --- |
| Stale | write/mark below a changed source | pending source validation | validation descent or exec entry consumes the old mark | a new mark during the current validation/body |
| Dirty | first run, direct change, failure | execution debt | exec entry consumes earlier debt | failure installs new debt on its own unwind path |
| Woken | signal change reaches a non-Busy watcher | delivery/body-attempt boundary | body entry consumes the pre-body wake | in-body invalidation uses Stale and delivery, rather than this bit |
| Queued + queue cell | host wake | one queued delivery | dequeue transfers ownership to its local watcher, then deliver clears the token | a new callback may enqueue a new entry |
| Busy | exec entry | one dynamic body invocation | success/failure unwind | none at rest |
| Checking | DEV validation descent | one validation frame; same bit as watcher Woken | clean return, exec entry or failure unwind | none on a computed at rest |
| cleanup | successful watcher returns a function | one lifecycle epoch | consumed before invocation on rerun/disposal | only a later body's newly returned cleanup |
| active/cursor | exec/untracked saves caller | one dynamic execution frame | matching return/throw restores caller | caller's exact saved context |
| UNREAD | marking/indexing an old suffix | tracking pass or dirty failed frontier | successful observation, commit/cut | unread old frontier while debt remains |
| SKIPPED | near-tracking skip | unread suffix in a pass or failed frontier | observation or retirement | marker on a dirty failed frontier |
| source.slot | index claim | innermost indexed consumer | matching unindex | exact displaced outer owner's cell |
| stack cell | traversal push or displaced slot claim | push-to-pop interval | matching pop/unwind nulls physical cell | other still-owned cells; capacity is a separate policy |
| edge.gen/node.gen | relation born in next execution epoch | tentative/current failed frontier | successful commit or retirement; SETTLE bounds age | committed relation identity |
| dep/sub neighbours | relation unlink/cut | retirement operation | sever pointers into live graph storage | interior pointers within one retired run; immutable endpoints |
| hold/head/size/mask/spare/calm | batch/drain opens host work | nested batch/drain | outer drain closes hold and clears active queue slots | bounded capacity and permitted spare/calm hysteresis |
| first error | first operation error | operation plus remaining drain/rollback | rethrow; next operation starts fresh | no error from a previous operation |
| fn null | disposal | rest of object lifetime | terminal, no resurrection | cached computed value, no live deps or watcher cleanup |

One concrete correction to a bit-level reading of the motivating example:
`write()` takes its Busy branch first. A write during a running body creates
**Stale**, and a watcher is handed back to the host. A cleanup write reaches a
non-Busy watcher and can create **Woken**. Thus W2's new causal evidence need not
be the same physical bit as the pre-body evidence F3 must consume.

## Finite boundary corpus

`test/support/temporal-boundaries.ts` generates 104 programs. They are boundary
twins, not an assertion that moving an event across a boundary preserves its
meaning. The model is expected to distinguish opposite causal obligations.

| Family | Programs | Perturbations |
| --- | ---: | --- |
| Deliver phases | 42 | seven callback-accessible positions × write/dispose-self/dispose-other × optional body failure |
| Validation/lifecycle | 20 | ancestor or checked watcher disposal, other watcher disposal, or another-source write; during nested validation versus body, with/without throw |
| Cleanup | 16 | manual/automatic delivery × write/self-dispose/new watcher/nested read × optional cleanup throw |
| Nested indexing | 16 | depth two/three, overlapping 40-source indexes, inner failure and disposal of inner/parent/other consumer |
| Temporary markers | 6 | swap/stride/reverse with partial failed attempt or success, then recovery and reordered reads |
| First error | 1 | batch error precedence, then one constructor operation with body A → cleanup B → sibling C → rollback D |
| Epochs | 3 | forty failure/recovery/neighbor cycles; replacement of failed reads without a successful commit; newly committed computed frontier |

The delivery positions are before target dequeue (an older watcher's body),
during check (computed callback), cleanup, body before/after read, caught inner
failure unwind, and an operation after failure. All mutations come from actual
user callbacks or public operations. There is no fabricated user callback
between dequeue and the next callback-free store, or between a cleanup's return
and exec entry. The last cleanup action exercises the latter boundary.

Likewise, index/claim loops are callback-free on ordinary runtime fields. These
programs fail after the index has claimed its slots but before the consumer has
finished reading its frontier; they do not claim to throw halfway through an
otherwise atomic claim loop. Instrumented native builds prove peak simultaneous
index owners of two/three and nonzero displaced-slot restoration, rather than
inferring indexing from the shape of an input. For example, the depth-two normal
case records peak two, 99 displacements and ten index passes.

The Vitest suite has 106 tests: these 104 programs plus epoch replay with actual
counter masks 3 and 7. Existing graph, retirement, queue-token and physical-slot
audits run after every top-level instruction. Arbitrary JavaScript, asynchronous
interleavings, allocation failure and C1-invalid demands remain outside the domain.

## Independent model and direct DEV/PROD axis

Two initial validation cases exposed an oracle bug: a child disposed its
validating ancestor, but the model still tried to call the removed callback.
Quant already honored W3. The model now rechecks disposal after validation and
does not resurrect failure metadata on a disposed node. This is a model repair,
not a Quant defect or a contract change.

`temporal-runtime.mjs` builds fresh actual-source DEV/PROD modules with optional
mask 7. The independent interpreter/model are bundled separately. Test-only
transforms expose registers, count simultaneous index owners and collect
operation-scoped retirement witnesses. All failed/unpublished allocations are
included in the structural audit. These retained registries are deliberately
excluded from physical GC experiments; this is a logical ownership oracle.

`temporal-observer.mjs` first admits each program using only the model, then
compares its actual observations, public cached/lifecycle state, registers,
definitions and relation pairs vertically at every top-level operation. Structural
audits also check both queue/token representations and all physical stack/queue
slots at rest. Mutants never decide eligibility. Runtime callbacks throwing
unexpected errors are discrepancies, not an excuse to exclude a program.

The native corpus combines the 104 new programs with 72 existing valid imperative
cases. The one deliberate C1 example is excluded. Each of four pristine builds
passes **176 programs / 4,465 operations**. Actual DEV and PROD observation arrays
are then compared directly for both full counters and mask 7, not just through
transitivity via the model. They agree. The wire encoding preserves undefined,
NaN and negative zero. Report hashes summarize arrays that were compared exactly;
hash equality is not the comparison oracle.

[BOUNDARY-PARITY.json](./BOUNDARY-PARITY.json) records pristine runs and concrete
coverage. Raw per-operation observations live in the listed cache artifacts.
This is equality of the recorded finite traces, not arbitrary DEV/PROD equivalence.

## Systematic source mutations and surviving controls

Each of the 17 fact rows has four seeded operator families: retain an expired
fact, clear evidence early, change a sibling role/field, and restore earlier
state across the wrong return boundary. Concrete edits account for each
representation; the operator names do not assume every edit must violate the
contract. AST discovery additionally finds **all eight `__DEV__` mask/store
sites** in the current kernel: seven conditional expressions and one guarded
flag store. Forcing both branches independently yields 16 more seeds. Exact
source ranges and edits are recorded.

Source transforms are applied to in-memory build inputs. Every seed gets fresh
DEV/PROD full/mask-7 executions until a discrepancy is found. No production file
is mutated. A seeded variant must compile; crashes/compile errors are invalid,
timeouts are separate, and neither is silently called a kill. Only valid-domain
semantic discrepancies or explicit ownership/graph/retirement audits kill a seed.
First differing operation positions describe fixed witnesses, not globally
minimal continuation depths.

The final result is **68 killed / 84 seeded**, 16 survived, zero invalid,
timeout or coverage-gap results. The initial expression-only pass was 65/82. Its surviving
tentative-birth and generation/version-confusion seeds prompted the two extra
frontier witnesses; both are now killed (67/82). Including the guarded flag store
adds two seeds and exposes one additional expiry fault. These are measured
coverage improvements, not newly discovered Quant defects.

The remaining 16 survive the finite observation domain; they are not hidden or
counted as successes:

- Twelve concern diagnostic paths: eleven forced DEV choices and Checking's early
  clear. The admitted domain excludes C1-invalid demands, so survival does not
  test preservation of the cycle diagnostic.
- Dirty/Woken early clears act only at the successful body exit. Busy writes
  create Stale, and failure debt is installed elsewhere; by inspection these
  edits do not erase those new facts at that store.
- SKIPPED's early clear needs a tracking-work bound witness to assess the missing
  marker. This campaign does not measure its asymptotic edit-work envelope.
- Restoring gen to zero also makes the existing SETTLE condition true after
  every successful commit. The alternative restamps the full frontier every
  time. Survival does not justify removing generation machinery or establish
  that alternative's general correctness/cost.

The denominator retains all 84 seeds, including observationally inert controls;
81.0% is not a universal bug-detection probability. Assessments in
[TEMPORAL-BOUNDARIES.json](./TEMPORAL-BOUNDARIES.json) are post-campaign inspection
notes, never inputs to the oracle. The older 12/12 temporal score remains a
different catalogue/domain.

No additional Quant defect was found after the known F3 repair. No new production
state or mechanism was added by this sweep.

## Reproduction and validation

```sh
npm run test:history-boundaries
npm run test:history-boundaries -- --mode production
npm run research:boundaries
npm run research:temporal-sweep
npm run typecheck:history
```

Baseline-only and mutation runs write separate reports. `QUANT_BOUNDARY_ONLY`
restricts native cases for debugging and correspondingly narrows the reported
domain; leave it unset to reproduce the recorded result. Source hashes, runtime
hashes, exact edits, first discrepancies, exclusions and cache paths are retained.

The full suite passes **374 development tests**, **367 production tests** plus
seven development-diagnostic skips. Source and strict oracle typechecks pass.
The isolated main backport also passes its 43 DEV semantic tests, 37 PROD tests
plus six skips, and the ESM/CJS/declarations/minified release check (5,400 steps,
2,717 B gzip, unchanged Node/Edge shapes). Missing installed
`eslint-config-prettier` still prevents the checkout's standard lint config;
installed TypeScript ESLint recommended rules and separate formatting checks
are used as recorded in LOG 55.
