# Read tracking

How a tracking pass turns the reads of a computation into the consumer's
incoming edge list. The full description, with invariants and their proofs,
the lookup bound, prior art, measurements and the slot decision, is in
[RESEARCH.md](./RESEARCH.md). This file is the working summary.

## Model

The cursor `consumer.tailIn` splits the incoming list into the prefix
accepted in this pass and the suffix of older dependencies. A read off the
sequential path is resolved in three steps:

1. **Locate** the edge of `(P, C)`, in three levels:
   - **L0, consumer-side locality** (`resolve.ts`): the cursor, its next
     edges and the physical tail of `C.in`.
   - **L1, producer-side probes** (`locate.ts`, then `findEdgeInLockstep`):
     an empty `P.out`, its newest edge, a sole edge to another consumer,
     the outgoing hint, `tailIn` of the idle producer when it is an edge of
     exactly this pair (INV-H).
   - **L2, lockstep**: bounded by the shorter of `P.out` and `C.in`, past a
     two-link head start at `firstOut`. With another hint in the slot (an
     outgoing finger), its
     first 16 steps alternate the outgoing link between the walk from the
     head and up to 8 links of `P.out` around the finger, read as a ring;
     the incoming walkers advance on every step. Its result refreshes the
     hint.
   - **Prepared tape** (INV-P, `../../shape/graph/tape.ts`): repeated costly
     lookups can prepare one consumer's incoming list. Its cells can answer a
     pair lookup, and a covered live lease can certify that a producer has no
     edge to the owner. Otherwise the lookup continues its exact search.
2. **Classify** it: in the prefix exactly when it carries the cursor's
   nonzero stamp (INV-T3), or always when the cursor is `lastIn` (INV-T2):
   `isEdgeInTrackedPrefix`.
3. **Reconcile**: duplicate, move the suffix edge after the cursor (to the
   head while the prefix is empty), or link a new edge there:
   `reconcileLocatedRead`, which never searches again. The locality tiers
   and the located edge share the same two moves
   (`../../shape/graph/cursorMoves.ts`).

`edge.stamp` is a pass-membership stamp, not a value version.

`resolveTrackedRead` handles sequential reads directly. On a miss,
`reconcileLocatedRead` commits a located suffix edge or a new link after the
duplicate check; a configured strategy is called at that same boundary. The
default strategy (`../../shape/graph/reuseEdge.ts`) is never called by the
resolver; it serves benchmarks and tools with positions of their own.

`tailIn` is one slot with two lifetime-disjoint readings (INV-H,
`../../shape/graph/hint.ts`): while the node is Computing, its tracking frontier;
otherwise null, the residual incoming edge, or a hint, one attached outgoing
edge (`from === node && to !== node`, so never a self-edge). The hint costs
no memory and closes the repeated pair: a broad producer re-read inside a
wide consumer (`items.map((i) => f(i, theme()))`) pays one lockstep per pass
instead of one per read. Another hint is an outgoing finger. `P.out` is
append-only, so it lists the consumers in the order they linked the
producer; consumers that re-run in that order meet their edge one or two
steps from the previous consumer's, however each orders its own reads
(dense shuffles of many wide consumers, `../../../../perf/outgoing-finger`).
The finger only races the lockstep and never stops it: a miss postpones
nothing the lockstep proves by more than its budget. A hint does not prove
absence, and when consumers re-run in an order unrelated to `P.out` the
finger does not help; both cases stay at the lockstep bound.

## Code map

| File                                                | Role                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `resolve.ts`                                        | hot path (next edge, cursor, first read) and the initial, tail and inner misses |
| `locate.ts`                                         | producer-side probes, then the graph lookup; the reorder path keeps only newest |
| `prefix.ts`                                         | prefix classification, shared with `push_iterator.ts`                           |
| `cleanup.ts`                                        | removal of the unvisited suffix after a pass (computed: also a failed one)      |
| `read.ts`                                           | `trackRead`, an entry for tests and tools                                       |
| [`../../shape/graph/`](../../shape/graph/README.md) | exact lookup and graph mutations used by tracking                               |

Rules to keep when changing this code:

- **The unvisited suffix survives until cleanup.** Reconciliation moves or
  links, never unlinks; `cleanupUnvisitedSources` alone removes what a
  successful pass, or a failed pass of a computed node, did not read. A failed
  computed is Changed, so its incoming edges wake nothing; keeping its suffix
  would accumulate the reads of every failed retry. A failed watcher keeps
  its suffix as a retry set. During the pass suffix edges are attached but
  carry no causal authority (`Computing` plus prefix membership). Which edges
  survive decides edge identity and subscriber order: representation, not
  semantics (SEMANTIC_CONTRACT, "Semantic and representation equivalence").
  The 32-edge eager detachment removed on 2026-10-25 is kept as the
  `eager-detach` counterfactual in `perf/tracking-ladder/variants.mjs`.
