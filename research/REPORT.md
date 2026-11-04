# The smallest runtime Reflex's invariants imply

Experiment: derive a reactive runtime from Reflex's semantic contract and
executable spec, not from its implementation; keep every mechanism a test
forces and nothing else; compare it with the spec, current Reflex (`dev`
`bf71877`) and alien-signals 3.2.1. Code: `src/kernel.ts`, `src/host.ts`,
`src/index.ts`. Design history: [LOG.md](./LOG.md) (20 entries, each with
its counterexample). Ablation record: `mutants.json`.

**Result.** The invariants admit a substantially different architecture of
about the same per-object size: versions instead of change bits, an
on-demand source-side index instead of tape and stamps, and per-relation
generations for exact failure semantics. It matches the executable spec,
amended by two of Reflex's documented choices, on every program of the
bounded and recovery languages and on 100,000 generated programs. On the
same corpus Reflex is that contract plus three failure-path choices, which
the experiment isolates exactly. On CI it is within 25 % of the better of
Reflex and alien-signals on 14 of 18 scenarios and faster than both on 8
(section 6).

## 1. Contract inventory (phase 0)

Sources: `test/differential/docs/SEMANTIC_CONTRACT.md`, the spec runtime
(`internal/machine/spec-runtime.ts`), `docs/RUNTIME.md`, `docs/DISPOSE.md`,
MODEL.md (branch `docs/runtime-rewrite`), the differential catalogs and the
bench workload definitions. The current tracking code was not read before
the first architecture pass.

**A. Semantic (mandatory)**

| Invariant | Source | Pinned here by |
| --- | --- | --- |
| a computation observes exactly the sources it read; dynamic branches add and drop relations | spec `track`, RUNTIME "Computed consumers" | tracking.test "branch switch", "prefix/suffix edits" |
| one relation per (source, consumer) pair, under repeats, reorders, nesting, failures | INVARIANTS §1 axiom | `checkGraph` after every differential operation; tracking "duplicate after prefix", "old twin", "nested indexed pass" |
| change is a version fact (`Object.is` at commit; ABA counts) | spec `version` | probe P6 |
| cutoff: an unchanged computed does not propagate | RUNTIME, spec rule 3 | P7, semantics "cutoff" |
| no glitch, one execution per node per wave | (implied) | semantics "diamond", "layered diamond 8x8" |
| validate ≠ execute: watchers validate their whole committed set before any lifecycle step (V3) | SEMANTIC_CONTRACT V1–V6 | P10 |
| C1–C3: a failed computed commits nothing and executes on its next demand | SEMANTIC_CONTRACT | recovery language, P2 |
| C4/R3: a read that threw is no observation | SEMANTIC_CONTRACT, F18 boundary | contract-boundary catalog |
| W1–W3: cleanup consumed first; a failed watcher is cold and wakes on committed ∪ last-attempt reads | SEMANTIC_CONTRACT, spec `retrySnapshot` | P3, P4, P5, P8 |
| R2: an execution obligation survives a failure | SEMANTIC_CONTRACT | P9 |
| L1–L5: a watcher invalidated during its own run is delivered again; exact cutoff | SEMANTIC_CONTRACT | semantics "effect writing a source converges", "not-yet-read source adds no rerun" |
| nested evaluation never corrupts the outer pass | spec `withCollector` | tracking "nested indexed pass" |
| disposal: terminal, cleanup after teardown, no ghost relations, safe inside the node's own pass | DISPOSE.md | semantics "dispose inside the callback, then more reads" |
| batching defers effects only | RUNTIME "batching" | semantics "batching" |

**B. Structural:** no allocation and no lookup per stable read; no new
relation when one exists; no Θ(d²) tracking; graph size proportional to live
relations; repeated failures do not accumulate relations; nesting does not
rebuild global state (structure.test, tracking.test).

**C. Performance:** the bench scenarios of section 6, chosen to match the
task list; target within 25 % of the better of Reflex and alien-signals on
common shapes, hostile shapes reported as measured.

**Where the written contract, the spec and Reflex part.** Ten probes
(`test/support/probes.ts`) pin the edges of the contract. Five regions
separate the three:

