# Design log

One entry per mechanism, in the order the tests forced them. Each entry
names the counterexample (a test, probe or mutant in this package), the
invariant it violates, the repair, the alternative rejected and the cost.
Mutant ids refer to `research/mutants.mjs`; probe ids to
`test/support/probes.ts`.

### 1. Versions on nodes and relations

- **Counterexample:** P6 (direct ABA, 0 → 1 → 0 between runs: the watcher
  must run); `semantics.test.ts` "a write to a not-yet-read source during
  the run adds no rerun".
- **Invariant:** change is a version fact, not a value fact (spec); exact
  cutoff for a push into a running pass (L2, L3).
- **Repair:** `node.version` bumps on every `Object.is`-visible change; each
  relation stores the version its consumer read. Push only marks STALE;
  validation compares versions in read order and stops at the first change.
- **Rejected:** value snapshots (ABA); Reflex's `Changed` on direct push
  plus one-step push, which needs a prefix classifier (stamps) to decide
  whether a push into a running pass hit an already-read source. Mutant
  `direct-dirty-running` is that classifier missing: killed.
- **Cost:** one node field, one relation field, one store per tracked read.

### 2. Read-ordered dependency list with a cursor

- **Measurement:** a stable trace must cost one comparison per read, no
  allocation, no lookup (`structure.test.ts` "stable graph").
- **Invariant (derived):** existential validation does no wasted work only
  if the list order is the last read order: a source is refreshed only when
  every earlier one is unchanged, so a deterministic re-execution would read
  it anyway.
- **Repair:** `deps` in read order, `cursor` = last accepted relation; a
  read compares the next relation's source. Doubly linked, so a relation
  moves to the cursor in O(1).
- **Cost:** `cursor` node field, `prevDep`/`nextDep` relation fields.

### 3. Exact membership: slot index and displaced cells

- **Counterexample:** duplicate after prefix (P0..P127 then P32); old twin
  (a nested pass subscribes to the source between two reads, defeating a
  last-subscriber check); random permutation of 64 shared sources (a scan
  is Θ(d²)); mutants `no-unread`, `no-displaced`.
- **Invariant:** one relation per (source, consumer) pair; graph size
  proportional to live relations; no Θ(d²) tracking.
- **Repair:** on the first miss a cheap check cannot resolve, index the
  consumer once: each relation goes into its source's `slot`, unread ones
  are marked `UNREAD`. Then every read is O(1) and exact: duplicate, move,
  or new. A nested indexed pass saves the cells it displaces on a shared
  stack and restores them at its end; LIFO nesting makes one stack enough.
- **Rejected:** per-consumer `Map`/`Set` (allocation and hashing per pass);
  a rollback field per relation (preact: a permanent field for a transient
  need); a linear scan (Θ(d²) on permutations).
- **Cost:** one node field (`slot`), one transient array, an O(d) walk only
  in passes that need it.

### 4. Prune on success only

- **Counterexample:** P5 (a committed dependency the failed attempt did not
  reach must still wake the watcher); mutant `cut-on-failure`.
- **Invariant:** W3, R2.
- **Repair:** a successful pass removes the unread suffix; a failed pass
  keeps it.
- **Cost:** none.

### 5. Exact retry set: success generation (kernel v0 → v1)

- **Counterexample:** P3 (v0 validated a computed read only by the failed
  attempt, so a validation failure made a plain flush retry) and P4 (v0
  kept the reads of every failed attempt, so a source read only by an
  earlier failure woke the watcher). Reflex shows both behaviours.
  Mutants `validate-tentative`, `keep-tentative`.
- **Invariant:** W2/V3: only the committed set is validated; the wake set is
  committed ∪ the last attempt's reads.
- **Repair:** `node.gen` counts successful passes; a relation is born with
  `gen = node.gen + 1`, so it is tentative exactly while `edge.gen ===
  node.gen + 1`. Watcher validation skips tentative relations; a failed pass
  drops unread tentative ones. Success costs one store, no walk.
- **Rejected:** a committed bit cleared by a walk at every success; a global
  pass clock (same fields plus a register). MODEL LB2 says Ω(m) bits are
  needed once failures rewrite history, so a per-relation field is the floor.
- **Cost:** one node field, one relation field. `research/versions/` keeps
  v0 and v1.

### 6. A failure leaves DIRTY, for watchers too

- **Counterexample:** P9 and the generated witness gen-1366: a failed run
  owes an execution, and a later wake through a computed that comes out
  unchanged must still run it. Reflex returns the watcher to idle
  (INVARIANTS §3) and drops it. Mutant `idle-after-failure`.
- **Invariant:** R2.
- **Repair:** a failed pass sets DIRTY on any node.
- **Cost:** none.

### 7. Failed validation leaves DIRTY; a failed watcher is not left STALE

- **Counterexample:** `semantics.test.ts` "after a failed validation the
  effect is re-delivered when its cause changes". With STALE kept on the
  failed computed or on the watcher, a later push stops there and the
  effect is stranded. Mutants `validation-stale`, `retry-as-stale`.
- **Invariant:** liveness of a scheduled host (L1).
- **Repair:** a computed whose validation throws becomes DIRTY (not STALE),
  so a push passes it. The watcher first got "every push calls the host";
  item 17 replaced that with a host RETRY bit.
- **Cost:** none.

### 8. Clear STALE before the pass, never after

- **Counterexample:** an effect that writes a source it read must converge;
  a computed that writes its own source (F1). Mutant `clear-after`.
- **Repair:** STALE|DIRTY are cleared when the pass starts. A push during
  the pass re-marks the node and versions settle it on the next read. F1
  converges here; in Reflex it is open.
- **Cost:** none.

### 9. Deferred disposal

- **Counterexample:** an effect disposes itself mid-pass and keeps
  reading: an eager unlink leaves the cursor on a detached relation, and a
  new relation hangs off it (ghost subscription, stale slot cells). Mutant
  `eager-dispose`.
- **Repair:** `dispose` of a RUNNING node only clears `fn`; the pass's end
  unlinks.
- **Cost:** none (RUNNING exists for cycles).

### 10. RUNNING: cycle check

- **Counterexample:** `semantics.test.ts` "cycles throw". Mutant
  `no-cycle-check`.
- **Cost:** one bit, in the same mask as STALE|DIRTY on read.

### 11. Host: scheduled runs only inside the drain loop

- **Counterexample:** an effect's first run outside the drain loop wrote its
  own source; the nested flush saw it RUNNING and dropped it (lost
  re-delivery, L1). Mutant `run-direct`.
- **Repair:** `effect()` queues and flushes. Effects created inside a batch
  or another effect run after it.

### 12. Removed: run() guard against a watcher on the stack

- Mutant `no-running-guard` survived the whole suite: no API path can reach
  it, because `flush` is not reentrant and `run` is not public. Removed, and
  kept as a host precondition.

### 13. Optimizations O1, O2 (structural measurement)

- **Measurement:** `bench/structure.mjs`. value-sort indexed 8,224 relations
  per step to perform 63 moves; insert-one and rotate indexed 257 per pass;
  every direct write made the computed re-walk its dependencies first.
- **O1:** before indexing, try two cheap exact answers. (a) The relation
  after `next` is the read's unique relation: move it. (b) The source has
  at most 8 subscribers, none of them this consumer: absence is proven.
  Index walks drop to 0 on rotate, value-sort, insert-one and replace-half,
  and branch-switch lookups to 0. Item 19 generalizes (a).
- **O2:** a write marks direct subscribers DIRTY, except RUNNING ones
  (item 1).
- Mutants `no-suffix-scan`, `no-absence-proof`, `no-direct-dirty` survive
  every semantic test and fail only `structure.test.ts`: optimizations, not
  semantics.

### 14. Kept as a convention: subscribers in birth order

- Mutant `prepend-subs` fails only tests that assert sibling effect order,
  which SEMANTIC_CONTRACT leaves open. `subsTail` stays for deterministic
  FIFO effect order (as in Reflex and alien); it is not an invariant.

### 15. Iterative push and pull (kernel v2 → v3)