- **A configured `readTrackingStrategy` pays two lookups per call.** The
  resolver must locate the edge to reject duplicates before the call. This is
  the cost of the extension point; skipping the resolver lookup would hand
  duplicates to the strategy.
- **A hint never outlives its edge, and never sits in a frontier.** Every
  unlink path clears it (`unlinkEdge`, `unlinkDetachedIncomingEdgeSequence`,
  `unlinkAllSubscribers`), every computation resets `tailIn` to null before
  its first read, and the lookup writes one only into a node that is neither
  Computing nor a watcher. A new edge-removal path must clear it too; the
  oracle's tail invariant and the `hint-keep-on-unlink` mutant check this.

## JIT

Keep each tier's code where its frequency is. TurboFan charges a caller for a
callee's bytecode plus everything already inlined into the callee's optimized
code, against a fixed budget per compilation. A cold tier merged into a hot
function is inlined wherever the function is, and can push the hot read path
(`resolveTrackedRead`) out of `runWatcherCore`, `advanceCore` or
`executeComputation`. For that reason the tail miss and the inner miss are
separate functions: a call site inlines only the miss kind that occurs there.
For the same reason a miss handler takes only the cursor and re-reads the
stamp and the expected next edge from it, the three locality tiers of the
inner miss share one move call, and the tracking link and move helpers have
no parameter defaults: every argument move and default branch is bytecode
each inlining caller pays for.
The lookup loops are plain loops, not unrolled. Its two-link outgoing head
start is a workload heuristic, not an invariant. The hint is consulted before
it and written only past it, so a lookup that bounded fan-out settles reads
`tailIn` once and never writes it. Past the head start there are two loops,
the lockstep proper (`findEdgeInLockstepPastHeadStart`) and the lockstep raced
by the finger (`findEdgeInLockstepFromFinger`, `OUTGOING_FINGER_BUDGET`), so
a call site that never meets a finger inlines only the first. Equivalent
shapes of both (unrolled, split, switch) were measured on 2026-10-27 and
changed nothing beyond noise: the loops are memory-bound (RESEARCH.md §9.5;
the shapes are on the research branch `perf/tracking-lookup-shapes`).

## Measuring

`scripts/compare-tracking-graph.mjs` snapshots the compiled internal
entrypoint with production flags and tree shaking, and alternates independent
Node processes for baseline and candidate (10,000 warmup passes, 20,000
measured passes, nine samples per variant). Each pass takes a fresh stamp from
the clock as a real pass does. Run from the repository root, saving the
baseline before editing the runtime:

```sh
pnpm --filter @volynets/reflex-runtime build:ts
node scripts/compare-tracking-graph.mjs --save baseline
# Apply the runtime changes, then rebuild.
pnpm --filter @volynets/reflex-runtime build:ts
node scripts/compare-tracking-graph.mjs --save candidate
node scripts/compare-tracking-graph.mjs baseline candidate
```

Results go to the ignored `temp/tracking-graph/` folder. `TRACKING_ONLY=<regex>`
selects scenarios; `TRACKING_ITERATIONS` and `TRACKING_WARMUP` shorten the
heavy wide × wide ones. Interpret timings alongside the unchanged
stable-tracking and generic-move controls.

`perf/tracking-pair-lookup/analyze.mjs` reports, per read that reaches the
lookup, `D = min(out(P), in(C))`, links compared and simulated slot hit rates
(PROFILE build; link counts, not timings). `perf/outgoing-finger/analyze.mjs`
replays every lookup with a model of the code and fails on any difference in
compared links; it also reports routes and runs the end-to-end lab mirror
(`scripts/tracking-lab-long-long.mjs`). `perf/tracking-ladder/analyze.mjs`
models the earlier four-link head start and needs updating before use. The
research branch `perf/tracking-lookup-shapes` adds reconciliation counters,
links by route, the window-slide pattern and `--touch`, the distinct and cold
edges and nodes each read touches.

Exactness is checked separately from timing. `scripts/fuzz-tracking-graph.mjs
--baseline <commit>` runs seeded scripts of passes, nested passes, unlinks and
disposals on production bundles of that commit and of the working tree,
compares every frontier and the whole graph (edge identity, stamps) after
every operation, and checks INV-H; `--qualify` requires every seeded mutant
of the hint, of the finger race and of the locate stage to be caught.

The repeated-pair case has its own scenarios, `hub-duplicates-16` and
`hub-duplicates-256` in `compare-tracking-graph.mjs`, and a permanent
workload in the paired benchmark suite, `A.track.hub-duplicate`.