| Id | Region | Spec | Reflex | Quant | Classification |
| --- | --- | --- | --- | --- | --- |
| D1 | computed validation: first source changed, a later one now throws (P1) | validates the whole frontier: throws | existential: no throw | = Reflex | unclear contract: MODEL §4 says existential, the spec is universal. Existential does no work a re-execution would not do (read order) |
| D2 | failed computed whose old frontier now throws (P2) | validates the old frontier first | executes | = Reflex | spec deviates from C3's text ("next demand executes") |
| D3 | watcher validation after a failed run read a new computed (P3) | not validated (tentative) | validated | = spec | Reflex implementation detail; contradicts W2/V3 |
| D4 | wake set after repeated failures (P4) | committed ∪ last attempt | union of all attempts | = spec | Reflex implementation detail; contradicts W2 |
| D5 | failed watcher woken through an unchanged computed (P9) | runs (obligation kept) | idle: nothing runs | = spec | **Reflex defect against R2**, documented as intended in INVARIANTS §3 ("otherwise idle") |

The contract spec (`test/support/contract-spec.ts`) is the spec with D1 and
D2 applied and nothing else. Quant equals it on every program run.
Emulating D3, D4 and D5 inside quant (`research/mutants.mjs
--emulate-reflex`) reproduces Reflex on all 100,000 generated programs. So,
on this corpus, Reflex = contract spec + D3 + D4 + D5, and the five regions
are the whole difference. None of them occurs in the existing bounded,
recovery or historical corpora (the active-divergence catalog is empty);
the generated family reaches D3–D5 in 0.8 % of programs.

D5 needs a decision. RUNTIME.md and INVARIANTS §3 describe the idle state
as intended; SEMANTIC_CONTRACT R2 and the spec say the obligation survives.
Minimal witness (shrunk): watcher `w = c3 > 1 ? throw : c3`, `c3` a computed
whose value does not change on the next write; Reflex never re-runs `w`
after its failure, the spec does.

## 2. The machine

**Node** (one shape for signal, computed, watcher; 10 fields): `flags`,
`value`, `version`, `fn`, `deps`, `cursor`, `subs`, `subsTail`, `slot`,
`gen`. **Relation** (8 fields): `from`, `to`, `version`, `gen`, `prevDep`,
`nextDep`, `prevSub`, `nextSub`. **Kernel bits:** STALE (may be out of
date; for a watcher: validate), DIRTY (must execute), RUNNING (pass on the
stack), INDEXED (pass uses slot cells), WATCH (root), WOKEN (watcher woken by
signals only: execute without validating). **Host bits:** SCHEDULED, QUEUED,
RETRY.
**Mutable globals:** kernel `active`, `deliver` and three transient stacks
(`displaced`, `siblings`, `descent`); host `queue`, `depth`, `flushing`.

- **Write:** commit, bump `version`; direct subscribers get DIRTY unless
  RUNNING; everything downstream gets STALE in one iterative depth-first
  walk that stops at nodes already STALE; a watcher becoming STALE is handed
  to the host.
- **Read:** a computed that is STALE or DIRTY is refreshed; then, inside a
  pass, the read is tracked. A refresh is an iterative descent in read
  order: the first source whose version differs makes the node execute; a
  STALE source is descended into, a DIRTY one executes.
