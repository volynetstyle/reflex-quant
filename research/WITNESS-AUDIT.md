# Witness audit: what the 24 ablations actually prove

`mutants.json` records Level 1 ablations: *this implementation, with this
detail removed in this way, fails a test.* That is weaker than "the detail is
necessary". It does not separate a theorem from a policy, a convention, or a
lemma that only the chosen construction needs. This audit classifies each
witness by what its failing test actually establishes, and merges ablations
that witness the same obligation.

Classes: **semantic** (observable result, error or dependency set is wrong
otherwise); **safety** (execution is lost, the graph breaks, or the stack dies);
**asymptotic** (a declared work/allocation bound breaks); **optimization**
(same semantics, more structural work); **policy** (chosen public lifecycle or
host behavior); **convention** (deterministic choice the contract leaves open);
**lemma** (needed only by Quant's chosen construction).

## Per-ablation classification

| Ablation | Class | What the failing test proves | Obligation (cluster) |
| --- | --- | --- | --- |
| direct-dirty-running | semantic | a write to a not-yet-read source during a run adds no rerun | A |
| woken-when-running | semantic | same test as above | A |
| clear-after | semantic | a push during a run survives; self-invalidation converges | B |
| validation-stale | semantic | a failed validation is re-delivered when its cause changes | C |
| retry-as-stale | semantic | same test as above | C |
| no-retry | semantic | recovery language: a failed validation stays recoverable | C |
| idle-after-failure | semantic | a failed watcher keeps its execution obligation (F4) | D |
| existential-watcher | semantic | watcher validation covers the whole committed set (P4, D1) | E |
| validate-tentative | semantic | last-attempt reads are not committed validation deps | F |
| keep-tentative | semantic | earlier failed attempts do not accumulate wake evidence | F |
| cut-on-failure | semantic | committed deps survive a failure (wake set) | F |
| no-repeat-check | lemma (T2) | an immediate repeat must not create a second relation | G |
| no-unread | lemma (T2, S3) | accepted vs. still-reusable edge must be told apart while indexing | G |
| no-displaced | lemma (T3) | a nested pass must not clobber the outer pass's index | G |
| eager-dispose | policy | reads after self-dispose leave no ghost relation, under the current rule that disposal takes effect at the end of the callback | H |
| no-cycle-check | safety | a cyclic read throws instead of overflowing the stack | I |
| run-direct | policy (host) | effects created inside a batch or another run execute after it | J |
| start-outside-drain | policy (host) | same test as above | J |
| no-direct-dirty | optimization | no validation walk on a direct write | – |
| no-woken | optimization | no vacuous validation for a signal-woken watcher | – |
| no-suffix-scan | optimization | rotation and adjacent swaps resolved without indexing | – |
| no-absence-proof | optimization | few-subscriber absence proved without indexing | – |
| no-fresh-source | optimization | no failed scan for a source with no subscribers; timing only (LOG 22) | – |
| prepend-subs | convention | only tests that assert the run order of sibling effects fail | – |

`prepend-subs` was checked further by removing `lastSub` entirely and the
`checkGraph` assertion on it: 46 of 48 tests pass, including every differential
test against the contract spec; the two failures assert sibling effect order.

## Merged obligations

| Cluster | Obligation | Ablations witnessing it | Quant's realization |
| --- | --- | --- | --- |
| A | a write during a run to a source not yet read adds no rerun | 2 | BUSY + STALE + version comparison |
| B | self-invalidation during a run is delivered again | 1 | flags cleared before the run |
| C | a failed validation stays recoverable and is re-delivered | 3 | DIRTY / RETRY / STALE rules |
| D | an execution obligation survives a failure | 1 | DIRTY kept on failure |
| E | watcher validation covers every committed source | 1 | `check` |
| F | committed and last-attempt dependencies are exactly distinguished | 3 | `node.gen` + `edge.gen` |
| G | exact tracking: pair uniqueness, nesting isolation, bounded work | 3 | one-slot index: UNREAD, displaced cells, repeat check |
| H | disposal inside the node's own pass leaves no relation | 1 | deferral to the end of the run |
| I | cycles do not overflow the stack | 1 | BUSY check on read |
| J | effect execution enters through one non-reentrant drain | 2 | drain flag + queue |

Ten obligations, not 18. Of those, A–F are semantic; G is asymptotic and
uniqueness, realized by three lemmas; H and J are policy; I is a safety
contract. Five ablations are optimizations (4 killed only by structural tests,
1 by timing), and one is a convention.

## What this changes in the claims

- "Every remaining mechanism has a counterexample" holds for the architecture
  as built, not as necessity. Cluster rows list the *realization*; none is a
  lower bound.
- `UNREAD`, displaced cells, the repeat check, `edge.gen` and `RETRY` are
  properties of this construction (the one-slot index, the generation
  certificate, the DIRTY/RETRY/STALE encoding). Another construction meeting the
  same obligations may have none of them.
- Deferred disposal (H) and the cycle check (I) are consequences of chosen
  public behavior. A contract that forbade self-dispose, made reads after it
  untracked, or left cycles undefined would not need them.

## Level 2

Level 2 asks: *does removing the obligation make every implementation of the
rest of the contract impossible?* Each experiment needs a replacement design,
not a deletion. A pass shows the removed detail is a lemma of this
construction, not a forced mechanism.

### C: `RETRY` is replaceable (applied, LOG 25)

`RETRY` marks "validation owed although the kernel does not consider the
watcher STALE". It exists because the kernel's wake guard
(`(f & (STALE | WOKEN)) === 0` in `write` and `mark`) would otherwise treat a
failed watcher that kept STALE as already handed to the host, and a later
push would not re-deliver it (`validation-stale`).

Replacement: the host already deduplicates with `QUEUED`, so the kernel guard
is a second copy of the same fact.

- host: delete `RETRY`; after a failed `check`, set `STALE` again instead of
  `RETRY`; `run` tests `STALE | WOKEN`;
- kernel `write`: a direct watcher subscriber calls `wake` unconditionally;
- kernel `mark`: a watcher is marked STALE and `wake` is called unconditionally;
  the early-out stays for computeds.

Result: `tsc` clean, 48 of 48 tests pass, including the differential tests
against the contract spec (bounded, recovery and generated languages). So
`RETRY` is an implementation lemma, not a forced mechanism: the recovery
obligation only needs one bit of "validation owed", and `STALE` can carry it.

Cost: `write` and `mark` now call `wake` for a watcher that is
already queued (the call returns at the `QUEUED` check). That is a hot-path
call the current design avoids, and the kernel comment "a STALE node has STALE
subscribers, or is a watcher the host has" stops being true. Whether the saved
host bit is worth that call needs CI timing; local screening is below.

### C: local timing of the `RETRY` replacement

Local A/B (the repo says timing counts only on CI; this is a screen, not a
result). Same worker, interleaved random order, median of 5 rounds, B/A
against the committed kernel; an A-vs-A run gives the noise floor, roughly
±5 % with ranges up to 0.86–1.15.

| scenario | B/A |
| --- | --- |
| static.read-clean | 1.00 |
| stable.wide-8 | 1.03 |
| diamond.8x8 | 1.03 |
| fan-in.1024 | 1.00 |
| fan-out.effects-1000 | 0.93 |
| fan-out.computeds-1000 | 1.02 |
| batch.writes-32 | 1.00 |
| lifecycle.mount-100 | 0.83 (range 0.76–1.07; noise) |

Nothing outside the noise floor on the scenarios where the extra `wake` call
is most likely to show. CI timing is still required before adoption.

### `start()` is replaceable by `wake(w); flush()` (done; reverted)

`host.start` is a hand-specialized `wake + flush` that skips the queue slot
(mutants `run-direct`, `start-outside-drain` kill other edits). Replacing its
body with `wake(w); flush();` gives `tsc` clean and 48 of 48 tests, including
the differential suites and the error-rethrow behavior. So the specialization
is an optimization, not a mechanism. Its measured value is small and
unresolved locally: `lifecycle.mount-100` is 1.08 (7 rounds) and 1.17
(13 rounds, range 0.90–1.29) slower without it, against an A-vs-A control of
1.07 (range 0.84–1.21). LOG 24 had already measured `start` as the repair of
a CI miss (39.8 → 32.4 ns per sourceless effect), so it stays. The experiment is
trivial to redo: the body of `start` becomes `wake(w); flush();`.

### G: `UNREAD` (analysis, not run)

The obligation is that, during an indexed pass, an edge already accepted by
this pass is told apart from one still free to reuse. That is one bit of
information per relation per pass. `UNREAD` stores it as a sentinel in
`edge.ver`, so it costs no field. A replacement must put the bit somewhere
else: a new field (more memory), or the source's slot (which is already
displaced and restored by nested passes), or edge position (no O(1) test of
"before the cursor"). No cheaper encoding was found, so this one is plausibly
a per-relation lower bound under the one-slot index; this is an argument, not
a proof, and no replacement was built.

