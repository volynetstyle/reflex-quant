# Reflex Dependency Tracking: Representation, Temporal Semantics, and Exact Pair Reconciliation

**Research note · first edition 24 October 2026 (PR #52) · revised 27 October 2026**
**Implementation described:** `dev` after PR #68 (outgoing finger) and PR #69 (preserve the unvisited suffix), with the tracking/graph cleanup that follows them. Links are relative to this file.
**Status:** a description of this implementation and of the evidence behind it, not a language-level specification. [`README.md`](./README.md) is the working summary; this note gives the invariants, the proofs, the cost model, the history of the design and what remains open.

## Abstract

Reflex tracks dependencies as **identity-bearing edges in a bidirectional intrusive graph**. Each edge `(P, C)` is one object linked into two lists at once: the producer's outgoing list `P.out`, its subscribers, and the consumer's incoming list `C.in`, its dependencies. A computation's reads rebuild `C.in` in first-read order while **reusing** the existing edge of every pair whose edge still exists. Reuse keeps the edge's place in `P.out`, and `P.out` is append-only, so subscriber order is the order in which pairs were first linked.

The resolver separates three problems:

1. **locate** the unique edge of `(P, C)` or prove there is none;
2. **classify** it as already accepted in this pass or not, with a pass-membership stamp;
3. **reconcile** the incoming list: move the edge after the cursor, or link a new one.

Stable sequential reads never search. A read off the sequence first tries constant-time locality on the consumer side, then on the producer side: its newest edge, its hint (the edge of its last expensive lookup) and a two-link head start. Only then comes the general search, a **lockstep** over both lists, bounded by the shorter one and the only general proof of absence. When the producer's hint belongs to another consumer it serves as an **outgoing finger**: for a bounded number of steps the lockstep's outgoing link alternates between the walk from the head and the ring around the finger, because consumers that re-run in their original order find their edge next to the previous consumer's. No index, no per-edge field and no per-pass preparation is involved.

Reconciliation never unlinks. The unvisited suffix of the incoming list keeps its edges until the pass ends successfully, and then `cleanupUnvisitedSources` removes what the pass did not read. Which edges survive decides identity and sibling order. The contract treats that as representation, not semantics.

Two warnings for readers. **`edge.stamp` records membership in a tracking pass. It is not a producer value version and not evidence that a value is fresh.** And every fast path in this subsystem is held to one rule, made explicit by the outgoing-finger work: **a fast path needs a cheap hit and a cheap miss, and its miss must not stall the general proof.**

## 1. What subsystem is being described?

This note describes **read-side dependency tracking**, not the whole reactive protocol:

1. **Tracking** observes reads while a computation or watcher runs and maintains the dependency relation.
2. **Invalidation (push)** propagates evidence that downstream work may be required.
3. **Validation (pull)** decides whether a dirty derived node really needs recomputation, with equality cutoffs.
4. **Scheduling** decides when host-owned watchers execute. The resolver is not a scheduler.

They interact, but their state must not be collapsed into one informal meaning of "version". See [`INVARIANTS.md`](../../../../docs/INVARIANTS.md).

### Vocabulary

| Term                            | Meaning in Reflex                                                                             | What it does **not** mean                          |
| ------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `P`, producer                   | Node whose value is read                                                                      | The computation that is running                    |
| `C`, consumer                   | Node collecting reads                                                                         | Necessarily an effect; it may be a computed node   |
| `(P, C)`                        | Directed dependency relation, one edge object                                                 | A pair of read sites                               |
| `C.firstIn … C.lastIn`          | Doubly linked list of dependencies                                                            | Only the reads accepted so far                     |
| `C.tailIn`                      | While C computes: the cursor, end of the accepted prefix                                      | Always the physical tail; outside a pass see INV-H |
| `P.firstOut … P.lastOut`        | Doubly linked list of subscribers, append-only, in link order                                 | An unordered set                                   |
| `edge.stamp`                    | Stamp of the last tracking pass that **accepted** the edge                                    | A value revision, a freshness proof, an edit count |
| `trackingStamp`                 | Forward-only clock supplying pass stamps                                                      | A per-producer change counter                      |
| hint, finger                    | Outgoing edge held in an idle producer's `tailIn` (INV-H); a finger is a hint of another pair | An index; any claim about absence                  |
| `Unknown`, `Changed`, `Visited` | Execution and invalidation obligations                                                        | Other spellings of the stamp                       |

The stamp field was called `version` and the clock `trackingEpoch` until 24 October 2026.

## 2. Representation and contract

For every live edge `e = (P, C)` the **same object** sits in both lists:

```text
P.out:  ... <-> e <-> ...    (subscribers of P, in link order)
                  |
                  | e.from = P, e.to = C
                  |
C.in:   ... <-> e <-> ...    (dependencies of C, in first-read order)
```

Two structural facts carry the whole design.

- **`P.out` is append-only.** A new edge is linked at `P.lastOut` ([`linkEdge.ts`](../../shape/graph/linkEdge.ts)); reconciliation moves edges only within `C.in` ([`cursorMoves.ts`](../../shape/graph/cursorMoves.ts), [`reuseEdge.ts`](../../shape/graph/reuseEdge.ts)); only unlinking removes an edge from `P.out`. So `P.out` lists the consumers of `P` in the order their edges were created, which is the order in which they ran when they first read `P`. §5.3 builds on this.
- **Identity decides order.** Moving an existing edge inside `C.in` keeps its place in `P.out`; unlinking and later relinking a pair moves the subscriber to the end of `P.out`. Values and dependency sets can agree while subscriber order, and therefore sibling notification and validation order, differs.

The contract fixes values, dependency sets and the obligations of push and pull; it does not fix sibling invalidation or delivery order, adjacency order or edge identity ([`SEMANTIC_CONTRACT.md`](../../../../test/differential/docs/SEMANTIC_CONTRACT.md), "Semantic and representation equivalence"). The differential oracle classifies trace differences accordingly: identical, list-order, event-order (representation) or semantic.

## 3. What a tracking pass does

At the start of a computation `C.tailIn` is reset to `null`; the old incoming list stays. `enterConsumerTracking(C)` ([`state.ts`](../../state.ts)) installs the active consumer and advances `trackingStamp`. The first read of the pass takes the then-current clock value as its stamp `S`, which can be later than the value at entry if nested computations ran before it; every later read takes the cursor's stamp. Nested computations may advance the clock mid-pass without affecting `S`.

During the pass the incoming list has two parts:

```text
C.firstIn        C.tailIn          C.lastIn
    |                |                 |
    +---- PREFIX ----+----- SUFFIX ----+
      accepted in S     earlier dependencies, not read yet
```

Each read of `P` asks one question, **where is the unique edge of `(P, C)`?**, and acts on the answer:

| Lookup result      | Classification              | Action                                                      |
| ------------------ | --------------------------- | ----------------------------------------------------------- |
| edge in the prefix | duplicate read              | nothing; the cursor stays                                   |
| edge in the suffix | known dependency, new place | move the **same** edge right after the cursor, stamp it `S` |
| no edge            | new dependency              | link a new edge after the cursor, stamp it `S`              |

After a **successful** pass, `cleanupUnvisitedSources` ([`cleanup.ts`](./cleanup.ts)) unlinks the suffix: the dependencies this pass did not read. This is the only place where tracking removes edges. A pass that throws keeps its moves, links and stamps. A computed node's failed pass then cleans up too: the node becomes `Changed`, push skips a `Changed` subscriber and its next read recomputes without validation, so its incoming edges are only reconciliation material, and a kept suffix would grow into the union of every failed retry's reads until the first success. A watcher's failed pass skips cleanup: the watcher returns to idle and its dependency set stays a conservative retry set ([`watcher.ts`](../../engine/watcher.ts)). Either way a retry takes a new stamp and reconciles against that graph.

### Worked trace

Previous `C.in` is `[a, b, c, d]` (pairs named by producer); the successful pass reads `[b, b, d, a, x]`:

```text
initial             [a b c d]          prefix = []
read b              [b | a c d]        move b; stamp S
read b again        [b | a c d]        duplicate; nothing moves
read d              [b d | a c]        move d; stamp S
read a              [b d a | c]        next-edge hit; stamp S
read new x          [b d a x | c]      link x; stamp S
successful cleanup  [b d a x]          unlink c
```

`a`, `b` and `d` keep their places in their producers' outgoing lists; `x` is appended to its producer's; `c` is unlinked.

## 4. Invariants: a temporal certificate, not a value revision

**INV-T1 — Prefix.** While C computes and `tailIn !== null`, `firstIn … tailIn` is the accepted prefix and `tailIn` is in `C.in`.

**INV-T2 — Completed prefix.** If `tailIn === lastIn`, the suffix is empty and every incoming edge is in the prefix, whatever its stamp. Watcher validation uses this: [`pull_frontier.ts`](../stabilization/pull_frontier.ts) sets `tailIn = lastIn` to cover its committed list without tracking.

**INV-T3 — Stamp classification.** With `S = tailIn.stamp ≠ 0` and a nonempty suffix, for an edge `e` of `C.in`:

```text
e ∈ prefix(C)   ⇔   e.stamp === S
```

Every accepted edge is stamped `S` and is never moved behind the cursor. A suffix edge was last stamped by an earlier pass of the same consumer, which took a smaller value from the forward-only clock, and nested passes take their own stamps. Uniqueness of stamps holds while the clock stays within JavaScript's safe-integer range ([`state.ts`](../../state.ts)).

Stamp `0` is never a pass stamp; it appears on graphs built by hand, where the classifier walks the prefix instead. The executable definition is [`prefix.ts`](./prefix.ts):

```ts
function isEdgeInTrackedPrefix(C, cursor, e) {
  if (cursor === C.lastIn) return true; // INV-T2
  const S = cursor.stamp;
  if (S !== 0) return e.stamp === S; // INV-T3
  for (let p = cursor; p !== null; p = p.prevIn) if (p === e) return true;
  return false;
}
```

This says nothing about whether a value was recomputed or is current; that belongs to the dirty-state and validation protocol. The stamp certifies membership in a temporal prefix.

**INV-H — One slot, two readings.** The frontier reading of `tailIn` is needed only while the node is `Computing`. Otherwise the slot is null, the residual incoming edge of the last pass, or a **hint**: an attached outgoing edge of the node with `from === node && to !== node` (an incoming edge has `to === node`, so a self-edge always reads as incoming). Maintenance keeps the reading exact ([`hint.ts`](../../shape/graph/hint.ts)):

1. the lookup writes the slot only with an edge it has located past its constant probes, only into a node that is neither `Computing` nor a watcher;
2. every unlink path (`unlinkEdge`, `unlinkDetachedIncomingEdgeSequence`, `unlinkAllSubscribers`) clears the hint that points to the unlinked edge;
3. every computation resets `tailIn` to null before its first read.

So whatever the slot holds is attached. The lookup uses a slot edge of exactly its pair as the answer, and any other slot edge from the producer as a finger (§5.3). A hint or finger is a positive answer only; a miss proves nothing.

## 5. Locating the edge

### 5.1 Levels

| Level | Where                                          | What settles the read                                                                                                                                 |
| ----- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0    | [`resolve.ts`](./resolve.ts), consumer side    | the next edge after the cursor, the cursor itself (consecutive duplicate), the first edge, one-hop and two-hop lookahead, the physical tail of `C.in` |
| L1    | [`locate.ts`](./locate.ts), producer side      | empty `P.out`, the newest edge `P.lastOut`, a sole edge to another consumer                                                                           |
| L1h   | [`findEdge.ts`](../../shape/graph/findEdge.ts) | the hint, when it is the edge of this pair                                                                                                            |
| L1    | `findEdge.ts`                                  | the two-link head start at `P.firstOut` (no slot write)                                                                                               |
| L2    | `findEdge.ts`                                  | the lockstep (§5.2), raced by the outgoing finger when the slot holds one (§5.3)                                                                      |

L0 lives in the hot `resolveTrackedRead` and three cold miss handlers (initial, tail, inner), kept apart so that a call site inlines only the miss kind that occurs there (README, "JIT"). L1 and L2 are reached only by reads no L0 tier settled.

### 5.2 The lockstep and its bound

The pair's edge, if it exists, is in both `P.out` and `C.in`. The lockstep walks `P.out` forward and `C.in` outward from the cursor in both directions (`back` along `prevIn`, `ahead` along `nextIn`), one link of each per step, and stops at the first side that finds the pair or is exhausted. The caller's own comparisons plus `back` and `ahead` must cover all of `C.in`; with that coverage, an exhausted side proves absence. With `d⁺(P) = |P.out|` and `d⁻(C) = |C.in|` a lookup compares

```text
O(min(d⁺(P), d⁻(C))) links, plus constants (head start, finger budget)
```

For two unsorted, unindexed lists with pointer traversal and identity comparison as the only operations, a worst-case membership query examines every member of one of them: `Ω(min(d⁺, d⁻))`. The lockstep meets this bound **for this representation and access model**; a hash index or a prepared per-source link (§8) changes the model. Over a round in which every consumer re-tracks once, Chiba and Nishizeki's bound `Σ_e min(deg u, deg v) ≤ 2·α(G)·m` limits the lockstep to `2α` links per read on average, `α` the arboricity: what keeps lookups expensive is a dense bipartite core, not a single wide hub.

### 5.3 The outgoing finger

Incoming locality is what L0 exploits: the next read is near the cursor. A dense reorder, a fresh permutation of a wide consumer's reads per pass, destroys it, and every read becomes a lookup between two wide endpoints. But `P.out` is append-only (§2): its subscribers are in the order they first ran. When consumers re-run in that order, as they do when the same watcher pulls them or the same write notifies them, the producer is read by `C₀, C₁, C₂, …`, which are neighbours in `P.out`, **however each consumer orders its own reads**. Incoming locality can be zero while outgoing locality is one; any schedule that repeats itself is aligned with `P.out` by construction.

The producer's slot already holds the edge of its last expensive lookup, the previous consumer's. When that edge is not the pair's, it is a finger. Past the head start, [`findEdgeInLockstepFromFinger`](../../shape/graph/findEdge.ts) runs `OUTGOING_FINGER_BUDGET` (8) rounds; each probes the ring around the finger once (after, before, after, …; past `lastOut` comes `firstOut`) and then takes one step of the plain lockstep, the base outgoing walk and the incoming walkers; then the plain lockstep continues from where every walker stands. The edge found becomes the hint.

Against the plain lockstep on the same slot state, the race costs at most one finger probe per round on top of it: an edge either walk of the plain lockstep finds, and absence either side proves, is reached in the same number of rounds, with at most `min(rounds, B)` extra comparisons. So `W ≤ W_lockstep + B`, with a constant independent of `D` and `K`, while a structured dense reorder saves `Θ(min(d⁺, d⁻))` per lookup.

Until 2026-11-01 the race ran 16 steps that alternated the outgoing link between the base walk and the ring, so the base walk advanced at half pace and an absence proof by a short `P.out` paid up to `B` extra steps plus the incoming steps taken meanwhile. Measured under a frozen tape controller (`perf/tape-controller`, branch `research/cost-sensitive-strike`), the finger-first rounds cut probes per finger lookup by ~45% on `replace-half ×16` and time by 2–7% on the narrow-producer churn shapes, neutral elsewhere; the remaining cost of that path is the call into the race (TurboFan's cumulative inlining budget of `resolveCursorTrackedReadMiss`), not its probes.

### 5.4 The regret principle

Every fast path of this subsystem answers in constant time when its guess is right and costs a small constant when it is wrong: the next-edge test, one-hop and two-hop, the tail, the newest edge, the hint, the two-link head start. The finger work turned this into an explicit rule, because the obvious finger violated it:

1. **A cheap hit and a cheap miss.** An unbounded walk around the finger finds near edges at once but can walk the whole list when the finger is far, where the head walk was short (§9.4).
2. **A miss must not stall the general proof.** Probes taken _before_ the lockstep are paid even when the incoming side would have answered in one step; probes raced _inside_ it are not.
3. **A slot write moves the slot a bounded distance, or happens only where the old answer was expensive anyway.** The hint is a second consumer's exact answer as well as the first consumer's finger; a write on every cheap find destroys it.

New fast paths are judged against these three before they are measured: which locality they exploit, what a hit saves, the worst cost of a miss, and whether the check is paid on reads that are already solved.

## 6. The miss cases and reconciliation

**Initial miss** (the first read does not match `firstIn`): if `lastIn` matches, move it to the front; otherwise the prefix is empty, so a located edge is in the suffix. One lookup, then reconcile.

**Tail miss** (the cursor is `lastIn`): the suffix is empty, so the pair's edge, if any, is in the prefix (INV-T2) and the read is a duplicate exactly when the edge exists; stamps are not consulted. Otherwise append.

**Inner miss** (an expected next edge exists and did not match): one-hop, two-hop and the physical tail first; then `locateReorderedEdge` (newest edge, then `findEdgeInLockstep`). A found edge in the prefix (INV-T3) is a duplicate; one in the suffix is moved; no edge means a link.

`reconcileLocatedRead` reconciles **without searching again**: it moves the located suffix edge after the cursor (to the head while the prefix is empty) or links a new one, and never unlinks. A configured `readTrackingStrategy` keeps its call contract and repeats its own search, since the resolver must locate the edge first to reject duplicates; that is the cost of the extension point.

## 7. Prefix evidence in reentrant propagation

When a producer is written while a subscriber computes, the push iterator must know whether that subscriber already accepted the written dependency in its current prefix; a suffix edge does not carry the same execution evidence. [`push_iterator.ts`](../propagation/push_iterator.ts) answers with `isEdgeInTrackedPrefix` in constant time (INV-T3), with INV-T2 covering watcher validation. Which obligation to record stays propagation's decision; only the membership question uses tracking evidence.

## 8. Comparison: compare obligations, not field names

A field called `version` can encode entirely different evidence. Compare edge uniqueness, identity preservation, duplicate classification, lookup preparation, subscriber order and failure behaviour separately.

| Approach                                 | Main idea                                                                                                                                                                 | Trade-off relevant to Reflex                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reflex                                   | Intrusive edges, cursor locality, producer probes and hint, exact lockstep raced by a bounded outgoing finger, pass-membership stamp, suffix kept until cleanup           | No index or per-pass preparation; identity-preserving reuse; joint-wide lookups without outgoing locality stay linear in the smaller degree                                                                                                                                         |
| Preact Signals                           | Per-source pointer to the active link, prepared and restored around each run                                                                                              | O(1) off-sequence lookup in exchange for per-run preparation and extra state                                                                                                                                                                                                        |
| Vue 3.5                                  | `dep.activeLink` with prepare/cleanup and link versions                                                                                                                   | Similar prepared lookup, different lifecycle cost                                                                                                                                                                                                                                   |
| alien-signals / Angular                  | Cursor and newest-subscriber locality, per-pass link evidence (`subsTail.version === cycle`, `knownValidAtEpoch === epoch`); a miss links a new edge instead of searching | Different reuse and ordering choices; similar field names do not imply Reflex's identity semantics                                                                                                                                                                                  |
| MobX                                     | Collect accessed observables, bind and diff after the run; `lastAccessedBy_ === runId` as a duplicate guard                                                               | Different reconciliation timing and duplicate scope                                                                                                                                                                                                                                 |
| Self-adjusting computation (Acar et al.) | Traces reused by reordering slices with order-maintenance timestamps                                                                                                      | The Reflex stamp test is the degenerate case: one pass, two classes, a forward-only clock                                                                                                                                                                                           |
| lite-signal                              | Pooled graph, cursor retracking, per-source stamps                                                                                                                        | Its proposed per-edge value versioning is a different concept from Reflex's membership stamp ([LEDGER #14](https://github.com/PeshoVurtoleta/lite-signal/blob/e940fd9f06a4209f1ab2328cfdef20f6bc4e1623/LEDGER.md) corrects an earlier reading of Reflex's field as a value version) |

Two ideas came from this survey: the per-pass stamp on the link, which INV-T3 turns into a complete prefix test, and the producer's newest link (`subsTail`, `consumersTail`), the newest probe of the miss handlers. The table classifies designs; it is not a performance ranking. Sources: [Self-adjusting computation, ESOP 2012](https://software.imdea.org/~rleywild/publications/esop12/esop12.pdf), [Preact Signals](https://github.com/preactjs/signals/blob/main/packages/core/src/index.ts), [Vue](https://github.com/vuejs/core/blob/main/packages/reactivity/src/dep.ts), [alien-signals](https://github.com/stackblitz/alien-signals), [Angular](https://github.com/angular/angular/blob/main/packages/core/primitives/signals/src/graph.ts), [MobX](https://github.com/mobxjs/mobx/blob/main/packages/mobx/src/core/derivation.ts).

## 9. History of the design and its evidence

Timing evidence comes in three strengths, kept apart below: **paired CI** (24 replicates, A/A control in every replicate, layout-randomized; the gate for runtime changes), **local timing** (one process per sample, case and bundle on a laptop; ±3–5% noise) and **link counts** (PROFILE builds, deterministic, replayed against a model of the code).

### 9.1 Exact pair lookup and the pass stamp (PR #52, `190a09e`)

The previous resolver scanned up to 32 prefix edges, 32 suffix edges and the producer's outgoing list, up to ~70 links per off-sequence read, and its 32-edge bound doubled as a search budget. PR #52 split locate, classify and reconcile; one lockstep lookup per off-sequence read, classification by INV-T3. A graph-level differential fuzz against the old resolver: 200,000 scenarios, identical. Local timing: permutations 2.7–5.1× faster, wide × wide 2.7–3.5× faster but still ~300 ns per read. Paired CI: no workload slower.

### 9.2 Repeated pairs and the hint (PR #57, `c6bd18c`)

A wide consumer re-reading one broad producer (`items.map((i) => f(i, theme()))`) paid a full lookup per duplicate: with 512 items and the consumer in the middle of 1,024 subscribers, 329,713 links and ~400 µs per pass. Within the strict representation this is provably unavoidable: a path from `P` to `e(P, C)` needs writable state reachable from `P`. INV-H gave the idle `tailIn` a second reading instead of adding a field. Paired CI: `A.track.hub-duplicate` −66%, nothing slower; later the hint moved before the head start (−19% on the same workload) and the reorder path got its own locate entry (`A.track.reorder-128-shuffled` −4.6%). Since `14e8fdb` the head start is two links instead of four.

### 9.3 The unvisited suffix survives until cleanup (PR #67, on `dev` as PR #69, `4efa8cc`)

Reconciliation used to detach the whole unvisited suffix when a new dependency was linked in front of at least 32 suffix edges. Every later read of those producers then relinked: on the tracking ladder a new dependency in the middle or in front made 65 or 128 new edges per pass instead of one. Removing the rule made those rungs 17–25× faster. The two policies differ only in representation: over 40,000 differential programs, list-order and event-order differences and no semantic one; the old rule is kept as the `eager-detach` counterfactual (`perf/tracking-ladder/variants.mjs`), identical to the old behaviour on all 40,000. PR #67 was merged into the hint branch after that branch had been squashed into `main`, so it reached `dev` only as PR #69.

ReactivePerformanceLab's long × long window slide (each consumer reads a window over a pool, newest sources first) shows the mechanism end to end. Per phase at 256 sources × 128 consumers, before and after: eager detachments 127 → 0, new edges 32,556 of 32,768 → 7,168 (exactly the edges cleanup drops, the true churn), proofs of absence 32,556 → 7,168, suffix edges reused 180 → 21,552. The lab's own smoke run: 30.0 → 6.75 ms per phase. Paired CI of PR #69: 28 equivalent, 4 inconclusive, nothing slower.

### 9.4 The outgoing finger (PR #68, `259b280`)

Dense reorder was the subsystem's largest gap: the lab's long × long shuffle at 256 × 128 took ~14 ms per phase, 16× behind the fastest library, with ~100 links per read. Measured on a dense core (`scripts/tracking-outgoing-locality.mjs`: read order × consumer schedule × gap), the next reader's edge was the previous reader's `nextOut` in 99% of reads, and with the slot as the base code left it, the looked-up edge was within two steps of the slot in 96% of lookups.

More than twenty variants were built as complete copies of `findEdge.ts` and replayed against PROFILE bundles (`perf/outgoing-finger/`). What the measurements forced, in order:

1. Fixed probes (`next`, `next-prev`, `next2`) fail against the order or with one static subscriber between consumers; `cyclic` is 1.22× slower in reverse; two outgoing walkers per step (`bidir`) starve the incoming side, 1.68× slower on random schedules at equal links.
2. An unbounded walk around the finger (`ring`) passed the local paired comparison of the benchmark suite, yet compared **169× more links** than base when two consumers alternate, one at the head of every `P.out` and one in the middle: base answers the head one by the head start without writing the slot and keeps the other's exact hint; `ring` writes the slot on every find and destroys it. Head start first (`ring-head`) repaired that and was still 1.46× slower on the three-consumer variant with gaps.
3. Bounded probes before the lockstep (`head-r2`) have a constant worst case but stall the incoming proof: +7–12% where the incoming side answers at once.
4. Racing the finger inside the lockstep removes that cost; alternating it with the base walk (`mix-bB`) bounds the delay of the head walk. The budget curve settled `B = 8`: the lab mirror saturates there and the worst case rises after it.

The result, `mix-b8`, with no timed case slower than base: the lab mirror's shuffle 386 → 26 ns per read (14.7×), value-sort 0.81, dense structured shuffles 0.14–0.45, random schedules 0.86–1.02. The number of lookups per pass and every other tier's counts stay identical; on the lab shuffle 29,470 lockstep finds per pass became 29,121 finger finds, and links per lookup fell from 108 to 4. Fuzz: 200,000 scenarios identical, INV-H held, 14 of 14 seeded mutants killed. Paired CI: 27 equivalent, 5 inconclusive, nothing slower. The lab's own smoke run: long × long shuffle ~14 → 1.0 ms (1.2× behind Preact), shared shuffle ~14 → 0.92 ms.

### 9.5 The cost of a unit of work (27 October 2026)

With the structural work reduced, three experiments asked what one read costs, with the algorithm fixed. Their variants and tools are on the research branch `perf/tracking-lookup-shapes`, not merged.

- **Code shape.** Eight equivalent shapes of the race and the lockstep (unrolled by two and by four, `switch`, branch order, loop split, a shared prologue) were certified identical lookup by lookup on 837 variant-cases, then timed: geometric means 0.979–1.010, every interval across 1. The race is always inlined into `findEdgeInLockstep`. A CPU profile of the lab shuffle puts the lookup loops at ~11% of a read; `resolveTrackedRead` with its inlined miss handling is 48%, `pull_frontier` (validation, outside tracking) 21%, the edge move 12%.
- **Memory touches.** Instrumenting every field access of the tracking and graph modules: a stable read touches 2 distinct edges, one of them cold; a finger hit touches 12.8 distinct edges, 6 of them not touched in the last 64 reads, but only 1.2 not touched in the last 1,024 reads, the same as a stable read. The premium of a hit is about five L2-level touches, mostly the producer's head-start and newest edges, which come before the finger.
- **Probe order.** Moving one finger probe ahead of the head start saves those touches (dense shuffles 0.82–0.87) but charges every consumer the head start would have answered (+5–12% on `head-far` and on a three-subscriber hub). Under the regret principle the current order is the best one available.

## 10. What stays at the bound

- **Schedules unrelated to `P.out`.** Consumers that re-run in an order unrelated to their link order get nothing from the finger; their lookups stay at the lockstep bound, `≤ 2α` links per read amortized.
- **Proofs of absence.** A hint or finger is a positive answer only. A new dependency between two wide endpoints needs the lockstep's proof of absence; without a complete index this is the bound in any representation.
- **The lab window slide after PR #69.** 6.75 ms per phase against 1.0–1.4 ms for other libraries. 54% of its lookup links are genuine proofs of absence (7,072 per phase, ~184 links each), 41% are reuses that neither incoming locality nor the finger reaches: the lab offsets windows by `consumer % 8`, so execution order and `P.out` disagree in blocks. Rotating the skipped suffix block (`rotate`) makes this case worse (73 → 95 links per read) and a larger finger budget does not help. Both halves need a new idea.
- **Failed passes** keep their partial reconciliation and their suffix until the next successful pass; nothing is rolled back.

## 11. Failure modes in reading the implementation

1. **"`edge.stamp` tracks whether a value changed."** False: it stamps read membership.
2. **"32 bounds the lookup."** False since PR #52, and since PR #67/#69 there is no 32-edge rule at all.
3. **"Every off-sequence read searches both lists."** False: L0 and L1 settle most reads; the bench suite's workloads almost never reach the lockstep.
4. **"Reconciliation can drop dependencies mid-pass."** False since PR #67/#69: only cleanup after a successful pass unlinks.
5. **"Edge identity is preserved unconditionally."** False: an edge unlinked by cleanup, by an explicit unlink or by disposal is gone; a later read links a new one at the end of `P.out`.
6. **"Subscriber order is part of the contract."** False: it is deterministic for this implementation and representation, not semantics.
7. **"The hint is an index."** False: one slot per producer, written only with an answer already paid for; it proves nothing about absence.
8. **"The finger replaces the lockstep."** False: it races it for a bounded number of steps and never stops the incoming walkers.
9. **"`O(min(in, out))` is a universal lower bound."** False: it is the bound of this access model.
10. **"`tailIn` always belongs to the incoming list."** Only while the node is Computing (INV-H).
11. **"The stamp test alone finds `(P, C)`."** False: locate first, then classify.
12. **"The resolver reorders transactionally."** False: moves are incremental and a throw rolls nothing back.

## 12. Reproduction

| Tool                                                                                                   | What it does                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`fuzz-tracking-graph.mjs`](../../../../../../scripts/fuzz-tracking-graph.mjs)                         | Graph-level differential fuzz of the working tree against a commit (frontier after every read, whole graph after every operation, INV-H); `--qualify` requires every seeded mutant of the hint, the finger race and the locate stage to be caught                                                                                     |
| [`perf/structural-retention/differential.mjs`](../../../../perf/structural-retention/differential.mjs) | Oracle programs on two builds, classified as identical, list-order, event-order or semantic; written for PR #67                                                                                                                                                                                                                       |
| [`perf/tracking-ladder/`](../../../../perf/tracking-ladder/)                                           | The degradation ladder: one property lost per rung, timing, counterfactual variants (`eager-detach`, `rotate`); its analyzer still models the four-link head start                                                                                                                                                                    |
| [`perf/outgoing-finger/`](../../../../perf/outgoing-finger/)                                           | Finger variants as whole files, replay of every lookup against a model, routes, timing; the lab mirror in [`scripts/tracking-lab-long-long.mjs`](../../../../../../scripts/tracking-lab-long-long.mjs). Code shapes, reconciliation counters and `--touch` memory accounting are on the research branch `perf/tracking-lookup-shapes` |
| [`bench/compare.mjs`](../../../../bench/compare.mjs)                                                   | The paired, layout-randomized comparison used by the CI gate                                                                                                                                                                                                                                                                          |