- **Tracking:** `deps` is kept in read order; the hot path compares the next
  relation's source and advances `cursor`. A miss tries bounded exact scans
  (unread suffix, accepted prefix, the source's subscribers); otherwise the
  pass indexes its relations in their sources' `slot` cells once (O(d)),
  after which every read is an O(1) exact answer: duplicate, move, or new.
  A successful pass cuts the unread suffix.
- **Failure:** nothing commits; the node is DIRTY; relations born since the
  last success (`edge.gen === node.gen + 1`) are tentative: they wake but are
  not validated, and unread ones from earlier failures are dropped.
- **Host:** a watcher runs as validate all committed sources → if owed,
  consume and run the cleanup untracked → execute. Effects run only inside
  a FIFO drain loop; batch defers the drain.

## Q1. What survived

| Reflex concept | Re-emerged as | Mechanical reason |
| --- | --- | --- |
| bidirectional intrusive relations | the same: one relation object in two doubly linked lists | push needs subscribers, validation needs sources in order, removal must be O(1) from both ends |
| two dirty states (`Unknown`/`Changed`) | STALE / DIRTY | push knows "may have changed"; only failures, first runs and direct writes know "must execute". Validation turns the first into the second |
| `Computing` | RUNNING | cycle detection and disposal deferred to the end of the node's own pass |
| read-order cursor (`tailIn`) | `cursor` | stable traces must cost one comparison per read; read order also makes existential validation waste-free |
| relation reuse and moves | the same | a reorder must not allocate |
| preserve the unread suffix until success | prune on success only | W3: committed relations a failed attempt did not reach must still wake |
| `Scheduled` + host queue | QUEUED + FIFO queue in the host | the kernel only delivers; deduplication and timing are host policy (LB3) |
| universal watcher validation | `validateAll` | V3 |
| `edge.born` (a research branch, never merged) | `edge.gen` | forced here by W2/V3 exactness, not by absence proofs: a per-relation fact is the floor (MODEL LB2) |
| `Unknown` versus `Changed` on watchers | STALE versus WOKEN | a watcher woken by signals only has clean computed sources, so its universal validation is vacuous; measured on fan-in (LOG 21) |
| explicit walker stacks | `siblings`, `descent` | depth must not be bounded by the call stack (a 20,000-deep chain overflows the recursive kernel) |
| producer hint (INV-H) | the `slot` cell | the same object-local cell answers pair membership, here only during an indexed pass and always exactly |

## Q2. What disappeared

- **Tape (INV-P) and prepared cells: gone.** Nothing equivalent persists
  between passes. The `slot` cell is the closest relative: it exists only
  inside an indexed pass, holds exactly the consumer's own relation, and is
  cleared at the pass's end. It makes the absence proof O(1) after one O(d)
  walk of the consumer's own list, which costs no more than the pass.
- **Tracking stamps, the global clock, `trackingStamp` registers: gone.**
  Relation versions classify a push into a running pass for free: a source
  written before it is read is read at the new version. The prefix filter,
  INV-T2/T3 and the stamp-collision class do not exist.
- **`Visited`, `Revalidate`, `Leased`, `WatcherCleanupPending`: gone.**
  Versions on relations carry the "a source I already read changed" fact
  that `Visited` stores. The cleanup is the watcher's value and is consumed
  before it runs.
- **Finger, lockstep, rounds, strike register, hint repair: gone.** Bounded
  scans (≤ 8 relations each side) plus the index cover the same cases with
  linear worst cases.
- **Contexts, execution domains, runtime phase registers, hooks: gone.**
  They are integration surface, not semantics.
- **`lastIn`:** not needed; the suffix cut walks from the cursor.

## Q3. What is fundamentally necessary

Every remaining mechanism has a counterexample: removing it fails a test.
22 of 23 ablations are killed (`research/mutants.mjs`, `mutants.json`): 17
by semantic tests, 4 only by structural bounds (the optimizations of Q4), 1
only by tests that assert sibling order (the convention of Q4). The
survivor, `no-fresh-source`, is a pure constant factor that only CI timing
sees (LOG 22).

| Mechanism | Smallest counterexample (test or probe) |
| --- | --- |
| relation versions | P6 (direct ABA must re-run); "a write to a not-yet-read source during the run adds no rerun" (`direct-dirty-running`) |
| read-ordered deps + cursor | "stable graph: no allocation and no lookup per read" |
| slot index + UNREAD marks | "random permutations of 64 shared sources: exact, no allocation, linear work" (`no-unread`) |
| displaced-cell stack | "a nested indexed pass restores the outer pass's cells" (`no-displaced`: a duplicate relation) |
| prune on success only | P5 (`cut-on-failure`) |
| relation/node generations | P3 (`validate-tentative`), P4 (`keep-tentative`) |
| DIRTY after any failure | P9 (`idle-after-failure`) |
| DIRTY after a failed validation | "after a failed validation the effect is re-delivered" (`validation-stale`) |
| RETRY host bit | historical fault `validation-history-dependence`, recovery language (`no-retry`); re-delivery test (`retry-as-stale`) |
| clear STALE before the pass | "an effect writing a source it read converges", F1 test (`clear-after`) |
| deferred disposal | "dispose inside the callback, then more reads: no ghost relation" (`eager-dispose`) |
| RUNNING on read | "cycles throw" (`no-cycle-check`) |
| universal watcher validation | P10 (`existential-watcher`) |
| STALE, not WOKEN, for a running watcher | "a write to a not-yet-read source during the run adds no rerun" (`woken-when-running`) |
| repeat check before the scans | bounded language (`no-repeat-check`: a duplicate relation) |
| drain-loop-only effects | "effects created inside a batch or another effect run after it" (`run-direct`) |
| iterative push and pull | "push and pull are not bounded by the call stack" (the recursive v2 kernel overflows) |

## Q4. Optimization versus semantics

| Class | Mechanisms |
| --- | --- |
| correctness | relation versions; read-ordered deps; uniqueness (index, UNREAD, displaced stack, repeat check); STALE/DIRTY; clear-before-pass; RUNNING (cycles, deferred disposal); WATCH delivery |
| failure semantics | prune on success only; generations (tentative relations); DIRTY after failure and after failed validation; RETRY; universal watcher validation (V3) |
| asymptotic | the slot index (exact O(1) per read after an O(d) walk, instead of Θ(d²) scans); iterative push and pull (depth not bounded by the stack) |
| constant factor | DIRTY on direct writes (O2); WOKEN (no vacuous watcher validation); bounded scans before indexing (O1); the no-subscriber absence check; `readSignal`; delivery on the STALE transition; no version compares once owed |
| convention | `subsTail` (FIFO sibling order; only order-asserting tests fail without it) |
| removed as unnecessary | the run() guard against a watcher on the stack (no API path reaches it) |

## Q5. Complexity comparison

Reflex: `packages/reflex-runtime/src/kernel` + `src/protocol`, without
dev, profiling, projection and domains. Quant: the three production files.

| | Reflex | Quant |
| --- | --- | --- |
| implementation lines (code lines) | 5,610 (3,671) in 42 files | 712 (553) in 3 files: kernel 542 (423), host 113 (87), index 57 (43) |
| of which tracking and graph shape | 1,881 (1,114) | 123 code lines (miss path, index, scans, links) |
| minified bundle, gzip | 8,980 B (whole internal surface) | 2,023 B (kernel + host + API) |
| node fields | 8 | 10 |
| relation fields | 7 | 8 |
| node state bits | 10 production (+2 dev) | 6 kernel + 3 host |
| global runtime state | context bank: consumer, stamp, propagation and batch depth, phase, frame, hooks; module registers; walker stacks | `active`, `deliver`, 3 transient stacks; host queue, depth, flushing |
| queues | host-owned (none in the kernel) | one FIFO in the host |
| allocations per new relation | 1 | 1 |
| allocations per stable read | 0 | 0 |
| stable read work | cursor hit | cursor hit: 1 comparison, 2 stores |
| dynamic reorder work | finger, lockstep, tape | ≤ 24 comparisons per miss, else one O(d) index walk per pass |

The soft budget (kernel ≤ 300 lines) is exceeded by 41 % in code lines.
What forced it: exact uniqueness without hashing (miss path, index, scans:
123 code lines), the iterative pull with its failure unwinding (55), and the
exact failure bookkeeping (abort, generations: 22).

## Q6. Performance

CI only (GitHub Actions `ubuntu-24.04`, Node 24.22.1, one job for all three
runtimes). Every (runtime, scenario) pair runs in a fresh process each
round; 9 rounds, pairs in random order; a round's value is the median of 21
batches of about 10 ms after at least 300 ms of warm-up. Before timing,
every scenario's first 64 steps must give the same checksum on all three
runtimes (0 mismatches). The two runs got different CPUs (EPYC 7763,
EPYC 9V74), so compare ratios within a run, not times across runs. Reflex
is the production bundle of `bf71877` built by its own
`build-baseline-oracle.mjs --production`, behind the same minimal host
(FIFO queue, claim-based deduplication) quant uses; alien-signals 3.2.1.

Kernel v3 (iterative push and pull, shorter call paths), run 41826712831;
the last column is the recursive v2, run 41824417430:

| scenario | quant | Reflex | alien | quant / best | v2: quant / best |
| --- | ---: | ---: | ---: | ---: | ---: |
| static.read-clean | 1.00 µs | 1.02 µs | 1.09 µs | 0.98 | 0.93 |
| static.chain-100 | 2.52 µs | 2.25 µs | 2.74 µs | 1.12 | 1.17 |
| stable.wide-8 | 45 ns | 58 ns | 112 ns | 0.77 | 1.12 |
| stable.wide-256 | 1.21 µs | 1.15 µs | 3.02 µs | 1.05 | 1.26 |
| diamond.8x8 | 1.84 µs | 2.10 µs | 2.68 µs | 0.87 | 0.99 |
| fan-in.1024 | 8.11 µs | 5.18 µs | 12.45 µs | **1.57** | 1.50 |
| fan-out.effects-1000 | 27.36 µs | 28.42 µs | 26.11 µs | 1.05 | 1.28 |
| fan-out.computeds-1000 | 22.24 µs | 27.36 µs | 37.93 µs | 0.81 | 1.29 |
| branch.switch-100 | 6.87 µs | 7.25 µs | 11.34 µs | 0.95 | 1.13 |
| edit.insert-one-256 | 2.09 µs | 2.13 µs | 6.43 µs | 0.98 | 1.01 |
| reorder.reverse-8 | 121 ns | 112 ns | 1.19 µs | 1.08 | 1.58 |
| reorder.rotate-256 | 2.81 µs | 2.74 µs | 26.42 µs | 1.02 | 1.05 |
| value-sort.256x32 | 54.81 µs | 50.59 µs | 217.97 µs | 1.08 | 1.08 |
| replace-half.256 | 6.85 µs | 4.89 µs | 5.57 µs | **1.40** | 1.04 |
| shared-chaotic.64x32 | 37.89 µs | 50.54 µs | 306.45 µs | 0.75 | 0.80 |
| long-reorder.256 (hostile) | 5.24 µs | 3.76 µs | 33.46 µs | **1.39** | 1.37 |
| batch.writes-32 | 442 ns | 731 ns | 784 ns | 0.60 | 0.71 |
| lifecycle.mount-100 | 18.25 µs | 21.44 µs | 13.46 µs | **1.36** (0.85 vs Reflex) | 1.99 |

- Within 25 % of the better competitor: 14 of 18 (v2: 11). Faster than
  both: 8.
- **fan-in.1024 and replace-half.256** are the two misses that have a
  measured cause; the committed kernel (v4) changes both, without CI timing
  yet. fan-in validated all 1,024 producer relations before every run;
  WOKEN (LOG 21) takes that to 0 validation loads per write (structural
  count). replace-half regressed from v2 because each fresh source paid 16
  failed scan comparisons; the no-subscriber check (LOG 22) removes them.
- **long-reorder.256** is the hostile case: a uniform random permutation of
  256 sources every pass. Quant pays one O(d) index walk and an O(1) move
  per read; Reflex's tape and finger are 1.39× faster here. alien-signals
  is 6.4× slower than quant, with one allocation per out-of-place read.
- **lifecycle.mount-100** creates and disposes 100 effects; alien runs an
  effect inline at creation, while quant and Reflex route it through the
  host queue. Quant is faster than Reflex here.

Structural work per step (`bench/structure.mjs`, kernel v4; alien-signals'
link counters from the same sources, instrumented as in the lab):

| scenario | quant cursor hits / reads | scan moves | index walk | new / removed relations | alien new / removed links |
| --- | --- | ---: | ---: | --- | --- |
| stable.wide-256 | 256 / 256 | 0 | 0 | 0 / 0 | 0 / 0 |
| reorder.rotate-256 | 2 / 257 | 255 | 0 | 0 / 0 | 255 / 255 |
| value-sort.256x32 | 8,161 / 8,224 | 63 | 0 | 0 / 0 | 4,140 / 4,140 |
| edit.insert-one-256 | 193 / 258 | 64 | 0 | 0.5 / 0.5 | 65 / 65 |
| shared-chaotic.64x32 | 150 / 2,080 | 2 (+1,928 indexed) | 2,080 | 0 / 0 | 2,002 / 2,002 |
| long-reorder.256 | 6.6 / 257 | 250 indexed | 257 | 0 / 0 | 255 / 255 |
| replace-half.256 | 129 / 257 | 0 | 0 | 128 / 128 | 128 / 128 |

Quant allocates a relation only when one is genuinely new; every reorder is
a move. Stable reads do one comparison and two stores, no lookup.

## Q7. Most important result

**The same invariants admit a substantially different and simpler
architecture, and building it exposed a semantic gap that current Reflex
hides.**

- *Different:* change is a version fact on nodes and relations, not a
  family of state bits. That removes the tracking stamp, the prefix filter
  and `Visited`/`Revalidate`/`Leased`. A push into a running pass is
  classified exactly for free, and F1 (a computed that writes its own
  source) converges instead of staying stale.
- *Simpler:* no tape, no finger, no lockstep, no stamp register, no clock.
  Exact pair membership is one on-demand index in object-local cells,
  linear per pass, with bounded exact scans in front. That is 553 code
  lines against Reflex's 3,671 in kernel and protocol, though Reflex also
  carries contexts, hooks and domains. Per object it is not smaller: 10
  node and 8 relation fields against 8 and 7. The saving is in mechanisms,
  not bytes.
- *Forced anyway:* bidirectional intrusive relations, two dirty states,
  a running bit, a read-order cursor, prune-on-success, a per-relation
  birth generation (exact failure semantics, MODEL LB2), the `Unknown` /
  `Changed` split for watchers, and explicit walker stacks. These parts of
  Reflex are not historical; its invariants imply them.
- *Exposed:* Reflex = contract + D3 + D4 + D5 on 100,000 generated programs,
  and none of the existing corpora reaches those regions. D5 contradicts R2:
  a failed watcher drops an execution obligation the contract says survives.
  In Reflex, the evidence behind an obligation lives only in bits, so a
  failure path that clears them forgets the change. With versions, an
  unconsumed change stays visible until a successful read. D5 is the one
  decision this experiment hands back: change Reflex to keep the
  obligation, or amend R2 and the spec.