### H: deferred disposal (analysis, not run)

Replacing deferral with immediate detach plus "reads after self-dispose are
ignored" needs the check somewhere. In `read` it is a hot-path branch; in
`miss` it is cold, but `dispose` inside an indexed pass must also unwind the
slots, which `unindex` does through `n.deps` and the eager detach has just
cleared. That is two cases instead of one deferral point. Deferral looks
cheaper, but this is analysis only.

### F: `gen` (analysis, not run)

Commit of a successful run must make the tentative edges committed in O(1).
`node.gen` is an epoch that does it with no per-edge writes. A per-edge flag
needs an O(d) clearing walk on every success; a positional certificate fails
because tentative edges can sit before committed ones (links happen at the
cursor). No cheaper certificate was found. Same status as G.

### Similar changes searched

Looked for a guard that restates a fact another layer already keeps:

- kernel wake guard vs. host `QUEUED`: found, removed above (RETRY).
- `start` vs. `wake + flush`: found, above.
- `WOKEN`: a separate bit, but it skips a validation that is not vacuous after
  a failure; after the `RETRY` replacement it still carries information
  (signal-only wake). No duplicate found.
- `fail` vs. `cut`: both unlink edges, but `fail` removes only tentative edges
  from anywhere in the suffix; not a duplicate.

### Not done

- Building replacements for G, H, F.
- CI timing for the `RETRY` and `start` variants.
