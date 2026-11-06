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