Link counts come from PROFILE builds and are deterministic; timings come from production bundles and need the paired protocol before they count as evidence.

## Source map

- [`resolve.ts`](./resolve.ts): `resolveTrackedRead` and the initial, tail and inner miss handlers (L0).
- [`locate.ts`](./locate.ts): producer-side probes (L1) in front of the lookup.
- [`prefix.ts`](./prefix.ts): INV-T2 and INV-T3.
- [`cleanup.ts`](./cleanup.ts): removal of the unvisited suffix.
- [`findEdge.ts`](../../shape/graph/findEdge.ts): hint, head start, lockstep, finger race.
- [`hint.ts`](../../shape/graph/hint.ts): INV-H.
- [`reuseEdge.ts`](../../shape/graph/reuseEdge.ts): the default strategy, for benchmarks and tools.
- [`cursorMoves.ts`](../../shape/graph/cursorMoves.ts): the two tracking moves (to the head, after the cursor).
- [`linkEdge.ts`](../../shape/graph/linkEdge.ts), [`sweepEdges.ts`](../../shape/graph/sweepEdges.ts): list operations.
- [`INVARIANTS.md`](../../../../docs/INVARIANTS.md), [`RULES.md`](../../../../docs/RULES.md), [`SEMANTIC_CONTRACT.md`](../../../../test/differential/docs/SEMANTIC_CONTRACT.md): contracts.

**One-sentence model:** Reflex locates the unique edge of a read through a ladder of constant-time guesses on both sides of an intrusive graph, each cheap when wrong, backed by one exact lockstep that the producer's finger may race but never stop, classifies it with a pass-membership stamp, and reconciles the incoming list without ever unlinking before the pass has succeeded.
