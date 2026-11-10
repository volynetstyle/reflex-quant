# The smallest known runtime implied by the Quant contract

Experiment: derive a reactive runtime from a frozen contract (invariants
T1–W5, bounds S1–S7, decisions D1, D2 and D6, precondition C1 in
[CONTRACT.md](../CONTRACT.md)) that
was extracted from Reflex's semantic contract and executable spec, not from
its implementation; Reflex is provenance, not authority; keep every mechanism
a test forces and nothing else; compare it with the spec, current Reflex
(`dev` `bf71877`) and alien-signals 3.2.1. Code: the eight production files
in `src/` (Q5). Design history: [LOG.md](./LOG.md) (37 entries, each with its
witness). Ablation record: `mutants.json`. Figures are as of commit
`241a3b7` (tests 72/72, ESM release 2,131 B gzip) unless a passage names an
older run; the CI trajectory is in [HISTORY.md](./HISTORY.md). LOG 32–37
(W5, the C1 precondition, W3, the work stack at rest, generation wrap, torture
round 2) postdate that commit: tests 116/116 against the development build
and 109/109 (7 diagnosis tests skipped) against the production build, ESM
release 2,221 B gzip.

**Current representation update (LOG 43).** `Node.last`, `Flag.Indexed` and
`Flag.Marked` have been removed together. Tracking keeps `active`/`cursor`
in execution context; slot ownership and a continuous `UNREAD` suffix certify
the lookup phase. Nodes have nine fields, and the shared work stack continues
to store edges only (LOG 38). Generations/`SETTLE` and the separate kernel/host
delivery bits remain. The 169 existing development tests pass; two new reverse
retry witnesses cover S3 with mixed committed/tentative relations, bringing
the suite to 171 (production: 164 passed, seven diagnosis tests skipped).
The older measurements and ablation totals below retain their stated snapshot;
the final-detach cursor reset is superseded by removing the node cursor itself.

**Object access update (LOG 44).** Tracking and propagation reuse loaded
source/slot/subscriber pointers within callback-free regions. A null subscriber
head proves absence before the unread-suffix mode test. The stable read body
and validation bodies are unchanged. This is a constant-factor
optimization, not a change to the mechanism basis. [ACCESS-AUDIT.md](./ACCESS-AUDIT.md)
records source access budgets, compiler feedback, rejected hot-path reshapes
and validation (172 development tests, 165 production tests with seven
diagnosis tests skipped).