- **Request and counterexample:** remove recursion and call overhead. A
  20,000-deep chain, built so that no first evaluation is deep, then one
  write and one read: the recursive v2 kernel throws `RangeError: Maximum
  call stack size exceeded` (`tracking.test.ts` "push and pull are not
  bounded by the call stack"); v3 passes.
- **Repair:** push is a depth-first loop over subscriber lists; a stack
  holds the sibling to resume after a descent. Pull is an existential,
  read-order descent; a frame is the relation descended through
  (`e.to` validates, `e.from` is below), so it costs no frame object. One
  try/catch per refresh marks every node still validating DIRTY on a throw.
  User code that reads a computed still nests, by definition; both stacks
  are LIFO-shared, so nested refreshes run above the outer one's base.
- **Cost:** two transient arrays. Per level: one push and one pop instead
  of two call frames and a try/catch.

### 16. readSignal

- **Measurement:** every signal read loaded and tested `flags` for the
  computed's refresh check, although a signal is never out of date.
- **Repair:** `readSignal` is the tracking half of `read`, with the cursor
  hit inlined in both.

### 17. Delivery on the STALE transition, RETRY for a failed validation

- **Measurement:** fan-out.computeds-1000 delivered the one effect 1,000
  times per write (item 7's "every push calls the host").
- **Repair:** a watcher is delivered only when it becomes STALE, like a
  computed propagates. A watcher whose validation threw gets the host bit
  RETRY instead of keeping STALE: `run()` validates again (V1, mutant
  `no-retry`), and the next push finds it not STALE and re-delivers it
  (mutant `retry-as-stale`).
- **Cost:** one host bit; 999 host calls fewer per write in that shape.

### 18. Watcher validation once an execution is owed

- **Measurement:** five loads per relation in `validateAll`, also when DIRTY
  was already known (fan-in.1024: 1,024 relations per write).
- **Repair:** once owed, versions need no comparison. Tentative relations
  exist only while owed (a failed pass sets DIRTY, only a success clears it
  and commits everything), so their check moves under the dirty-source test.
- **Cost:** none.

### 19. Bounded exact scans before indexing (O1 generalized)

- **Measurement:** reverse-8 indexed every pass (9-relation walk, slot
  traffic, release walk) for 7 moves; an effect's first run over shared
  sources indexed because the sources had more than 8 subscribers.
- **Repair:** on a miss, scan up to 8 relations of the unread suffix (a
  match is the pair's unique relation: move it) and up to 8 of the accepted
  prefix (a match is a duplicate read). Absence needs one side scanned
  completely: the whole consumer list, or the source's subscribers. Only
  then index. Per miss ≤ 24 comparisons, so a pass stays linear.
- **Consequence:** the prefix scan starts behind the cursor, because the
  repeat check compared the cursor already; mutant `no-repeat-check` now
  fails semantic tests (a duplicate relation), no longer only a counter.

### 20. Attribution of Reflex's own differences

- **Measurement:** `test/tools/attribution.test.ts` on 100,000 generated
  programs. Quant differs from Reflex on 775. Quant with Reflex's choices,
  D3 (validate a failed attempt's reads) and D4 (keep every failed
  attempt's reads), differs on 51. Adding D5 in full (a failed watcher
  drops the obligation and treats every change it saw as consumed) brings
  it to 0 (`research/mutants.mjs --emulate-reflex`).
- **Finding:** in quant the execution obligation is partly derived. A change
  the watcher has not consumed stays visible as a version mismatch on its
  relation until a successful read, so R2 holds even if a bit is cleared.
  Reflex keeps that evidence only in state bits, and the failure path that
  clears them erases it.

### 21. WOKEN: a watcher woken by signals only skips its validation

- **Measurement:** CI run 2 (v3): fan-in.1024 at 1.57× the better of
  Reflex and alien. The effect validated all 1,024 producer relations on
  every write, then re-read them. Reflex skips its frontier scan when a
  watcher has `Changed` without `Unknown`.
- **Invariant (exactness):** a watcher that is neither STALE nor RETRY has
  only clean committed computed sources. Anything that makes one STALE or
  DIRTY pushes STALE to the watcher, or happens to a source already STALE,
  and then the watcher became STALE back then. STALE is cleared only by a
  run whose validation refreshes every committed source, and a failed
  refresh sets RETRY. So when only direct signal writes woke it, the
  universal validation is vacuous.
- **Repair:** a direct write to a watcher that is not running sets
  DIRTY|WOKEN; a push through a computed sets STALE. `run()` opens on
  STALE|WOKEN|RETRY and validates only on STALE|RETRY. A running watcher
  still gets STALE (versions decide: mutant `woken-when-running`).
- **Re-emerged:** this is Reflex's `Unknown`/`Changed` split, for watchers
  only. Computeds need no such split: DIRTY makes them execute without
  validating.
- **Cost:** one kernel bit (host bits move up). Mutant `no-woken` fails only
  `structure.test.ts`.

### 22. A source without subscribers is absent before any scan

- **Measurement:** CI run 2: replace-half.256 regressed from 1.04 to 1.40
  after item 19. Each of its 128 fresh sources paid 16 failed scan
  comparisons before the source-side proof.
- **Repair:** `source.subs === null` proves absence at once.
- **Status:** mutant `no-fresh-source` survives every test (no comparison
  counter). A constant factor only; CI timing is its only witness.

### 23. Refactor for V8 and for reading (kernel v4 → v5)

- **Request:** no array methods, no needless allocation, one layer less,
  short clear names, maximum performance; and the V8 rules of the Reflex
  runtime (Smi transitions, ToBoolean).
- **API (written by the owner):** `get`/`set`/`dispose` functions over
  branded handles; the handle is the node, so a signal or computed is one
  allocation and an effect returns its node instead of a closure.
- **One read path:** `read` serves signals too (their flags are 0); the
  `fn === null ? readSignal : read` dispatch in `get` is gone.
- **No array methods:** one LIFO work stack with a manual `top` replaces
  three arrays with `push`/`pop`/`length` (mark's siblings, pull's climb
  edges, displaced slot cells); the host queue keeps a manual `size`.
  Popped slots are cleared, so a dead graph is not retained by the stack.
  After warm-up only nodes and new edges allocate.
- **Shape audit** (`bench/shape.mjs` on the readable bundle, all 18
  scenarios): `--trace-generalization` shows every node and edge field in
  its first representation (Smi fields stay Smi; only const→mutable);
  `--trace-deopt` shows one-time feedback, grow-store and overflow
  bailouts; the repeated `not a Smi` was the benchmark's own sink
  (`out += ...` leaving the Smi range), now bounded for all runtimes.
- **replace-half 4.32× (CI run 41829341839):** not explained by deopts,
  generalization, inlining (the miss path, `link`, `cut`, `unsub` inline
  into TurboFan code) or GC (129/116/122 scavenges, equal promotion for
  quant, Reflex, alien). The work counters equal v3's (1.40×). Left to the
  next CI run on the reshaped code.
- **Names:** `prev`/`next` and `prevSub`/`nextSub` for the two lists, `last`
  for the cursor, `ver`, `pull`, `mark`, `exec`, `check`, `miss`, `link`,
  `move`, `cut`, `unsub`, BUSY, INDEX; host AUTO, QUEUED, RETRY, `wake`.
- **Size:** kernel 542 → 486 lines (423 → 378 code), host 113 → 98.

### 24. An effect's first run opens the drain itself

- **Measurement:** lifecycle.mount-100 was the one CI miss with no measured
  cause (1.36× alien, run 41826712831). Per effect, created and disposed
  (local, Node 25; timing stays on CI): allocation is not it (signal 16 vs
  17.5 ns, computed 28 vs 30, alien pays `bind`), nor first evaluation of
  computeds (equal or faster). An effect with no sources cost 39.8 vs
  32.0 ns: the host route `wake` → queue slot → `flush` → `run` → `check`
  of an empty list → `exec`.
- **Repair:** `start(w)`. With no drain open, no batch and an empty queue,
  `wake(w); flush()` is a drain that opens on `w`; a fresh watcher has no
  sources and no cleanup, so its `run` is `exec`. The drain flag is set
  first, so the run stays inside the drain loop (item 11); otherwise it
  falls back to `wake(w); flush()`. `flush` and `start` share `drain`.
- **Result (local):** effect with no sources 39.8 → 32.4 ns (alien 32.4);
  mount-100 13.16 → 11.32 µs (alien 12.10), median of 5 fresh processes.
- **Status:** mutant `start-outside-drain` (the flag not set) fails the
  same test as `run-direct`.
- **Rejected:** a `subs === null` shortcut from `read` straight to `link`
  (skipping `miss`). Within noise on effects (62.4 vs 63.0 ns, 8 alternating
  runs), as item 23 predicts: `miss` and `link` already inline. The
  remaining 5–8 ns per effect with a source is the first edge and its
  removal: 10-field nodes and 8-field edges (`gen`, `slot` carry exact
  failure and membership) against alien's 7 and 7.

### 25. RETRY replaced by STALE and host-side deduplication (Level 2)

- **Question:** is the RETRY bit forced, or a lemma of the encoding
  (`research/WITNESS-AUDIT.md`)? It exists because the kernel's wake guard
  (`(f & (STALE | WOKEN)) === 0` in `write` and `mark`) treated a failed
  watcher that kept STALE as already handed to the host (item 17).
- **Observation:** the host already deduplicates with QUEUED, so the guard
  restated a fact the host keeps.
- **Repair:** drop RETRY. A failed `check` leaves the watcher STALE, so the
  next `run` checks again (V1). `write` and `mark` call `wake` for every
  watcher they reach; `wake` returns at the QUEUED check. The early-out in
  `mark` stays for computeds.
- **Result:** tests 48/48, differential suites included; one host bit and one
  flag test fewer. Local A/B against the previous kernel (interleaved, 5
  rounds; noise about ±5 %): fan-in.1024 1.00, diamond.8x8 1.03,
  fan-out.computeds-1000 1.02, batch.writes-32 1.00. Timing stays on CI.
- **Status:** mutant `retry-as-stale` is replaced by `wake-guard` (the old
  guard restored); `no-retry` now removes the STALE set after a failed check.
  Both fail the same tests as before. 23 of 24 ablations are killed.
- **Not applied:** replacing `start` by `wake(w); flush()` also passes every
  test, but is the repair of item 24, which measured it; a local A/B agrees
  (lifecycle.mount-100 1.08 and 1.17 slower without it).


### 26. Surface: seeded computed, peek, update (surface API, no mechanism)

- **Question:** which operations does the machine already carry that the
  surface does not expose? Classified as **surface API** (SPEC): no field,
  flag, relation, traversal phase or lifecycle rule is added, and no
  invariant changes.
- **Seeded computed:** `exec` already calls `fn(n.value)` and commits only
  after success, so `n.value` is the last committed value and survives a
  failed run (F1). `computed(fn, initial)` only changes the second argument
  of `node`. Returning `prev` reaches the existing `Object.is` cutoff (P2),
  so equality on a derived value needs no comparator field; sources keep
  P1 as is. A seed is safe for versions: no relation can observe a computed
  before its first commit, because `read` pulls before it tracks.
- **peek:** the refresh half of `read`; the same answers as
  `untracked(() => get(x))` (`surface.test.ts`), without the closure and
  the context swap. Its parameter is named `s`, so the `read` line that
  mutant `no-cycle-check` edits stays unique.
- **update:** `write(s, fn(s.value))`, then `flush`. Decision: `fn` runs
  untracked. An update is a write; with a tracked `fn`, `update(counter, ...)`
  inside a computation would silently subscribe it to whatever `fn` reads.
  Pinned by `surface.test.ts`.
- **Result:** tests 62/62; mutant verdicts unchanged (23 of 24 killed, the
  survivor is still `no-fresh-source`); `read` and every mutant anchor are
  untouched. Bundle 2022 → 2068 bytes gzip.
- **Not exposed:**
  - `materialize(c)` (= `peek`, then `dispose`): the freeze already exists
    and is tested; two calls express it.
  - Manual watcher (`watcher(fn, false)` + `run`): the state exists
    (`Auto`), but `run` outside the drain would change the ordering of the
    watchers it creates (item 11). It needs its own host-policy entry, not a
    surface one.
  - `touch(signal)`, a signal comparator: a change that is not an
    `Object.is`-visible commit is a different P1; manual invalidation of
    mutable containers is outside the boundary (SPEC).
  - Scheduler, priority or owner in a watcher's unused slots (`subs`,
    `lastSub`, `slot`): free in memory, but scheduling and ownership are
    framework policy (SPEC), and the fields would change meaning by node kind.
  - `isDisposed`, `pending`: readable from `fn` and the flags; no witness
    asks for them.

### 27. The write path tests the queue at the call site (host policy, optimization)

- **Observation:** CI run 42252842592, probe `leaf` (`research/COST-MODEL.md`):
  kernel `write` 1.38 ns per write, alien-signals 1.39; public `set` 2.75.
  The 1.37 ns difference is all `flush()`: a call and three register loads
  (draining, depth, size, in that order) after every write, also when the
  write woke nothing.
- **Change:** the host exports its registers (`size`, `depth`, `draining`;
  ES bindings are read-only to importers, so only the host writes them) and
  `drainNow()`. `set` and `update` test `size !== 0 && !draining && depth === 0`
  and call into the host only when there is work. The queue is tested first,
  so a write that woke nothing costs one load and one branch. `flush` keeps
  its guard for `batch`.
- **Classification:** optimization of the host's realization of delivery
  (SPEC: semantics-preserving constant factor). No state, flag or lifecycle
  rule is added. Layering holds: kernel → host → surface; the surface reads
  host state, the host alone writes it.
- **Evidence:** tests 62/62; checksums equal on every suite; mutant verdicts
  unchanged (23 of 24 killed; `run-direct`'s anchor follows the new import).
  Release bundle 2068 → 2086 bytes gzip, `update` carrying the guard too.
- **Status:** adopted on the decision that the guard is host
  implementation. Probe `surface` is the repeated measurement: it times the
  release (`current`) against the previous `set` (`flush-call`), the guard
  order alone (`size-first`) and a host `commit`, on the empty write path
  and on writes that have work to deliver.

### 28. Pairs through subscribers: a marked pass instead of the slot index (optimization)

- **Observation:** `research/COST-MODEL.md`, probe `decompose`: in a global
  reorder the index is the largest cost (25.5 of 59.2 ns per relation at
  N = 4096): two walks over the source set in list order, which is random in
  memory, to fill the slots and to clear them. For a source with few
  subscribers the pair's edge is already in `s.subs`, and the read loads the
  source anyway.
- **Change:** proofs run cheapest first and each result is used once:
  cursor (`read`), previous read, a source nobody reads, the bounded scans of
  the reader's list, then the source's first `SCAN` subscribers (`pair`). A
  completely scanned reader list proves absence without asking the
  subscribers. At the pass's first miss no scan resolved, a pair found among
  the subscribers marks the unread suffix `UNREAD` (`unread`: a walk over
  edges, not sources; flag `Marked`) and is taken at once; the rest of the
  pass finds pairs the same way. Only a source whose budget runs out indexes
  the pass, as before; a marked pass then falls back to the index. A found
  edge, by subscribers or by slot, is classified by one function (`take`): an
  unread edge moves to the cursor, a repeated read keeps its place.
- **Inlining:** `miss` stays under V8's limit for an inlined function (460
  bytes of bytecode): 409 bytes, against 389 before and 447 for a draft that
  kept the slot path inline (13 bytes from the limit). A first research draft
  with the lookup inline in `miss` crossed it (`--trace-turbo-inlining`:
  "exceeds bytecode limit") and, with identical structural work, lost 1.8x on
  track.duplicate-64: every read that misses the cursor paid a call. The
  indexed pass goes to `slot` (67 bytes) at once and after a fallback;
  `pair` 51, `take` 45, `unread` 40 bytes. No inlining refusal on duplicate,
  stable, local-edit, rotate, long-reorder or shared-chaotic workloads.
- **Classification:** optimization (SPEC): same answers, same structural
  work per step on every reorder workload, shared-chaotic included; a
  transient per-pass flag, no persistent state. Flag values are unchanged
  (`Marked = 1 << 8`).
- **Evidence:** tests 63/63. The count-pinning test of 64 shared sources now
  states its bound (at most one walk over the list per pass). New structural
  test: a reader's fully scanned list proves absence where 10 subscribers
  per source exceed the budget (it kills `no-absence-proof`, which the
  subscriber lookup would otherwise have made untested). Mutants: `no-mark`
  is killed by exactness tests (unread edges would be taken for repeats and
  cut); `index-always` (this change undone) survives, a constant factor only
  timing sees. 24 of 26 ablations are killed. Release 2086 → 2162 bytes gzip.
- **Status:** adopted, confirmed on global reorders by two CI runs
  (42269260132, research variant against the index release; 42271998863,
  release against `index-always`): 8–17 % cheaper at N = 256 and 1024,
  where no code-layout mode interferes (`research/COST-MODEL.md`), local
  paths within the `identity` control. One regression: shared-chaotic.64x32,
  +13 % and +5 % (LOG 29).

### 29. Mark a pass only when the pair is the source's first subscriber (optimization)

- **Witness:** shared-chaotic.64x32 (32 readers over the same 64 sources),
  +13 % and +5 % after LOG 28 in two CI runs, with the same structural work.
  A reader whose edge sits at position p among a source's subscribers walks
  p other readers' edges on every read of a marked pass; a slot costs two
  loads.
- **Change:** `begin(c, s, e, next)` decides the pass's lookup from the
  found edge's place: the source's first subscriber (`e === s.subs`, one
  comparison) marks the unread suffix; a deeper pair indexes the pass. Either
  way the found edge is taken at once (the index marks the suffix too), so a
  pair found deeper costs no slot lookup on that read. One reader per source
  is unaffected: its edge is always the first subscriber.
- **Shape:** `miss` 421 bytes of bytecode (409 before, 428 with the decision
  inline), `begin` 58; under V8's 460-byte limit. Release 2162 → 2180
  bytes gzip.
- **Evidence:** tests 63/63; both earlier rules pass the suite too and are
  the probe's A/B (`reorderVariants`: `index-always` = release 59f7085,
  `mark-any` = release 7b14509); checksums equal on all 114 cells of
  `reorder`; same structural work as both. Mutants: 24 of 26 killed;
  `index-always` (now: `begin` always indexes) survives as a constant factor,
  `no-mark` is killed. Local indication (3 rounds, not evidence):
  shared-chaotic 0.94 of `mark-any` and 0.93 of `index-always`, single-reader
  reorders level with `mark-any`.
- **Status:** adopted, pending CI.

### 30. Code shape after LOG 27–29; the last survivors were a counting gap

- **Shape:** each fact is written once and used where it is needed.
  `read` is `peek` plus the tracking half (the pull check was written twice);
  one `claim(s, e)` puts an edge in a source's slot and keeps a displaced
  cell, for `index` and for a new edge of an indexed pass, so `link` loses
  its `indexed` flag; `update` is `set(source, untracked(...))`; `flush` ends
  in `drainNow` and tests the queue first, as `set` does; `get` and `peek`
  are kernel `read` and `peek` under the public type (two CI runs:
  −16 % on `get`, −26 % on read.signal, full paths unchanged). Bytecode:
  `read` 103 → 87, `miss` 421 → 417, `peek` 27, `claim` 57; no inlining
  refusal on duplicate, stable, signal read and write, local edit,
  long-reorder, shared-chaotic or effect workloads. Release 2180 → 2147 bytes
  gzip.
- **Review of "two survivors are constant factors only timing sees":** both
  save structural work that no counter recorded. `no-fresh-source` saves the
  failed scan comparisons and the subscriber lookup of a fresh source (LOG 22
  said "no comparison counter"); `index-always` saves the slot walks, but
  the mark walks were counted as `indexes` too. A `sweeps` counter separates
  them, and three structural tests pin the work: a fresh source in a long
  list is linked with no lookup (LOG 22), a single reader's reorder marks
  and never indexes (LOG 28), and over shared sources only the first reader
  marks (LOG 29). The count assertions of the 64-shared-sources exactness
  test move to that structural test, so the earlier rules (`index-always`,
  `mark-any`) still pass every semantic and differential test and fail only
  the structural ones.
- **Result:** tests 66/66; all 26 ablations are killed (19 semantic, 6
  structural, 1 convention); checksums equal on every suite and probe.
  Counters are compiled out of the release.

### 31. P5 in-pass invalidation: a repeated read keeps the first observation

- **Witness:** `c = () => { x = a; a := 2 (once); return x + a }` with `a = 1`:
  quant and Reflex answer 3, 3, 3 on three demands while `a = 2` and an
  execution now gives 4; alien-signals answers 3, 4, 4. The repeated read
  stored the new version on the relation, erasing a change the first read
  already fed into the result. With A→B→A between the reads the erased
  change is a P1 change. Found while timing track.duplicate-64, whose 63
  repeated reads per step each paid that store.
- **Contract (SPEC):** P5 in-pass invalidation, a new invariant; D6 states
  the divergence from the provenance spec, whose `track()` refreshes the
  version on every reread and whose validation cache stamps the revision
  after the execution. The second half matters on its own: the spec answers
  1, 1, 1 for the single-read form `x = a; a := 2; return x`, which quant's
  existing F1 test requires to converge. The contract spec now applies D6
  (`test/support/contract-spec.ts`); on the spec machines the witness gives
  3, 3, 3 (spec) and 3, 4, 4 (contract). The corpora cannot express a write
  inside a computation, so D6 changes no corpus verdict: quant equals the
  contract spec on 27,061 bounded, 18,660 recovery and 100,000 generated
  programs, as before.
- **Runtime:** the three paths that recognise a repeated read (the previous
  read, the prefix scan, `take` for a pair found through subscribers or a
  slot) no longer store; first observations (cursor hit, suffix scan, new
  edge, an unread edge taken) do. One rule, whatever the distance between
  the two reads.
- **Evidence:** tests 72/72. `semantics.test.ts` P5: changing write then
  reread (3, 4, 4), same-value write (no execution owed), a change before
  the pass's first observation (none owed), A→B→A (owed), and one program
  per repeat path; `structure.test.ts` pins that those programs reach the
  prefix-scan, subscriber and slot paths (`test/support/p5.ts`), so the
  semantic level does not depend on the representation. New mutant
  `repeat-refresh` (the stores put back) is killed by the three P5 witnesses;
  all 27 ablations are killed (20 semantic, 6 structural, 1 convention).
  `miss` 417 → 401 bytes of bytecode, `take` 45 → 42; release 2147 → 2131
  bytes gzip. Probe `reorder` carries `refresh-repeats` (the previous
  behaviour) to time the change on CI; a local indication on
  track.duplicate-64 is within noise.

### 32. W5 construction atomicity: an `effect()` that throws leaves nothing live

- **Witness:** `effect(() => { get(s); throw e })`. The call throws, so no
  handle is returned, but the watcher stays live: `fail` keeps the read of
  `s` as a wake edge (F3), so `set(s, 1)` runs it again, and nothing can
  dispose it. Found by `test/torture-semantics.test.ts`, which carried the
  lifecycle shape of alien-signals issue #118 over to quant. The two
  runtimes are built differently, yet both fail the same lifecycle class.
- **Contract (SPEC):** F3 was stated for every watcher. It now covers an
  established watcher, one whose handle `effect()` returned. The new
  invariant W5: a call that throws returns no handle and leaves no live
  watcher. The rule follows the call, not the watcher's own run. If the
  watcher's run succeeds and a sibling run in the drain that the call
  opened throws, the call still throws and still returns nothing, so the
  same zombie would remain.
- **Repair (surface):** `effect()` wraps `start` and, on a throw, runs the
  host's existing `stop` before rethrowing. No state is added. A failed run
  commits no cleanup (`exec` commits nothing on a throw), so the watcher's
  own failure runs nothing. In the sibling case `stop` consumes the cleanup
  of the successful run, and that run's writes stay committed.
- **Layer:** the kernel's `fail` is right for an established watcher; only
  the surface knows that the handle was never published.
- **Alternatives rejected:** detach in the kernel a watcher that has never
  succeeded (`gen === 0`). A first run deferred by a batch or an open drain
  fails after its handle is returned, and F3 must keep that watcher; `gen`
  cannot tell whether the handle was published. Returning the handle and
  swallowing the error breaks error delivery. Stopping only on the
  watcher's own failure leaves the zombie in the sibling case.
- **Evidence:** `semantics.test.ts` W5: the watcher's own failure leaves
  no relation and no rerun; a sibling's failure rolls the call back (the
  cleanup is consumed and the write stays); a deferred first run is
  established and its failure is F3. Mutant `construction-commits` is killed
  by three tests; `run-direct` is now also killed by the W5 tests. Cost: a
  try/catch around `start`, off every hot path; about +9 B gzip.

### 33. C1: a precondition, diagnosed by the development build (CHECKING)

- **Witnesses**, one root cause. The cycle is `a = cyclic ? b + 1 : 0`,
  `b = a + 1`, read once, then `cyclic := true`:
  - (a) `get(b)` gave 3. `verify(b)` ran `a`, and `a` read `b`, whose STALE
    bit the walk had cleared on entry. `b` looked clean, so its committed
    1 was used. This is a delay element that no one specified.
  - (b) The same cycle, but with `b` DIRTY (it also reads a signal that
    changed), throws `Cycle`. The answer depended on how the node was
    invalidated.
  - (c) `get(a)` gave 2, and then `get(b)` gave 1 at rest, forever. `a`
    ran and read `b`; `b`'s validation reached `a`. `a` was BUSY, but `exec`
    clears STALE|DIRTY when a run starts, and `verify` tested BUSY only
    under those bits. So it compared `a`'s committed version, found it
    equal, and cleared `b`. `a`'s commit pushes nothing, so the
    invalidation was lost.
  - (d) No cycle in the graph: `a` writes `x` at depth 0, so `set` drains.
    An effect reads `x`, then `b = a + 1` (validated, because it was read
    before). The effect saw `b`'s old 1 and stayed clean while `b` became
    11. The same effect reading `a` directly threw `Cycle`.
  - (e) `check`, the watcher's validation, has the same blind spot. It
    compared the committed version of a source under validation. With (a)
    diagnosed, the read in the run throws, but only after the cleanup was
    consumed (P4).