**Result.** The invariants admit a substantially different architecture of
about the same per-object size: versions instead of change bits, bounded
exact searches backed by an on-demand mark or source-side index instead of
tape and stamps, and per-relation generations for exact failure semantics.
It matches the executable spec, amended by three documented decisions (D1
and D2 from Reflex's own documents, D6 from this experiment), on all 27,061
bounded and 18,660 recovery programs and on 100,000 generated programs. D6
(P5, in-pass invalidation) needs a write inside a computation, which no
corpus can express; dedicated P5 tests pin it. On the same corpus Reflex is
that contract plus three failure-path choices, which the experiment isolates
exactly. All 34 mechanism ablations fail a test, and so do the 7 of the
C1 development diagnostic (Q3). On CI (run
42287159440) it is within 25 % of the better of Reflex and alien-signals on
all 18 scenarios and faster than both on 8; geometric mean 0.97 of the
better one, 0.95 of Reflex and 0.42 of alien-signals (Q6).

## 1. Contract inventory (phase 0)

**Provenance and ID map.** The contract was extracted from the Reflex
material listed below. The comparison snapshot is Reflex `dev` `bf71877`;
no separate extraction snapshot was recorded when the contract was selected.
Source IDs in the tables (V, C, R, W, L) are Reflex's; CONTRACT.md IDs are
Quant's: tracking T1–T3 (exact tracking, uniqueness, nesting); change P1–P4
(version fact, cutoff, glitch freedom, V3); failure F1–F4 (C1–C3, C4/R3,
W2, R2); watchers W1–W4 (W1, L1–L5, disposal, batching).

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

**C. Performance:** the bench scenarios of Q6, chosen to match the
task list; target within 25 % of the better of Reflex and alien-signals on
common shapes, hostile shapes reported as measured.

**Where the written contract, the spec and Reflex part.** Ten probes
(`test/support/probes.ts`) pin the edges of the contract. Six regions
separate the three (D6 lies outside the probes' program language):

| Id | Region | Spec | Reflex | Quant | Classification |
| --- | --- | --- | --- | --- | --- |
| D1 | computed validation: first source changed, a later one now throws (P1) | validates the whole frontier: throws | existential: no throw | = Reflex | unclear contract: MODEL §4 says existential, the spec is universal. Existential does no work a re-execution would not do (read order) |
| D2 | failed computed whose old frontier now throws (P2) | validates the old frontier first | executes | = Reflex | spec deviates from C3's text ("next demand executes") |
| D3 | watcher validation after a failed run read a new computed (P3) | not validated (tentative) | validated | = spec | Reflex implementation detail; contradicts W2/V3 |
| D4 | wake set after repeated failures (P4) | committed ∪ last attempt | union of all attempts | = spec | Reflex implementation detail; contradicts W2 |
| D5 | failed watcher woken through an unchanged computed (P9) | runs (obligation kept) | idle: nothing runs | = spec | **Reflex defect against R2**, documented as intended in INVARIANTS §3 ("otherwise idle") |
| D6 | a computation changes a source it already observed, then rereads it (SPEC P5) | refreshes the observed version on reread and validates as of the end of the execution: the change is never seen (3, 3, 3) | refreshes on reread: 3, 3, 3 | first observation kept, validated as of the start: the next demand executes (3, 4, 4) | **intentional divergence**: a reread erased a change the earlier read already depended on, and an A→B→A in between erased a P1 change. Not expressible in the program language (no write inside a computation) |

The contract spec (`test/support/contract-spec.ts`) is the spec with D1, D2
and D6 applied and nothing else. Quant equals it on every program run. D6 is
invisible to the corpora (their programs never write inside a computation);
it is executed by `test/semantics.test.ts` (P5) through the public API, and
on the spec machines by the witness of LOG 31: the spec answers 3, 3, 3 for
`x = a; a := 2; return x + a` and 1, 1, 1 for its single-read form (quant's
F1 test, which converges), the contract spec 3, 4, 4 and 1, 2, 2.
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
`value`, `ver`, `fn`, `deps`, `last` (the running pass's cursor), `subs`,
`lastSub`, `slot`, `gen`. **Edge** (8 fields): `from`, `to`, `ver`, `gen`,
`prev`/`next` (in `to.deps`), `prevSub`/`nextSub` (in `from.subs`).
**Kernel bits:** STALE (may be out of date; for a watcher: validate), DIRTY
(must run), BUSY (run on the stack), INDEXED (run uses slot cells), MARKED
(run marked its unread edges; pairs are found through subscribers), WATCH
(watcher), WOKEN (watcher woken by signals only: run without validating).
The development build adds CHECKING (a computed's validation on the stack),
on WOKEN's bit: no node is both a watcher and a computed.
**Host bits:** AUTO, QUEUED. **Mutable globals:** kernel `active`,
`wake`, one work stack with `top`; host `queue` with `size`, `depth`,
`draining`. **API:** `signal`, `computed`, `effect`, `get`, `peek`, `set`,
`update`, `dispose`, `batch`, `untracked`; a handle is the node itself, so a
signal costs one allocation.

The work stack holds only edges: resume edges for push/pull and displaced
slot cells for indexed runs. A displaced cell's immutable `from` recovers
its source, so saving the source separately is redundant (LOG 38).

V8 discipline (the rules of the Reflex runtime): one node shape and one
edge shape, each built at a single literal site; every numeric field a
masked Smi counter, so no field ever holds a double (`--trace-generalization`
shows only const→mutable after first initialization); conditions as explicit
comparisons and `=== true` on boolean call results, so no ToBoolean runs on
mixed values; no array methods (manual `top`/`size`, popped slots cleared);
no recursion. A deopt audit of all 18 scenarios finds only one-time
feedback, grow-store and benchmark-sink deopts, none repeating.

- **Write:** commit, bump `ver`; direct subscribers get DIRTY unless BUSY;
  everything downstream gets STALE in one iterative depth-first walk that
  stops at nodes already STALE; a watcher becoming STALE is handed to the
  host.
- **Read:** one path for signals and computeds (a signal's flags are 0). A
  stale computed is pulled: an iterative descent in read order, the first
  source whose version differs makes the node run; a STALE source is
  descended into, a DIRTY one runs. A node disposed during the walk is not
  run (W3). Inside a pass the read is tracked. The development build
  diagnoses the C1 precondition: a demand that reaches a node whose run or
  validation is on the stack throws. The production build pays nothing for
  it; its hot functions have the bytecode of the build without it (LOG 33).
- **Tracking:** `deps` is kept in read order; the hot path compares the next
  edge's source and advances `last`. A miss tries the cheapest exact proofs
  first: the previous read, a source nobody reads (new without a scan), then
  bounded scans of the unread suffix and the accepted prefix, then the
  source's first 8 subscribers. A pair found as the source's first
  subscriber marks the pass's unread suffix (one O(d) walk over edges); a
  deeper pair or an exhausted budget indexes the pass's relations in their
  sources' `slot` cells (O(d)). After either walk every read is an exact
  answer: duplicate, move, or new. A repeated read keeps the version of the
  first observation (P5). A successful pass cuts the unread suffix.
- **Failure:** nothing commits; the node is DIRTY; relations born since the
  last success (`edge.gen === node.gen + 1`) are tentative: they wake but are
  not validated, and unread ones from earlier failures are dropped. A commit
  restamps every relation twice per 2^30 runs (SETTLE), so a wrapped
  generation never makes an old relation look tentative (LOG 36).
- **Host:** a watcher runs as validate all committed sources → if owed,
  consume and run the cleanup untracked → execute. Effects run only inside
  a FIFO drain loop; batch defers the drain. An `effect()` call that throws
  stops its watcher before rethrowing (W5).

## Q1. What survived

| Reflex concept | Re-emerged as | Mechanical reason |
| --- | --- | --- |
| bidirectional intrusive relations | the same: one relation object in two doubly linked lists | push needs subscribers, validation needs sources in order, removal must be O(1) from both ends |
| two dirty states (`Unknown`/`Changed`) | STALE / DIRTY | push knows "may have changed"; only failures, first runs and direct writes know "must execute". Validation turns the first into the second |
| `Computing` | BUSY | cycle detection and disposal deferred to the end of the node's own pass |
| read-order cursor (`tailIn`) | `last` | stable traces must cost one comparison per read; read order also makes existential validation waste-free |
| relation reuse and moves | the same | a reorder must not allocate |
| preserve the unread suffix until success | prune on success only | W3: committed relations a failed attempt did not reach must still wake |
| `Scheduled` + host queue | QUEUED + FIFO queue in the host | the kernel only delivers; deduplication and timing are host policy (LB3) |
| universal watcher validation | `check` | V3 |
| `edge.born` (a research branch, never merged) | `edge.gen` | forced here by W2/V3 exactness, not by absence proofs: a per-relation fact is the floor (MODEL LB2) |
| `Unknown` versus `Changed` on watchers | STALE versus WOKEN | a watcher woken by signals only has clean computed sources, so its universal validation is vacuous; measured on fan-in (LOG 21) |
| explicit walker stacks | one work stack (`stack`, `top`) | depth must not be bounded by the call stack (a 20,000-deep chain overflows the recursive kernel) |
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
  scans (≤ 8 relations each side), a bounded subscriber lookup, and the mark
  or index walk cover the same cases with linear worst cases.
- **Contexts, execution domains, runtime phase registers, hooks: gone.**
  They are integration surface, not semantics.
- **`lastIn`:** not needed; the suffix cut walks from the cursor.

## Q3. What is fundamentally necessary

Every remaining mechanism has a counterexample: removing it fails a test.
This is a Level 1 claim about this architecture, not a necessity proof; see
[WITNESS-AUDIT.md](./WITNESS-AUDIT.md), which merges the ablations into ten
obligations and classifies each witness.
All 34 mechanism ablations are killed (`research/mutants.mjs`,
`mutants.json`): 25 by semantic tests, 8 only by structural or
representation tests (the optimizations of Q4, the work stack at rest, and
the second restamp of each generation cycle), 1 only by tests that assert sibling order (the
convention of Q4). None of them is killed only by a test of the development
build. The 7 ablations of the C1 diagnosis (LOG 33) are killed against the
development build; a development diagnostic is no mechanism, so they are
not counted. The last two
to fall, `no-fresh-source` (LOG 22) and `index-always` (LOG 28), had been
called constant factors only timing sees; they survived because no counter
recorded the work they save, not because they save none (LOG 30).

| Mechanism | Smallest counterexample (test or probe) |
| --- | --- |
| relation versions | P6 (direct ABA must re-run); "a write to a not-yet-read source during the run adds no rerun" (`direct-dirty-running`) |
| first observation kept on a repeated read (P5) | `x = a; a := 2; return x + a` must give 3, then 4 (`repeat-refresh`) |
| read-ordered deps + cursor | "stable graph: no allocation and no lookup per read" |
| slot index + UNREAD marks | "random permutations of 64 shared sources: exact, no allocation, linear work" (`no-unread`) |
| displaced-cell stack | "a nested indexed pass restores the outer pass's cells" (`no-displaced`: a duplicate relation) |
| prune on success only | P5 (`cut-on-failure`) |
| relation/node generations | P3 (`validate-tentative`), P4 (`keep-tentative`) |
| DIRTY after any failure | P9 (`idle-after-failure`) |
| DIRTY after a failed validation | "after a failed validation the effect is re-delivered" (`validation-stale`) |
| failed watcher stays STALE; host-side deduplication | historical fault `validation-history-dependence`, recovery language (`no-retry`); re-delivery test (`wake-guard`) |
| clear STALE before the pass | "an effect writing a source it read converges", F1 test (`clear-after`) |
| deferred disposal | "dispose inside the callback, then more reads: no ghost relation" (`eager-dispose`) |
| BUSY on read | "cycles throw" (`no-cycle-check`) |
| universal watcher validation | P10 (`existential-watcher`) |
| STALE, not WOKEN, for a running watcher | "a write to a not-yet-read source during the run adds no rerun" (`woken-when-running`) |
| repeat check before the scans | bounded language (`no-repeat-check`: a duplicate relation) |
| drain-loop-only effects | "effects created inside a batch or another effect run after it" (`run-direct`, `start-outside-drain`) |
| iterative push and pull | "push and pull are not bounded by the call stack" (the recursive v2 kernel overflows) |
| rollback of an `effect()` call that throws (W5) | "a failed first run leaves no live watcher and no relation", "a sibling's failure … rolls the new watcher back" (`construction-commits`) |
| relations restamped twice a generation cycle (SETTLE) | a watcher driven by a computed keeps running after its generation wraps; F1, F3 and P4 under wrap (`no-settle`); both restamp phases (`settle-once-a-cycle`) |
| empty work stack releases oversized capacity at every producer exit | successful/failed validation, cold indexed runs, direct watchers and push without later demand (`no-trim`, placement ablations; LOG 40) |
| disposed handles do not retain former dependencies (S4/resource correctness) | graph-field reachability is independent of former dependency width (LOG 39); LOG 43 removes the node cursor, retiring `retain-disposed-cursor`, and checks nested execution with `no-cursor-restore` |
| no run of a node disposed during its validation (W3) | "a computed disposed while it is validated…" (`disposed-run`, `disposed-run-climb`); "a later source failing in the same walk…" (`disposed-left-dirty`) |

## Q4. Optimization versus semantics

| Class | Mechanisms |
| --- | --- |
| correctness | relation versions; read-ordered deps; uniqueness (index, UNREAD on an indexed or marked pass, displaced stack, repeat check); STALE/DIRTY; clear-before-pass; BUSY (cycles, deferred disposal); WATCH delivery |
| failure semantics | prune on success only; generations (tentative relations); DIRTY after failure; STALE after failed validation (LOG 25); universal watcher validation (V3) |
| asymptotic | the slot index (exact O(1) per read after an O(d) walk, instead of Θ(d²) scans); iterative push and pull (depth not bounded by the stack); the empty work stack cut back to KEEP at producer exits, so retained memory does not follow the deepest walk ever (LOG 35, placement corrected in LOG 40) |
| resource correctness | sever detached intrusive pointers; keep the dependency cursor in execution context so disposed handles cannot root former dependencies through it (LOG 43, superseding LOG 39's final-detach reset) |
| constant factor | DIRTY on direct writes (O2); WOKEN (no vacuous watcher validation); bounded scans before indexing (O1); the no-subscriber absence check; a marked pass finds pairs through subscribers instead of the slot index (LOG 28); `readSignal`; delivery on the STALE transition; no version compares once owed |
| convention | `subsTail` (FIFO sibling order; only order-asserting tests fail without it) |
| development diagnostic | CHECKING and the BUSY test of sources in `verify` and `check` (the C1 precondition; compiled out of the production build, LOG 33) |
| removed as unnecessary | the run() guard against a watcher on the stack (no API path reaches it); `Node.last`, `Flag.Indexed`, `Flag.Marked` (execution-local cursor and topology certificates, LOG 43) |

## Q5. Complexity comparison

Reflex: `packages/reflex-runtime/src/kernel` + `src/protocol`, without
dev, profiling, projection and domains. Quant: the eight production files of
`src/` at `241a3b7` (`instrumentation.ts` is compiled out of the release and
not counted). Code lines are lines that are neither blank nor comment-only.

| | Reflex | Quant |
| --- | --- | --- |
| implementation lines (code lines) | 5,610 (3,671) in 42 files | 1,012 (620) in 8 files: kernel 458 (289), host 152 (93), tracking 149 (83), index 83 (48), graph 69 (48), model 49 (29), flags 28 (14), types 24 (16) |
| of which tracking and graph shape | 1,881 (1,114) | 218 (131): tracking (miss path, scans, subscriber lookup, mark) and graph primitives (node, move, cut, unsub); the tracking machine now lives in `kernel.ts` |
| minified bundle, gzip | 8,980 B (whole internal surface) | 2,131 B ESM (kernel + host + API) |
| node fields | 8 | 10 |
| relation fields | 7 | 8 |
| node state bits | 10 production (+2 dev) | 7 kernel + 2 host (+1 dev, on WOKEN's bit) |
| global runtime state | context bank: consumer, stamp, propagation and batch depth, phase, frame, hooks; module registers; walker stacks | kernel `active`, `wake`, one work stack with `top`; host queue, `size`, `depth`, `draining` |
| queues | host-owned (none in the kernel) | one FIFO in the host |
| allocations per new relation | 1 | 1 |
| allocations per stable read | 0 | 0 |
| stable read work | cursor hit | cursor hit: 1 comparison, 2 stores |
| dynamic reorder work | finger, lockstep, tape | ≤ 8 comparisons for each of the suffix scan, prefix scan and subscriber lookup per miss; else one O(d) mark or index walk per pass |

The soft budget (kernel ≤ 300 lines) holds for `kernel.ts` alone (289 code
lines) only because tracking and graph operations moved into their own
files; kernel, tracking and graph together are 420 code lines, 40 % over it.
What forced the excess, as first measured on the single-file kernel (v4):
exact uniqueness without hashing (miss path, index, scans), the iterative
pull with its failure unwinding, and the exact failure bookkeeping (abort,
generations).

## Q6. Performance

CI only: GitHub Actions run 42287159440 at `241a3b7`, Node 22.23.4. The 18
graph scenarios run in five shards, one job each; every job times all three
runtimes on one runner, so compare ratios within a job, never times across
jobs (the shards got AMD EPYC 9V45, AMD EPYC 9V74 and Intel Xeon Platinum
8370C). Every (runtime, scenario) pair runs in a fresh process each round;
9 rounds, pairs in random order; a round's value is the median of 21
batches of about 10 ms after at least 300 ms and 2,000 steps of warm-up.
Before timing, every scenario's first 64 steps must give the same checksum
on all three runtimes (0 mismatches). Reflex is the frozen production
bundle of `bf71877` (`reference/reflex`), behind the same minimal host
(FIFO queue, claim-based deduplication) quant uses; alien-signals 3.2.1.
The trajectory over every CI run is in [HISTORY.md](./HISTORY.md); the
kernel v2 and v3 tables of earlier revisions of this section are in git
history.

| scenario | shard CPU | quant | Reflex | alien | quant / best | quant / Reflex | quant / alien |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| static.read-clean | Xeon 8370C | 2.05 µs | 1.76 µs | 1.68 µs | 1.22 | 1.16 | 1.22 |
| static.chain-100 | Xeon 8370C | 2.55 µs | 2.71 µs | 2.90 µs | 0.94 | 0.94 | 0.88 |
| stable.wide-8 | Xeon 8370C | 77 ns | 69 ns | 131 ns | 1.11 | 1.11 | 0.58 |
| stable.wide-256 | Xeon 8370C | 1.61 µs | 1.56 µs | 3.54 µs | 1.03 | 1.03 | 0.46 |
| diamond.8x8 | EPYC 9V74 | 2.52 µs | 2.78 µs | 3.53 µs | 0.91 | 0.91 | 0.71 |
| fan-in.1024 | EPYC 9V74 | 6.63 µs | 6.11 µs | 15.97 µs | 1.08 | 1.08 | 0.42 |
| fan-out.effects-1000 | EPYC 9V74 | 21.78 µs | 28.00 µs | 28.14 µs | 0.78 | 0.78 | 0.77 |
| fan-out.computeds-1000 | EPYC 9V74 | 36.73 µs | 32.36 µs | 44.99 µs | 1.13 | 1.13 | 0.82 |
| branch.switch-100 | EPYC 9V45 | 3.75 µs | 5.10 µs | 9.49 µs | 0.74 | 0.74 | 0.39 |
| edit.insert-one-256 | EPYC 9V45 | 1.45 µs | 1.39 µs | 5.97 µs | 1.04 | 1.04 | 0.24 |
| reorder.reverse-8 | EPYC 9V45 | 77 ns | 66 ns | 541 ns | 1.15 | 1.15 | 0.14 |
| reorder.rotate-256 | EPYC 9V45 | 1.79 µs | 1.53 µs | 14.04 µs | 1.16 | 1.16 | 0.13 |
| value-sort.256x32 | EPYC 9V45 | 35.55 µs | 31.11 µs | 243.99 µs | 1.14 | 1.14 | 0.15 |
| replace-half.256 | EPYC 9V74 | 4.02 µs | 4.73 µs | 5.73 µs | 0.85 | 0.85 | 0.70 |
| shared-chaotic.64x32 | EPYC 9V74 | 38.27 µs | 49.33 µs | 189.58 µs | 0.78 | 0.78 | 0.20 |
| long-reorder.256 (hostile) | EPYC 9V74 | 4.69 µs | 3.79 µs | 25.21 µs | 1.24 | 1.24 | 0.19 |
| batch.writes-32 | EPYC 9V45 | 303 ns | 515 ns | 550 ns | 0.59 | 0.59 | 0.55 |
| lifecycle.mount-100 | EPYC 9V45 | 9.52 µs | 15.86 µs | 10.17 µs | 0.94 | 0.60 | 0.94 |

- Within 25 % of the better competitor: 18 of 18. Faster than both: 8.
  Geometric mean: 0.97 of the better one, 0.95 of Reflex, 0.42 of
  alien-signals. These are ratios on this suite, chosen by this project to
  cover the task list, not a general ranking.
- **Ahead of both, most clearly:** branch switching (0.74), shared dynamic graphs
  (shared-chaotic 0.78), batched writes (0.59), effect fan-out (0.78),
  churn of half the sources (0.85), diamond (0.91).
- **Reorders** are where the two comparisons part. Against alien-signals,
  which unlinks and relinks on every out-of-place read, quant is 5–8×
  faster (0.13–0.19; the structural table below counts the relinks).
  Against Reflex, whose tape and finger are specialized for permutations,
  quant is 14–24 % slower on every reorder scenario. long-reorder.256, a
  uniform random permutation of 256 sources every pass, is the hostile
  case and this run's worst ratio (1.24): quant pays one O(d) walk and an
  O(1) move per read.
- **Slowest on the trivial paths:** static.read-clean (1.22 of alien) and
  stable.wide-8 (1.11 of Reflex). In the mechanism suite of the same run,
  untracked signal reads and writes nobody observes are 1.66–1.68× alien
  (and 0.50–0.78 of Reflex), and 64 repeated reads of one source in a pass
  (track.duplicate-64) are 1.51× both: each repeat leaves the cursor path.
- **Earlier misses with a measured cause, now closed:** fan-in.1024 (1.57
  in v3 → 1.08) validated all 1,024 producer relations before every run;
  WOKEN (LOG 21) takes that to 0 validation loads. replace-half.256 (1.40 →
  0.85) paid failed scan comparisons for every fresh source; the
  no-subscriber check (LOG 22) removes them. lifecycle.mount-100 (1.36 of
  alien → 0.94) routed a new effect through the host queue; since LOG 24 it
  opens the drain itself.

Structural work per step (`bench/structure.mjs`, CI run 42287159440; mean
of 256 steps after 64 warm-up steps; alien-signals' link counters from the
same sources, instrumented as in the lab). Scan hits are relations found by
the bounded scans; lookups are subscriber or slot lookups; walks are index
plus mark walks per step:

| scenario | quant cursor hits / reads | scan hits | lookups | walks | moves | new / removed relations | alien new / removed links |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| stable.wide-256 | 256 / 256 | 0 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| fan-in.1024 | 1,024 / 1,024 | 0 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| reorder.rotate-256 | 2 / 257 | 255 | 0 | 0 | 0 | 0 / 0 | 255 / 255 |
| value-sort.256x32 | 8,161 / 8,224 | 63 | 0 | 0 | 0 | 0 / 0 | 4,140 / 4,140 |
| edit.insert-one-256 | 193 / 258 | 64 | 0 | 0 | 0 | 0.5 / 0.5 | 65 / 65 |
| shared-chaotic.64x32 | 150 / 2,080 | 2 | 1,952 | 31 + 1 | 1,928 | 0 / 0 | 2,002 / 2,002 |
| long-reorder.256 | 6.6 / 257 | 0.06 | 250 | 0 + 1 | 250 | 0 / 0 | 255 / 255 |
| replace-half.256 | 129 / 257 | 0 | 0 | 0 | 0 | 128 / 128 | 128 / 128 |

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
  Exact pair membership is bounded exact scans and a bounded subscriber
  lookup, backed by one on-demand mark or index walk in object-local cells,
  linear per pass. That is 620 code
  lines against Reflex's 3,671 in kernel and protocol, though Reflex also
  carries contexts, hooks and domains. Per object it is not smaller: 10
  node and 8 relation fields against 8 and 7. The saving is in mechanisms,
  not bytes.
- *Forced anyway:* bidirectional intrusive relations, two dirty states,
  a running bit, a read-order cursor, prune-on-success, a per-relation
  birth generation (exact failure semantics, MODEL LB2), the `Unknown` /
  `Changed` split for watchers, and explicit walker stacks. These parts of
  Reflex are not historical; the contract implies them.
- *Exposed:* Reflex = contract + D3 + D4 + D5 on 100,000 generated programs,
  and none of the existing corpora reaches those regions. D5 contradicts R2:
  a failed watcher drops an execution obligation the contract says survives.
  In Reflex, the evidence behind an obligation lives only in bits, so a
  failure path that clears them forgets the change. With versions, an
  unconsumed change stays visible until a successful read. D5 is the one
  decision this experiment hands back: change Reflex to keep the
  obligation, or amend R2 and the spec.