- **Root:** a node on a validation walk has STALE cleared and no other bit
  set, so `read`, `verify` and `check` see it as a clean node at rest; and
  a BUSY node that no push marked again looks clean to `verify` and
  `check`.
- **Structural check:** `checkGraph` now asserts freshness: a live node
  that is neither STALE nor DIRTY has clean sources, at their current
  versions. It holds after every operation of every differential program
  and in every existing test; (c) and (d) are its first violations.
- **Contract (SPEC):** C1 is a precondition, not an invariant. A program
  whose demand reaches an evaluation in progress is erroneous. The
  development build diagnoses it with a cycle error; the production build
  gives it no defined result beyond graph integrity and the structural
  bounds, and pays nothing for a diagnosis. It is a precondition because
  no type can rule such a program out (the demand is made through a
  closure and depends on the order of evaluation), and because the
  diagnosis would be C1's only production cost. The committed value was
  rejected as the development build's answer: (b) makes it depend on
  invalidation history, and (c) and (d) show it is not even stable. (d)
  has no data cycle, so the precondition also covers a write during an
  evaluation whose synchronous drain demands the node in progress. The
  provenance spec assumes acyclic evaluation, so C1 is no D-decision.
- **First repair, and why it was not minimal:** a new bit, `1 << 9`. The
  read mask became 519, which needs a wide operand, so `peek` grew from 27
  to 30 bytes of bytecode, past V8's threshold for always inlining a small
  function (`--max-inlined-bytecode-size-small=27`, TurboFan and Maglev).
  stable.wide-8 ran at 1.13× HEAD in every round of a local A/B (an
  indication, not evidence). A W3 guard in `exec` added 8 more bytes there.
- **Minimal repair:**
  - No new bit: CHECKING takes WOKEN's bit (32). WOKEN belongs to watchers
    and CHECKING to computeds, and no node is both: a walk visits sources,
    and a watcher is never a source. Every mask stays a byte.
  - CHECKING is set by the store that already clears STALE (the root and
    each descent). It is cleared by `exec`'s store that sets BUSY (the mask
    becomes ~35 instead of ~3, the same size), and by one store of its own
    only when the walk finds a node clean. If the read path inspects only
    `n.flags`, two writes per validated node are the floor: the state "in
    progress" must appear there and disappear again.
  - Under `__DEV__`: every write of CHECKING, and the BUSY extension of the
    source tests in `verify` and `check`. The CHECKING tests in the masks of
    `peek` and `pull` stay in both builds. Production never sets the bit on
    a computed, so they are inert there and cost nothing (the immediate is
    a byte either way).
- **Production equals HEAD on the hot path.** In the production build, the
  bytecode lengths of `peek` 27, `read` 87, `pull` 60, `exec` 244, `write`
  244, `mark` 162 and `check` 177 equal HEAD's. `verify` grows from 333 to
  371, all of it W3 (LOG 34). The development build has the same lengths,
  with `verify` at 394.
- **Build:** `scripts/build.mjs` also emits `dist/index.development.{js,cjs}`
  (`__DEV__` true, constants folded, names kept), which `package.json`
  selects through the `development` condition. The release check
  smoke-tests both builds and checks the split: on (a) the development
  build throws `Cycle detected` and the production build answers. It also
  checks that no artifact carries an unreplaced `__DEV__`. `npm test` runs
  the development build. `npm run test:production` (vitest
  `--mode production`, also run in CI) runs the suite against the
  production build and skips the seven tests of the diagnosis. vitest
  replaces quant's `__DEV__` file by file, because the Reflex runtime reads
  a global `__DEV__` of its own.
- **Alternatives rejected:**
  - C1 as an invariant in production. With the minimal layout its only
    production cost is one store per node a walk finds clean (a local
    indication on a chain of 100 clean nodes: 1.04× HEAD). The precondition
    makes the production build pay nothing.
  - Lazy marking: mark the walk only before it runs a node. It needs no
    store in a walk that runs nothing, but two per node in a walk with a
    run below them (a cutoff at the bottom of a chain), and more code.
  - BUSY meaning "run or validation on the stack". `write`'s BUSY branch
    (no DIRTY; versions decide) would apply to nodes under validation, and
    `dispose` would defer detaching to the end of a run that a validation
    never reaches, so the relations would leak.
  - Keeping STALE during the walk. A read would re-enter `verify` on the
    same node, and pushes during the walk must re-mark it (LOG 8).
  - Marking the path DIRTY. A read would run the node inside its own
    validation: two executions in one wave (P3).
  - Searching the work stack on reads. A node under validation and a clean
    node have identical flags, and the read path inspects only `n.flags`, so
    every read would have to search: S1.
- **Evidence:** `semantics.test.ts` "C1 evaluation in progress (development
  build)": (a), (b), (c), (d) with both reads, (e) through the cleanup
  count, and every ring of length 1 to 4, for every gate and demanded node,
  demanded directly or from a consumer above (60 programs). Seven
  diagnostic ablations run against the development build: `no-checking-read`,
  `no-checking-descent`, `checking-kept-when-clean`, `checking-kept-on-run`,
  `checking-kept-on-failure`, `verify-busy-blind` and `check-busy-blind`.
  All are killed. Only the "from above" programs kill
  `no-checking-descent`, because in a simple ring the walk always closes on
  its own root. `no-cycle-check` (BUSY on read, in both builds) is now
  killed by five tests instead of one.
- **Classification:** development diagnostic (SPEC). It is not counted in
  the mechanism basis.
- **Status:** adopted, pending CI.

### 34. W3: a computed disposed during its own validation is not run

- **Witness:** `a = () => { v = get(s); if (v === 1) dispose(b); return v }`,
  `b = a + 1`, then `s := 1` and `get(b)`. This threw
  `TypeError: n.fn is not a function`. `verify(b)` ran `a`; `a` disposed
  `b`, which was not BUSY, so it was detached at once; `a` changed, so
  `verify` ran `b` with `fn === null`. It was found while looking for (a)
  of LOG 33 and has the same root: an evaluation in progress was
  invisible. Unlike C1, it is a crash in a legal program, and nothing
  before production can rule it out, so the repair ships.
- **Contract (SPEC):** W3 now reads "safe inside the node's own pass and
  its own validation".
- **Repair (kernel):** `verify` does not run a node whose `fn` is null, at
  its two decisions to run one (a source changed, or the climb reaches a
  parent whose child changed). Its catch does not leave such a node DIRTY,
  which would otherwise make a later read or validation run it. `exec` is
  untouched, so a run that no validation decided pays nothing.
- **Alternatives rejected:** a guard in `exec` costs every run a compare
  and adds 5 bytes of bytecode there. Deferring disposal while the node is
  under validation, as for BUSY, would need a detach in the climb.
- **Residual:** the walk goes on over the disposed node's removed edges
  (the cut keeps their `next` chain) until the first changed source, so a
  source validated after the disposal can still throw into the demand in
  progress. Later reads return the frozen value.
- **Evidence:** `semantics.test.ts` "W3 disposal during validation": the
  disposed node's own source changed, the climb reaches it through `m`, and
  a later source throws in the same walk. Mutants `disposed-run`,
  `disposed-run-climb` and `disposed-left-dirty` are each killed by their
  program.
- **Cost:** production `verify` grows from 333 to 371 bytes of bytecode;
  no hot function changes. With W5 (about +9 B), the production release
  grows from 2131 to 2163 B gzip; the development build is 2962 B.

### 35. The work stack gives back what a deep walk grew (structural, retained memory)

The placement argument here is historical and incomplete; LOG 40 corrects
it for cold execution, direct watchers, failed validation and push-only work.

- **Witness:** read a chain of 2,000 computeds, then validate it once. The
  shared work stack keeps 1,999 slots for good: walks null the slots they
  pop but never shrank the array. Retained memory followed the deepest walk
  ever, not the live structure. The stack is not graph, so S4 does not name
  it; this is the same kind of repair as clearing the pointers of a
  detached edge.
- **Repair:** at the end of an outermost validation (base 0, so top 0), a
  stack longer than TRIM (512) is cut to KEEP (256) by setting its length.
  V8 right-trims the backing store in place. Checked with
  `--allow-natives-syntax`: the FixedArray at the same address went from
  capacity 22,583 to 256 and stayed PACKED_ELEMENTS, also when it grew
  again. The gap TRIM = 2 × KEEP keeps walks only a little deeper than KEEP
  from cutting and regrowing on every pass. A steady workload deeper than
  TRIM regrows on every pass, which copies O(depth), the same order as the
  walk.
- **Placement, the cheapest found:** only `verify`'s outermost exit. The
  guard tests the length first (one load and one compare, false in the
  common case), then the base. The same guard in `mark` cost 29 bytes of
  bytecode there (162 → 191), on the write path, and it is not needed. A
  deep mark runs through computeds that are STALE afterwards, so their next
  demand is an outermost validation, whose end cuts the stack whichever walk
  grew it (tested).
- **Alternatives rejected:**
  - a test at every push: a cost per element;
  - a new array: `stack` would change from const to let, and the warm
    buffer would be lost;
  - `splice`: it allocates;
  - the host's drain end: it misses reads that drain nothing, and the work
    stack is kernel state.
- **Cost:** in the production build, `verify` grows from 371 to 404 bytes
  of bytecode; `peek`, `read`, `pull`, `exec`, `write`, `mark` and `check`
  keep HEAD's lengths. The release grows from 2163 to 2193 B gzip.
  `stackHighWater` (research) keeps the peak `trim` cut, under `__STATS__`
  only.
- **Evidence:** `structure.test.ts` "work stack at rest": a deep validation
  cuts the stack back to KEEP; a stack a deep mark grew is cut by the next
  outermost validation; a validation no deeper than TRIM leaves the stack as
  it is. Mutant `no-trim` is killed by these tests only (structural).

### 36. SETTLE: a wrapped generation never makes a committed edge tentative

- **Witnesses** (`test/generations.test.ts`). A committed edge keeps its
  birth generation, because reuse never restamps it, and an edge counts as
  tentative while `e.gen === (node.gen + 1) & MASK`. After 2^30 - 1 commits
  of its node, an edge from the first run reads as tentative again. The
  tests forge only the counter (`gen = MASK`, as after 2^30 - 1 runs); one
  real successful run then wraps it to 0.
  - A watcher driven by a computed stops running, with no failure at all.
    The first loop of `check` skips the pull of a "tentative" source, sees
    the old version and owes nothing, so the watcher never commits again
    and its generation stays in the colliding state. It is a permanent
    stall after exactly 2^30 runs of the watcher: 207 days at 60 runs a
    second, 12 days at 1,000.
  - A failed watcher (F3) or computed (F1) loses a committed edge that its
    failed run did not read: `fail` drops it as a tentative edge left by an
    earlier failure. A write to that source no longer wakes the watcher.
  - An owed watcher skips the pull of a committed source (the second loop
    of `check`), so its cleanup runs before the validation failure (P4).
- **Contract:** none changes. F1, F3 and P4 were broken by a property of
  the construction (masked SMI generations and an equality test), so the
  repair is an implementation lemma.
- **Repair:** when a commit makes `gen & SETTLE` zero (SETTLE = 2^29 - 1),
  the node restamps all its edges with its generation (`settle`). At a
  commit every edge is committed, so this is exact. No committed edge is
  then more than 2^29 behind its node, while a collision needs 2^30 - 1.
  Once a cycle is not enough: an edge stamped at the restamp collides 2^30 -
  1 commits later, one commit before the next restamp, whatever the phase.
  The cost is one AND and one compare per successful run, plus O(d) once in
  2^29 runs.
- **Alternatives rejected:**
  - Restamp on every reuse: a store on every stable read (S1's path).
  - A per-edge tentative bit: it must be cleared at every commit, O(new
    edges) per run.
  - Unmasked generations: they become doubles past the SMI range, which
    generalises the field representation.
  - Without bounding the age of an edge, a finite counter cannot tell
    "born in the next run" from "2^30 - 1 runs old". Some bound has to be
    paid, either per read or per commit; per commit is cheaper.
- **Cost:** `exec` grows from 244 to 272 bytes of bytecode (production
  build); `peek`, `read`, `pull`, `write`, `mark` and `check` are
  unchanged. The release grows from 2193 to 2221 B gzip.
- **Evidence:** five tests in `generations.test.ts`: the stall (no
  failure), F3, F1, P4, and both restamp phases. Mutant `no-settle` is
  killed by all five. `settle-once-a-cycle` (restamp only at the wrap) is
  killed by the phase test.

### 37. Torture round 2 and two cost curves (no mechanism)

- **Lifecycle** (`test/torture-lifecycle.test.ts`, all green, no repair):
  - A throwing cleanup leaves the execution owed (F4), and the next delivery
    discharges it once.
  - A cleanup that writes a source of its own watcher and then throws: the
    write commits and delivers the watcher again in the same drain (W2), so
    each delivery is one cleanup and one run, and the error reaches the
    writer. At disposal the last cleanup runs after teardown, its write
    wakes nothing, and its error reaches the disposer.
  - A watcher disposed while queued stays inert.
  - A failing watcher does not stop later watchers from growing the queue.
  - A throwing `peek` inside a computation restores the context and
    records nothing.
  - Failures across a full reorder (committed A, failed B, failed C, failed
    reverse(A), A again) keep the committed frontier and only the last
    attempt's reads. The recovery reuses the very same relation objects,
    with no link.
- **Contract characterization:** a computed that fails during a watcher's
  validation surfaces to the writer, and the effect's own try/catch never
  sees it (P4). This is the point where a runtime that executes the effect
  first, and lets it catch the error, has a different contract.
- **Failed-computed fanout** (local, scratch script: one computed throwing
  on every run, N effects). Quant runs the getter exactly N times per
  update, at about 5 µs per watcher (each retry constructs a new exception).
  That is linear, and F1 with D2 forces it: every watcher's validation is a
  demand, and a failed computed executes on each demand, as the executable
  contract spec does. alien-signals 3.2.1 and Reflex run the getter at most
  once per step here, because their effects stop being delivered after the
  failure (Reflex by design, D5). A contract that caches a failure until a
  source changes would make this O(1) getter runs per wave; that changes F1
  and is not adopted here.
- **Identity curves** (`bench/scaling.mjs`; local, 3 rounds; CI times
  them):
  - `shuffle` (reorder all): quant runs at 0.11–0.48 of alien.
  - `replace-all` (every relation new, on private sources): quant runs at
    0.74–0.93 of alien and 0.80–0.90 of Reflex. The new relations are
    proven absent for free, because a source without subscribers needs no
    search (LOG 22).
  - `replace-all-shared` (the same sources are also read by another
    computed): quant runs at 1.16–1.43 of alien and about 1.37 of Reflex.
    The structural counters show the same links and unlinks as alien, plus
    exactly one subscriber lookup per new relation. That lookup is the
    price of exact identity when the identity really is new.

### 38. Edge-only work stack (optimization, no new mechanism)

- **Redundancy:** an occupied source slot satisfies `s.slot.from === s`.
  `index` calls `claim(e.from, e)`; the other caller claims the edge just
  created by `link(c, s, ...)`, whose `from` is `s`. Edge endpoints are
  readonly and no graph operation changes them. Clearing a slot preserves
  the invariant; restoring `cell.from.slot = cell` establishes it directly.
  The saved source in a `(source, cell)` pair therefore carries no fact
  that the saved cell does not already carry.
- **Change:** save just the displaced edge and restore through its `from`.
  Mark and validation already save only edges, so `WorkStack` narrows to
  `(Edge | null)[]`. Every walk still captures its own `base`, pops back to
  it, and clears every popped array slot. Success and failure still unindex
  before pruning edges; disposal of a running node still defers teardown
  until that node unwinds. No contract, mechanism, flag or persistent field
  changes. The displaced-cell mechanism remains necessary for T2/T3.
- **Bound:** for B suspended walker entries and P displaced cells, the
  active stack uses B + P entries instead of B + 2P. Work stays O(P), with
  one fewer push, pop and null store per displacement. The minimum retained
  length KEEP and the trim rule are unchanged; this is not a claim that
  total graph memory halves.
- **Regression evidence** (`test/work-stack.test.ts`): 16 representation
  tests cover three increasing widths, four nested indexed readers,
  identical-cell restoration, late repeated reads, caught/escaping failures,
  self/outer disposal with both normal return and throw, all those exits
  above 20 suspended validation frames, and pending mark siblings below an
  indexed run. Every completed operation checks graph integrity and idle
  state. The old representation passes the 15 restoration/walker tests and
  deliberately fails the new footprint assertion (1200 entries vs 600).
- **Differential evidence:** the added shrinkable generator uses 12–32
  shared sources, ten earlier subscribers and 2–5 nested readers, with
  reorders, repeated prefix reads after nesting, narrowed frontiers, failures
  at every depth, recovery, watcher cleanup and disposal. It checks the
  graph and idle state after every operation, requires an index to have
  occurred, and gates on equality with the frozen contract spec. Removing
  displacement save/restore kills this differential test and all 16 new
  representation tests (`no-displaced`: 18 failing tests including the
  existing nesting witness). All 41 mutation anchors and the cost bundles
  still build; both textual ablation anchors were updated.
- **Validation:** development seed 7: 133 passed; production seed 20261109:
  126 passed, seven development-only diagnostics skipped. Each full run
  includes 20,000 general and 1,000 wide nested generated programs, plus
  the historical, bounded-exhaustive and recovery-exhaustive corpora. The
  unchanged baseline (48f83b4) also passes the differential suite with
  4,000 general and 500 wide programs at seed 7, so both versions agree
  with the same contract oracle. Typecheck, lint, source formatting, build
  and release checks pass, including minified/unminified equality on 18
  scenarios / 5,400 steps.
- **Repeated local measurement** (Windows, Node 25.2.0, production flags;
  baseline 48f83b4 vs this change): four nested readers, ten earlier
  subscribers, all shared sources read forward/reverse on alternating
  ticks. At widths 128 / 256 / 512, observed peak array lengths are
  774 / 1542 / 3078 before and 387 / 771 / 1539 after, with equal values.
  At width 32, seven alternating A/B rounds of 20,000 updates after 5,000
  warmup updates give after/before time ratios 0.887–0.967 (median 0.916),
  all with checksum 40,920,000. This is a local nesting workload, not a
  general speed claim. A minified ESM probe without banner or source map
  shrinks from 5,832 to 5,805 bytes (gzip 2,194 to 2,185).

### 39. Final detach releases the dependency cursor (S4/resource correctness)

- **Witness:** read a computed with d private numeric sources, dispose it,
  and retain only its handle. Baseline 2d64f3c removes every subscription
  and clears `deps`, but leaves `last` pointing to the former tail edge.
  Its `from` retains a source; its `prev` chain reaches all d former edges
  and their sources. The handle therefore reaches 2d + 1 graph objects
  despite having no live upstream relations: 3 / 17 / 129 / 1025 objects
  at widths 1 / 8 / 64 / 512. A deps/subs-only graph checker misses this
  path, and functional observations alone cannot detect it.
- **Classification:** structural/resource-correctness repair under S4's
  retained-graph rationale. The reactive contract does not change; no new
  mechanism, field, flag or lifecycle policy is introduced.
- **Minimal repair:** after `cut(n, null)` in the shared final `detach`,
  clear `n.last`. This covers ordinary disposal and both successful and
  throwing exits after disposal during a run. An idle node disposed during
  validation detaches immediately; its cursor is not used by that walk.
  Clearing in `dispose` itself would be premature for a BUSY node: later
  reads still use its cursor, and indexed teardown must run before cutting
  its deps. Clearing every live pass's cursor adds unnecessary stores;
  clearing the cached value would break the disposed computed's freeze.
- **Structural evidence:** `checkGraph` now requires every non-null cursor
  to belong to its node's deps list. The new retention suite follows all
  graph pointer fields, including `last`, from the retained handle, so the
  witness is deterministic and does not rely on GC timing. It covers empty
  and wide graphs, repeated failed frontiers, indexed self-disposal and
  subsequent reads, watcher self-disposal, return/throw exits, cleanup
  ordering and cleanup failure, queued disposal, direct/indirect validation
  with a later failure, lazy disposal, downstream subscribers and cached
  object identity. There are 21 tests; the two zero-cursor boundary cases
  already pass on the old implementation.
- **Differential evidence:** the added shrinkable disposal corpus covers
  never-run, successful, first-failed and failed-rerun watchers, throwing
  disposal cleanups, branch changes, repeated attempts, shared sources,
  surviving watchers and idempotent disposal. Observations are gated on the
  frozen contract spec, and graph integrity is checked after every operation.
  The existing differential language disposes watchers only; computed
  disposal and in-pass/validation cases are checked through the public API,
  without extending that language or the frozen spec.
- **GC corroboration:** production bundles of baseline and repair, Node
  25.2.0 with `--expose-gc`; retained handles, primitive cached values, weak
  references to the former sources, eight full collections separated by
  event-loop jobs. All 1 / 64 / 512 sources remain alive before the repair;
  none remain alive afterwards. Frozen values are identical. These are
  local corroborating measurements, not GC-timing assertions in the suite.
  A cached object or a retained downstream relation can intentionally keep
  other objects alive; the repair removes the cursor's stale path only.
- **Validation:** development seed 7: 155 passed; production seed 20261109:
  148 passed and seven development-only diagnostics skipped. Per mode,
  QUANT_RUNS=20000, QUANT_SLOT_RUNS=1000 and QUANT_DISPOSE_RUNS=1000, plus
  historical, bounded-exhaustive and recovery-exhaustive corpora. Mutant
  `retain-disposed-cursor` is killed by 32 tests, including the new targeted
  differential case; all 42 mutation anchors validate. Typecheck, lint,
  source formatting, build and release checks pass. The production release
  grows from 2244 to 2245 bytes gzip; no per-read work is added.

### 40. Trim at stack-producer exits, without a depth register

- **Correction to LOG 35:** successful `verify` is not a reclamation boundary
  for all work. A cold DIRTY demand can grow the displaced-cell stack and
  finish through `exec` alone; a watcher can execute directly without an
  enclosing `pull`; failed validation unwinds without reaching its success
  exit; a deep push need never be followed by any demand. Baseline 0d6f201
  fails ten of the first thirteen focused capacity witnesses. The retained
  scratch-buffer requirement is the one already motivating LOG 35, not a
  new reactive semantic or a change to the frozen contract.
- **Why the pasted `outerDemand` equivalence is too strong:** `active` names
  the tracked consumer, not JS call depth. `untracked` temporarily sets it
  to null inside a still-running computation. Also, graph walkers can hold
  continuations in local variables without an occupied stack entry. Thus
  `top === 0 && active === null` does not prove that no user/graph call is
  suspended. The relevant safety fact is narrower: `top === 0` means the
  work buffer has no occupied entries to truncate.
- **Chosen repair:** put `stack.length > TRIM && top === 0` in the existing
  `trim` helper. Call it on mark's completed walk, verify's success exit,
  verify's fully unwound failure exit, and the end of unindex. These are the
  exits of the only three stack producers: sibling edges in mark, validation
  edges in verify, and cells claimed by an indexed pass. Both normal and
  failed indexed execution unindex before pruning/disposal, so they share
  one check. No work-depth register, active-context test, API export or host
  policy is added. `read`, `peek`, `pull`, `write`, `exec` and `fail` stay
  unchanged. The `idle` comment now describes its registers, not JS depth.
- **Safety and completeness:** every producer returns to its saved base
  and clears popped entries. A nonzero base prevents trimming while another
  owner still has buffered entries; the last releasing owner checks at zero.
  Local cursors, source slots and suspended callbacks do not occupy the
  buffer and are unaffected by its length. The length check comes first,
  so small buffers do not load `top`. KEEP=256, TRIM=512 and the same array
  identity remain. A large sibling run can regrow after an earlier sibling
  trimmed; each such regrowth is chargeable to the pushes it requires, so
  work remains amortized O(pushes). This is a capacity/code-cost choice,
  not a claim of universally fastest placement.
- **Compared candidates** (production minified ESM probe, no banner or map):

  | Placement | Bytes | Gzip | Coverage |
  | --- | ---: | ---: | --- |
  | baseline: successful verify only | 5817 | 2186 | incomplete |
  | pasted pull/finally only | 5837 | 2198 | misses push-only work and direct watcher runs |
  | shared guard at producer exits (chosen) | 5831 | 2193 | complete |
  | verify/finally + mark/unindex | 5834 | 2193 | complete |
  | duplicated inline guards at producer exits | 5886 | 2198 | complete |
  | guards at write, exec/fail and verify boundaries, with active test | 5958 | 2209 | complete |

  The pull/finally probe passes ten of the initial thirteen witnesses,
  failing push-only work and both direct-watcher exits. Moving that guard
  alone is insufficient; putting trim in public set/batch also misses
  effect construction and direct kernel execution, and needs care when
  drains throw. The producer-exit repair stays inside the kernel.
- **Bytecode cost** (Node 25.2.0, production kernel probe retaining names):
  shared trim changes mark 162→168, verify 405→388, unindex 79→85 and trim
  11→38 bytes: +22 total. Read/peek/pull/write/exec/fail remain
  88/27/61/240/260/182. Duplicated guards add 87 total; boundary guards add
  150. Pull/finally grows pull 61→128 despite its incomplete coverage.
  Verify/finally has the same gzip as the chosen repair, but verify is 410
  bytes instead of 388 and the minified probe is three bytes larger. This
  is the cheapest complete placement checked, not a universal lower bound.
- **Timing cross-check:** five rounds with rotated variant order, separate
  processes, production bundles, 180 ms/1,000-step warmup and seven samples
  per process. Seven existing cases cover clean reads, chain, widths 8/256,
  fanout, chaotic sharing and lifecycle; three additional cases cover
  1,200-deep validation, push+pull, and eight indexed sibling branches of
  width 600. Checksums agree. The chosen repair's median time ratios to the
  incomplete baseline range 0.984–1.062. Variants trade places by workload;
  there is no general speed win. In the sibling probe, after a full step the
  baseline retains 601 slots and all complete candidates retain 256.
- **Evidence:** `test/trim.test.ts` adds thirteen targeted cases and a
  shrinkable sum-model differential case (widths 257–1024, depth 2–5,
  changes, reversal, failure/recovery and tracked/untracked nesting). Tests
  cover both hysteresis boundaries, normal/throw/disposed cold execution,
  direct watcher execution, failed validation, no later demand after push,
  and live validation entries under untracked. Removing each producer-exit
  check is caught separately: no-trim-mark by 3 tests, no-trim-validation by
  5, no-trim-failed-validation by 1, no-trim-unindex by 9; disabling all
  trimming is caught by 17. These counts are representation evidence in
  this architecture, not proofs that no alternative placement can work.
- **Validation:** development seed 7: 169 passed; production seed 20261110:
  162 passed, seven development-only diagnostic tests skipped. Each mode
  runs 20,000 general, 1,000 nested-index, 1,000 disposal and 1,000 wide
  sum-model generated programs, plus the fixed/exhaustive corpora. All 46
  mutation anchors validate. Typecheck, lint, formatting, build and release
  checks pass, including 18 release scenarios / 5,400 steps. Published ESM
  grows from 2245 to 2252 bytes gzip, with zero new persistent state.

### 41. Verify inlining is profile- and tier-dependent

- **Question:** the bytecode sizes in LOG 40 do not establish whether
  `verify` is inlined. They measure code footprint, not a guaranteed call
  removal or a speed improvement.
- **Probe:** Node 25.2.0 / V8 14.1.146.11-node.13; production flags, both
  name-retaining and fully minified public API bundles. The new
  `bench/inlining.mjs` supplies cutoff and changing 3-link chains (400,000
  updates) and a changing 1,200-link chain (50,000 updates), all with an
  independently checked checksum. Trace with `--trace-opt`,
  `--trace-turbo-inlining` and `--trace-maglev-inlining`; the last flag
  disables concurrent Maglev for diagnostic output, so trace timings are
  not benchmark timings. No inlining limits or optimization intrinsics are
  changed. Generated minified function names are mapped from their AST.
- **Maglev:** explicitly refuses current `verify`: "big function, size
  (385) >= max-size (100)". The default single-function budget is 100.
  The actual public-bundle bytecodes of baseline/current/inline-guards/
  verify-finally are 402/385/435/407; the raw kernel probes in LOG 40 retain
  more exports and measure three bytes more. Both layouts give the same
  tier distinction.
- **TurboFan:** on the hot shallow profiles, traces explicitly inline
  `verify` into `pull` (and into callers after pull itself is inlined).
  On the 1,200-link profile no such inlining was observed; `verify` gets
  optimized as a separate function, including OSR. This holds for baseline,
  current shared guard, inline guards and verify-finally in these runs.
  Being below the default 460-byte single-function budget only permits
  consideration; frequency, total budget and the caller's profile matter.
- **The trim call is a separate question:** TurboFan explicitly inlines
  current `trim` into `verify`, `mark` and `unindex` in the corresponding
  hot validation, push and indexed-run probes, including when verify itself
  remains separate. The 38-byte helper is not an always-small function at
  the default 27-byte threshold. Cold/error sites are not promised inlined.
- **Consequence:** keep LOG 40's choice as the smallest checked complete
  code/state mechanism, not as a claim that 388 rather than 410 bytes makes
  verify inline. Both can inline in TurboFan; both exceed Maglev's budget.
  No runtime change follows from this audit. All three profile checksums
  agree between dist/index.js and the name-retaining production twin.

### 42. Engine feedback: literal masks help guards, but not every workload

`research/ENGINE-FEEDBACK.md` records the Node 25.2.0 / V8 14.1 audit, IR
and machine-code guard comparisons, warmup/steady deopts, field/element
transitions, and three rejected source reshapes. `bench/feedback.mjs`
provides reusable public-API workloads with a steady-state marker.

The concrete positive finding is that an emitted literal MASK (including
through a const enum) removes CheckedInt32Add, one integer conversion and
one field load from the observed write graph; the overflow deopt exit is
absent in final code. Merely `| 0` and a second mask through the existing
module binding do not. The const-enum prototype passes 64 tests, but its
five-round timing comparison includes a 1.057 ratio on wide indexed
siblings, so it remains a research candidate rather than a runtime change.

Local and explicitly guarded pop cursors do not remove the bounds checks.
The local-cursor candidate passes 49 tests but has no consistent material
timing gain. All six feedback profiles have zero post-warmup bailouts in
the observed runs; existing guards still execute and are not thereby free.
No new runtime mechanism, field, guard or type/range restriction is admitted.

### 43. Tracking phase facts need no persistent node state

- **Classification:** representation simplification / implementation lemmas;
  no new semantic or structural mechanism. The contract and kernel/host
  delivery protocol are unchanged.
- **Combined change:** remove `Node.last`, `Flag.Indexed` and `Flag.Marked`.
  A node now has nine fields instead of ten; tracking uses no persistent
  mode bits. `active` and `cursor` are execution registers saved/restored
  together on both exits from `exec`. Capture the pass's final cursor before
  restoring the enclosing registers, then use that edge for unindexing,
  successful suffix pruning or failed-attempt pruning. `untracked` clears
  only `active`, so nested untracked work cannot lose the enclosing cursor.
- **Indexed certificate:** after the first indexed miss is consumed, the
  cursor's source slot equals the cursor. Every subsequent accepted read in
  that pass also owns its source slot. A different consumer cannot install
  that edge (T2), and a nested indexed pass restores displaced cells before
  returning (T3). Thus `last !== null && last.from.slot === last` replaces
  the mode bit in lookup and on both execution exits. Direct representation
  tests force indexing only after a known accepted read (`indexAfter`), not
  before the first read; production tracking enters indexing and consumes
  the miss in the same operation.
- **Marked certificate:** unread edges form a continuous suffix, certified
  by `next !== null && next.ver === UNREAD`. A sequential read consumes its
  head; a move consumes a deeper unread edge and places it before the suffix;
  a link inserts an already observed edge before it. Failure deletes only
  unread tentative relations; retained committed relations stay in the suffix.
  Once it is empty, bounded scans/subscriber lookup remain bounded per miss,
  with indexing on budget exhaustion. An empty suffix needs no mark sweep.
- **Resource consequence:** the LOG 39 retention path through a retained
  node's `last` no longer exists. Final detach needs no cursor reset. A pass
  still retains its local edge until it restores displaced slots and unwinds;
  this preserves self-disposal followed by more reads, including throwing
  exits. Retention tests continue to walk every remaining graph pointer.
- **Existing reductions:** LOG 38 already made each displaced-slot record
  one edge (`edge.from` recovers its source) and reused the same stack for
  mark/pull continuations. LOG 25 already removed a separate retry flag.
  These changes share the lifetime principle; they are not new mechanisms.
- **Boundary:** generations and `SETTLE` remain. Committed/tentative evidence
  must survive failure; eliminating generations would move that information
  into another representation. If `ver` also encoded tentative state, the
  `UNREAD` certificate and linear retry bound would need to be re-established.
  `Woken + Queued -> Pending` is also excluded: it changes delivery-token
  ownership and requires a nonthrowing wake hook or acknowledgement protocol.
  `Stale`, `Dirty`, `Busy`, `slot`, relation versions, `lastSub` and host
  draining/batching state are not removed by these arguments.
- **Evidence:** all 169 existing development tests pass unchanged in count.
  Two added S3 witnesses exercise reverse retries at widths 64, 128 and 256,
  for private and shared sources, with mixed committed/tentative relations:
  no new relations, at most one mark/index walk, linear indexed work and
  lookups, then exact pruning on recovery. Production: 164 passed, seven C1
  diagnostics skipped (171 total). Typecheck, lint, formatting, build and
  release checks pass (ESM 2,262 B gzip; minified/unminified agree on 18
  scenarios and 5,400 steps). All 46 ablation anchors and the Reflex idle
  anchors validate;
  the obsolete `retain-disposed-cursor` edit is retired, and
  `no-cursor-restore` is killed by 64/171 tests, including differential tests.
  The retained certificates remain covered: `no-mark` fails 7/171 tests,
  `no-unread` 9/171 and `no-displaced` 25/171.
  This is evidence for this construction, not a universal minimality theorem.

### 44. Reuse graph evidence before chasing another object

- **Classification:** optimization; no contract, mechanism basis, object
  shape, persistent register or allocation-site change.
- **Change:** keep the previous source pointer across repeat/indexed tests;
  pass the already read subscriber head to pair lookup and mode selection;
  prove a fresh source absent before inspecting suffix mode; reuse occupied
  slot cells, propagation heads/siblings and host flags.
- **Lifetime:** snapshots stay inside regions that cannot invoke user code.
  Mutable fields are reloaded after execution, validation, wake and cleanup
  boundaries. Stable read and validation bodies are unchanged. Extra repeat checks before
  stable cursor hits were not introduced.
- **Audit:** [ACCESS-AUDIT.md](./ACCESS-AUDIT.md) records the exact access
  paths, compiler feedback and rejected flags/generation/expanded-loop/ascent
  candidates. Fewer accesses in TypeScript are not sufficient
  performance evidence; some are already eliminated by V8 and some reshapes
  regress a narrow hot path.
- **Evidence:** 172/172 development tests; 165 production tests pass and seven
  diagnosis tests skip. The added structural witness eliminates a lookup for
  a fresh source read inside an already marked pass. All 46 ablation anchors
  and Reflex idle anchors validate; cost-probe builds, typecheck, lint,
  formatting, build and release checks pass. `no-fresh-source`, `no-displaced`
  and `repeat-refresh` are killed by 2, 25 and 3 tests respectively.
  Reusing the settled node on ascent saved a LoadField but added a pointer
  check, with no established material timing gain, so the original comparison
  remains. The ESM bundle grows from 2,262 to 2,280 B gzip.
- **Timing:** the new `track.fresh-after-reorder-64` benchmark exercises
  fresh subscriptions inside a marked reverse pass. Seven local rounds:
  2,631.6 to 2,527.9 ns/step (0.961 ratio of medians, 0.952 median paired
  ratio). Broad screens cover 21 cases, with final and rejected variants
  recorded in the audit. Stable/lifecycle timing spread is explicit; this
  is not a blanket or portable speedup claim.

### 45. The host queue holds queued watchers, not deliveries (S8)

- **Classification:** structural bound, added to the contract as S8; no
  flag, node shape or surface change.
- **Defect (1.1.2 and earlier):** a watcher leaves QUEUED when `drain` takes
  it, so each delivery in one drain takes a new slot. After the drain, `size`
  returns to 0, but the backing array keeps its length. With W = 1, one
  self-invalidating watcher (W2) delivered 100,000 times in one drain left a
  100,000-slot queue, and the queue kept that length afterwards. Queue
  storage was O(deliveries), not O(pending obligations). That alone meets
  the inclusion criterion, with no engine failure needed.
- **Consequence under unbounded growth (not reproduced):** a dense queue
  that keeps growing will eventually reach an engine limit on the backing
  store or on allocation. This is an engine limit, not Array's 2^32 - 1
  length. If the indexed store in `wake` throws after `size++`, `size`
  counts a slot that was never written. The store sits inside `mark`, which
  has no unwind. The next take reads the hole outside the per-run `try`, and
  `draining` then stays true, so every later `flush` looks reentrant.
- **Repair:** at each take, the drain checks two conditions: at least TRIM
  slots are spent, and they make up at least half the queue. When both
  hold, it moves the live tail to the front (`copyWithin`) and nulls the
  duplicates the move leaves behind. The move costs O(live) <= O(spent),
  which is amortized O(1) per delivery. At rest, a queue longer than TRIM
  is cut back to KEEP, as the work stack is (LOG 40).
- **Bound:** let h be the spent slots and t <= W the live ones at a take,
  where W is the most watchers queued at once. Without a move, h < TRIM or
  h < t <= W. The run adds at most W - t + 1 slots, so size stays within
  max(TRIM + W, 2W). The contract states only the class: O(W) plus
  constant slack, with no storage for completed deliveries (S8). TRIM, KEEP
  and the way compaction is done can change without changing S8.
- **Not added:** a `try/finally` around drain bookkeeping. Once the queue is
  bounded, `wake` performs only flag operations and a store into an O(W)
  array, so the only thing left that can throw is engine OOM. A `finally`
  that reset `draining` would not repair a mark that `wake` interrupted, so
  it would hide the broken state rather than restore a correct one. Wake
  stays no-throw by construction, not by recovery.
- **Evidence:** the "S8 host queue capacity" witnesses in
  `test/structure.test.ts` cover W = 1 and W = 4 * TRIM. They are checked
  against max(TRIM + W, 2W), plus a burst retained after the drain. On the
  baseline, the first two report a 100,000-slot peak and 100,000 slots
  retained. The ablations `no-queue-compact` and `no-queue-trim` are killed.
  Five local rounds of `batch.writes-32`, `lifecycle.mount-100`,
  `diamond.8x8`, `static.chain-100` and `branch.switch-100` show no change
  beyond round-to-round spread.

### 46. First error at a batch end and in a rollback (F5)

- **Classification:** semantic contract change (F5 added); no new state.
- **Defect:** `drain` already rethrew the first error among siblings, but
  two error meetings outside it let a later error win:
  - a batch body throws A, and the deferred watcher run at the outermost
    batch end throws B. `finally { flush() }` replaced A with B, although W4
    says batching defers watcher execution only;
  - a first run, or a sibling in the drain the `effect()` call opened,
    throws A, and the W5 rollback's cleanup throws B. B reached the caller.
- **Choice:** the first error in causal order defines the failed operation.
  This is drain's existing rule, extended to the two remaining meetings.
  Later errors are dropped, as later sibling errors already were. Their
  watcher is cold (F3) and fails again on its next delivery, so nothing is
  lost that the contract preserves. `SuppressedError` or `AggregateError`
  would make every error observable, which would be a separate obligation;
  nothing in the contract requires it, so it is not added.
- **Repair:** `batch` catches the body's error, still flushes at the
  outermost end, swallows a flush error, and rethrows the body's error. A
  body that succeeds flushes as before. `effect` wraps the rollback `stop`
  the same way. `stop` detaches before it runs the cleanup, so a throwing
  cleanup still leaves no live watcher (W5).
- **Evidence:** the three "F5 first error" tests in `test/semantics.test.ts`
  fail on the baseline (they report "watcher", "watcher" and "cleanup") and
  pass after. The ablations `batch-error-replaces` and
  `rollback-error-replaces` are killed. `construction-commits` was
  re-anchored and is still killed. 178/178 development tests pass, and 171
  production tests pass with seven skipped. With LOG 45, the ESM bundle
  grows from 2,279 to 2,349 B gzip.

### 47. A skipped edge goes to the end of the list (optimization)

- **Classification:** optimization; same answers, no new state. One node
  field is exchanged for another (`lastSub` out, `lastDep` in).
- **Witness:** a read past `next` moved the found edge back to the cursor,
  so `next` stood before every following read. Rotation by one cost 255
  misses per pass on 256 sources (`reorder.rotate-256`); dropping one source
  mid-list cost a miss for every later read (`edit.insert-one-256`, 64 per
  step). Graph mutations grew with the list, not with the edit.
- **From Reflex:** its incoming list keeps its physical tail (`lastIn`) and
  tests it among the locality tiers. Its pass stamp, lockstep, finger and
  tape were not taken: quant's slot index already is the tape, its UNREAD
  sweep is a lazy stamp, and a stamp field would cost a store on every hit.
- **Change:** in `miss`, before the prefix scan: a scan of the last TAIL
  (2) edges of the list, then the forward scan of SCAN (8) edges past
  `next`. A forward match skips `next`: `skipDep` sends it to the end of the
  list and, unless the match was right behind it, moves the match to the
  cursor. Skipped edges reach the end in skip order, so a swap, a reversal
  and a source moved to the front find theirs at the very end; a deletion
  or rotation leaves every later read on the cursor. The prefix scan,
  subscriber lookup, mark and index are unchanged, and a reader list scanned
  completely now links at once. A skipped edge stays inside a marked suffix
  (a failed marked pass can leave one). The tail is `lastDep`; the
  subscriber tail it replaces is the first subscriber's `prevSub`, so a node
  keeps nine fields. That `prevSub` means the last subscriber on `firstSub`
  only: the list is circular backwards, so a backward walk must stop at
  `firstSub` (documented on both fields, and pinned by a ring test through
  head, middle and tail removals).
- **Bound:** misses per pass follow the edit: rotation 1, one dropped
  source 1, a dropped block of k sources k, one source moved later 2, an
  adjacent swap 2 (was 1), reversal one per read, each settled at the end.
  `miss` is 437 B of bytecode, under V8's 460, so it stays inlined into
  reads. (A split into `miss` and `near` kept it small but put a call on
  every absent source: +16 % on `track.link-shared-1`.)
- **Price:** every miss on a source that already has subscribers pays the
  tail's two comparisons, and relations pay `lastDep` upkeep. Four new
  mechanism probes measure it (local, 9 rounds): `track.link-shared-1`
  1.12, `track.replace-all-256` 1.10, `track.link-fanout-256` 1.03,
  `track.new-sources-64` 1.00 of the baseline. A build with a `lastSub`
  field instead of the circular subscriber list measured the same within
  spread, so the price is the dependency tail, not the ring. TAIL was 8 at
  first: 1.26 on `replace-all-256`.
- **Evidence:** six tests in `test/tracking.test.ts` pin the misses per
  edit, one the subscriber ring; five witnesses that used a reversal to
  reach the mark or index path now read the middle source first. Ablations
  `no-defer` and `no-tail-scan` are new and killed; `no-suffix-scan`,
  `no-absence-proof`, `repeat-refresh` and `prepend-subs` were re-anchored
  and are still killed. The site's reorder model (`site/src/scripts/
  reorder.ts`) now follows these tiers read by read (hit, repeat, new, move,
  defer, tail); `validate-reorder.mjs` checks each kind against its kernel
  counter on 4,800 passes, short lists and lists past the scan budget, and
  fails on `no-defer`, `no-tail-scan` and `no-suffix-scan`. Production tests
  pass (179, seven skipped).
- **Timing (CI run 43406089437 for the first form, against main):**
  quant/Reflex on rotate-256 1.17 -> 0.53, insert-one-256 1.09 -> 0.66,
  insert-one at every N 0.96–1.10 -> 0.70–0.76, reverse-8 1.22 -> 1.07.
  Local, final form: rotate 0.45, insert-one 0.65, reverse-8 0.88,
  replace-half 0.87 of the baseline. Not addressed: value-sort (its gap is
  the hit path) and long-reorder (a lookup per read is inherent).

### 48. The host queue is a ring (optimization; S8 kept)

- **Classification:** optimization of the host; same delivery order, same
  semantics. The S8 bound is kept; its witnesses are restated for the ring.
- **Witness:** `push.effects-1000` and `fan-out.effects-1000` were the
  largest gap in the suite: 1.65–2.1x Reflex in CI, 2.2x locally. Every
  wave grew the queue array from KEEP to 1,000 slots (reallocations and
  copies) and the drain cut it back to KEEP at its end, so a steady wave
  paid both on every write; `drain` also tested the compaction condition on
  every take.
- **Change:** the queue is a ring of a power-of-two size: `head`, `mask`,
  `size`. `wake` stores at `(head + size) & mask` and doubles a full ring,
  its watchers moved to the front in order. A take frees its slot at once,
  so deliveries take no storage and no compaction is needed. At rest a ring
  four times larger than the drain's deliveries (which bound the watchers
  queued at once) is cut back to KEEP or to the power of two above twice
  the deliveries, in place (`length` right-trims). A steady wave keeps its
  ring; a burst is given back by the next small drain.
- **Registers:** `depth` and `draining` become one `hold` (open batches,
  plus one while a drain is open): work waits exactly while `hold > 0`, so
  `set` tests `size !== 0 && hold === 0`. A batch inside a drain ends at
  `hold === 1` and leaves the work to the drain, as before.
- **Delivery:** `deliver(w, flags)` clears QUEUED in the store that clears
  WAKE (`run(w)` is `deliver(w, w.flags)`). WOKEN without STALE implies
  DIRTY (`write` sets both, nothing else sets WOKEN), so that path skips
  the reload after the check.
- **Bound (S8):** the ring doubles only when full, so it holds at most
  max(KEEP, 2W) slots for W watchers queued at once, during a drain and at
  rest; the old max(TRIM + W, 2W) is no longer needed. Retention after a
  burst lasts until the next drain with fewer than a quarter as many
  deliveries; the burst witness now says so.
- **Evidence:** production tests 172 passed, seven skipped. The S8
  witnesses were restated for the ring. `no-queue-compact` is retired with
  the compaction; `no-queue-trim` becomes `no-queue-shrink` and is killed;
  `start-outside-drain`, `run-direct`, `batch-error-replaces`,
  `rollback-error-replaces` and `no-retry` were re-anchored where needed
  and are killed. Bench checksums are equal on every suite and cost probe.
  ESM bundle 2,349 -> 2,468 B gzip on its own; 2,601 B with LOG 47.
- **Timing (local only, Node 25, 7 rounds, not evidence):**
  push.effects-1000 0.51 of the baseline (2.2x -> 1.14x Reflex),
  fan-out.effects-1000 0.51 (2.14x -> 1.09x), write.same-value 0.43; every
  other mechanism and graph scenario within round-to-round spread.

### 49. Absence from the source's side; the first relation and repeats in `read` (optimization)

- **Classification:** optimization; same answers, no new state or field.
- **Witnesses (CI run 43417637122, quant/Reflex):**
  `track.replace-all-256` 1.67 (a computed alternating between two sets of
  256 sources, each with one other reader), `track.duplicate-64` 1.55,
  `lifecycle.computed-create` 1.25. On `replace-all-256` every read was
  absent, yet paid the tail, forward and prefix scans and a subscriber
  lookup (about 20 comparisons) before the link; Reflex answers from the
  producer in O(1) (its sole outgoing edge goes to another consumer).
- **Change:**
  - `miss` proves a source absent from its own side before any scan: no
    subscribers (LOG 22), or its first and last subscribers, which the
    ring gives one load apart (LOG 47), are all it has and neither is the
    reader (`alien`). Taken from Reflex's producer-side probes.
  - `read` settles two more reads itself, as Reflex's resolver does: the
    cursor's own source again (a repeat, P5) and the first read of an
    empty list (links at once). The repeat check left `miss`, where it was
    now dead.
  - The forward and prefix scans move back out of `miss` into `near`; the
    tail scan stays in `miss`, so a reversal, a swap's second read and a
    source moved to the front pay no call (with it in `near` too, reverse
    at N = 64..1024 lost 10 %). `read` 146, `miss` 247, `near` 220 B of
    bytecode, well under V8's 460 (the single `miss` of LOG 47 was 437 B,
    and the suspect for `value-sort.256x32` going 1.10 -> 1.43 in CI,
    bimodal across rounds and not reproduced locally on Node 22 or 25).
- **Evidence:** the absence structure test now gives half its sources two
  other readers and requires no subscriber lookup and no sweep; the new
  ablation `no-source-absence` fails it. `no-fresh-source`,
  `no-repeat-check` and `repeat-refresh` were re-anchored and are killed.
  The first-relation tier saves calls, not structural work, so only timing
  sees it and it has no ablation. The site's reorder model needed no change
  (4,800 passes match per read kind). Production tests 179 passed, seven
  skipped; bench checksums equal. ESM bundle 2,601 -> 2,650 B gzip.
- **Timing:** CI run 43446903020 (with the tail scan in `near`) against
  main's 43417637122, quant/Reflex: replace-all-256 1.67 -> 0.88,
  value-sort 1.43 -> 1.09, duplicate-64 1.55 -> 1.36, computed-create
  1.25 -> 1.14, link-fanout-256 0.87 -> 0.91; shuffle@4096 1.26 -> 1.46 on
  the same CPU model, not reproduced locally (0.98 on Node 22). Final form,
  local Node 22, 9 rounds against main: replace-all 0.52, computed-create
  0.91, insert-one-256 0.88, reverse-8 1.00, reverse@1024 1.05, value-sort
  1.01, link-fanout-256 1.13 (an absent source with more than two
  subscribers: the source check proves nothing and the scans cost a call). Left: duplicate-64 stays about 1 ns per
  repeat behind Reflex, whose signal read skips the pull test and whose
  cursor is a consumer field (LOG 30 and LOG 43 chose otherwise);
  computed-create about 15 % behind on Node 22, all of it in the first read
  and link (a first run without reads is level).

### 50. Two costs that grew with load: swaps and the ring's give-back (optimization)

- **Classification:** optimization; same answers. One edge marker
  (`SKIPPED`, an edge version value like UNREAD) and two host registers.
- **Witnesses** (`research/TRADEOFFS.md`, `bench/tradeoffs.mjs`): of the
  costs LOG 47–49 accepted, two grew with load. `swaps@k` (k adjacent swaps
  per pass in 1,024 sources) went 1.08 -> 1.61 of the pre-LOG 47 kernel as k
  grew to 256: every swap was two misses, the first paying the failed tail
  scan, the call to `near` and the deferral. `burst-waves@W` (a wave of W
  effects, then four of one) paid 1.18–1.47 against a ring that keeps its
  size, growing with W: every small drain gave the ring back (LOG 48) and
  every burst grew it again, copying.
- **Change (tracking):** a read that finds its edge past `next` skips it
  (`skip`). The first time, the found edge moves to the cursor and `next`
  is marked SKIPPED: it is most likely read next (a swap, an earlier move),
  as before LOG 47. Only a marked edge skipped again goes to the end of the
  list (a rotation, a deletion, a later move). The one-past-`next` test
  moves into `miss`, before the tail scan, so a swap's single miss pays
  neither. SKIPPED, like UNREAD, stands only where the old version is never
  read: a read overwrites it, success cuts what is left unread, failure
  leaves the node DIRTY; a marking or indexing pass overwrites it with
  UNREAD.
- **Change (host):** a drain whose deliveries fill less than a quarter of
  the ring is small; the ring is given back once the small drains since the
  last large one have delivered as many watchers as it holds (`spare`),
  to KEEP or the power of two above twice the largest of them (`calm`).
  Growing back costs O(ring), so give-back plus regrowth is O(1) per
  delivery; bursts between small drains keep the ring, and a burst
  followed by small drains is still given back. S8 is unchanged:
  max(KEEP, 2W).
- **Bound:** misses per pass, now: adjacent swap 1 (was 2), move earlier 1
  (2), move later 3 (2), rotation and one deletion 2 (1), a deleted block of
  k 2k (k), reversal one per read. All still follow the edit, not the list.
  Nested skips read back oldest first mark the pass from k = 6, where LOG 47
  did from k = 3 and the pre-LOG 47 kernel from k = 9: one sweep per pass,
  bounded.
- **Evidence:** the edit-bound tests take the new counts and a move earlier
  by 6; the S8 witness now alternates bursts with small drains (the ring
  must stay) and then counts the small drains until it is given back (a
  ring's worth). Ablations `no-skip-marker` (LOG 47's rule) and
  `queue-shrink-eager` (LOG 48's rule) are new and killed; `no-defer`,
  `no-suffix-scan` and `no-queue-shrink` were re-anchored and are killed.
  The site's reorder model gains the `skip` kind and matches the kernel on
  4,800 passes per read kind. Production tests 180 passed, seven skipped;
  checksums equal on every suite.
- **Timing (local, Node 22, against the pre-LOG 47 kernel; not evidence):**
  swaps@1..256 0.97–1.04 (LOG 49: 1.08–1.61); burst-waves@1024..16384
  0.41–0.56 (LOG 49: 0.54–0.67; Reflex 0.42–0.56); swaps-nested@3 1.06
  (1.24). Kept: rotate-256 0.42, insert-one-256 0.64, reverse-8 0.88,
  replace-all-256 0.59, replace-half 0.87, push.effects-1000 0.49,
  computed-create 0.92; the rest within spread.

## Representation and edge removal note

Reactive kernel: nodes, edges, tracking, push, pull, failure.

A node is a signal (fn === null), a computed, or a watcher (WATCH). An edge
is one relation in two doubly linked lists: `to.deps` in the order `to`
last read its sources (prev/next) and `from.subs` in birth order
(prevSub/nextSub). Change is a version fact: a node bumps `ver` when its
value changes; an edge keeps the `ver` its reader saw.

Removal invariant: an edge taken out of a list must not keep a pointer into
either list, because garbage that points at live or younger edges is kept
alive by the scavenger once it is old (an old dead edge pins newer ones, and
through `to` their watchers and closures, until a major GC). Removal is
therefore two steps: unlink the neighbours, then clear the edge's own
links. `unsub` clears prevSub/nextSub; `cut` clears the head's `prev`, and
`fail` clears `prev`/`next`. In `cut` the interior of a removed run keeps
its `next` chain, which only reaches other garbage of the same cut and
is read by `unsub` while the run is walked. Any new removal path must
do the same.

The dependency cursor lives only in execution context, never in a node.
`exec` restores the enclosing cursor on success and failure before pruning
the completed pass. Its local final edge remains available until displaced
slot cells have been restored (LOG 43, superseding LOG 39's node-field reset).

Written for V8: one node shape and one edge shape, each built at a single
site; numeric fields are SMI counters (masked); conditions are explicit
comparisons, so no ToBoolean runs on mixed values; the graph walks avoid recursion and allocation per stable read.

## Local Collections prototype (2026-11-14)

- **Classification:** separate collection-layer semantic/structural machine,
  not an addition to Quant's frozen mechanism basis. Its own
  [contract](collections/CONTRACT.md) defines I1-I8 before measurement.
- **Witnesses:** owned immutable rows, exact shared indexes, coherent publication,
  rollback on late maintenance failure, one-row predicate locality, and a Quant
  graph independent of row count. Generated mutation sequences are checked
  against full recomputation. Joins and query parameters remain deferred.
- **Representation:** sparse transactional writes over Maps; pure old/new row
  projections avoid persistent per-row key/sum caches. Group counts reuse bucket
  sizes. Only operator construction allocates two Quant scalar nodes.
- **Local evidence:** 17 prototype tests pass in development and production;
  type checking passes. At N=10 and 1,000 a group-changing patch has predicate=1,
  key projections=3, bigint projections=2, index probes=6, store reads=21,
  staged writes=7. There are 11 actual Quant node creations including an explicit
  effect, with no new nodes on mutation. No timing claim is made.
- **CI:** the isolated `experiment/local-collections` branch runs both frozen
  core contracts and this prototype, then checks the same work counters at
  N=1,000 / 10,000 / 100,000 / 1,000,000. Run 43626132260 passed all three jobs:
  17 collection tests in both modes, core 187 development / 180 production
  (seven skipped), and identical work counters through one million rows. See
  [results](collections/RESULTS.md). The production runtime and its contract
  are unchanged.
