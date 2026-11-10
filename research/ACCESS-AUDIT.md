# Object access audit (LOG 44)

Baseline: `9dde26da341eb80dd78f55b973e6209f28c14677`. Node 25.2.0,
V8 14.1.146.11-node.13, Windows, Intel Core i5-1235U. This is a local
implementation audit, not a replacement for the CI performance comparison.
The change is an optimization: no new mechanism, object field, flag or
persistent execution register.

## Order and lifetime of evidence

Use an available local fact before loading a field, a node already in hand
before following another edge, an exact cheap absence proof before a search,
and bounded search before indexing. Reuse is valid only while the fact cannot
change. The final change applies that rule in the following places.

| Path | Previous source accesses | Final source accesses |
| --- | --- | --- |
| Non-repeat tracking miss, `last.from` | repeat check and indexed certificate load it separately | one local source pointer serves both |
| First subscriber lookup that starts a nonempty marked/indexed suffix | `s.subs` in absence check, `pair`, and `begin` | one head snapshot passed to both helpers |
| Propagation into a nonempty subscriber list | `n.subs` for the guard and the walk | one snapshot |
| Mark descent with a pending sibling | `n.subs` and `e.nextSub` each read twice | each read once |
| Occupied slot claim | `s.slot` in guard and displaced-stack push | one snapshot |
| Host queue insertion | flags in guard and read/modify/write | reuse the guard's flags |
| Fresh source during a marked pass | suffix-mode test, then a subscriber lookup that finds an empty list | the loaded null subscriber head proves absence before either |

These are counts in the source, not a claim that every removed access was a
machine load. In particular, the inspected optimized `mark` has the same
LoadField count in both versions despite fewer repeated accesses in source.

`miss`, its bounded searches, `pair`, `begin`, `index` and `claim` invoke no
user code. Their local snapshots cannot become stale between capture and use.
In `write` and `mark`, the captured head/sibling is used before descending;
the sibling after a watcher wake is still loaded **after** that callback.
Mutable flags, values, relations and cursors are not reused across `pull`,
`exec`, a wake hook or cleanup. The existing failure, self-disposal and nested
execution tests exercise those boundaries.

The validation ascent was also investigated: `n` is the node that was just
settled and equals the immutable `up.from` endpoint. That equivalence is
semantically sound even with disposal (W3), but its compiler cost did not
justify changing the existing hot code; see the rejected reshapes below.

## Stable read budget

The clean read path itself is unchanged. In the production source:

- An untracked clean read loads `flags` and `value`; it performs no graph work.
- A stable tracked hit additionally loads `cursor.next` (or `consumer.deps`
  on the first read), `next.from` and `source.ver`: five object field reads
  in total, plus execution-register access, and no lookup or allocation.
- Immediate-repeat detection stays on the miss path. Moving it before every
  cursor hit would make stable reads inspect another source pointer.
- Tracking preserves the first successful observation's version (P5).
  A callback can change a source or dispose a node, so the corresponding
  post-callback reads remain necessary.

## Compiler feedback

The name-retaining production twins were traced with `bench/feedback.mjs`:
`deep` for `verify`/`mark`, `indexed` for `miss`, 2,000 warmup and 5,000
subsequent steps. Compare `V8.TFEarlyOptimization`, not different lowering
phases. Traces are separate from timing runs.

| Observed graph | Baseline | Final |
| --- | ---: | ---: |
| `verify` LoadField | 71 | 71 |
| `verify` CheckedTaggedToTaggedPointer | 12 | 12 |
| `mark` LoadField | 20 | 20 |
| `miss` LoadField | 54–63 across observed compilations | 58 in the final trace |

These are whole optimized graph counts, including inlining and loop peeling;
they are not per-iteration counts. The changing `miss` inlining graphs do not
establish a fixed machine-load saving. The stable read, `peek`, `pull`, `exec`
and `verify` source bodies remain unchanged; the proven work reduction is the
eliminated lookup on the fresh-source witness.

## Rejected reshapes

- Passing cached flags from `peek`/`check` into `pull` preserves semantics
  and saves a source access, but the five-round screen slowed `stable-1`
  from 13.53 to 15.73 ns (1.162 ratio). The final `peek`/`pull` boundary is
  unchanged.
- A local copy of the newly committed generation did not survive the narrow
  stable-path screens. The existing store/read form remains; source-level
  load counting is insufficient reason to alter that hot code.
- Expanded scan loops acted on a match inside the loop, avoiding the final
  field recheck. They passed the then-current 171-test suite but a combined
  candidate showed a 1.072 ratio on `swap-32`; compact scan loops remain.
- Using the already settled node's `n.ver` in ascent removed one LoadField
  (71 to 70), but added one CheckedTaggedToTaggedPointer (12 to 13).
  A broad screen flagged wide validation; a seven-round isolated comparison
  did not establish a material advantage for the replacement. The final
  `verify` keeps its original `up.from.ver` comparison.

## Timing evidence

Timing uses the existing `bench/worker.mjs`: a fresh process per bundle/case,
at least 300 ms warmup, 21 calibrated samples and a matching 64-step checksum.
Bundle order alternates each round; case order also alternates in broad runs.
IR traces and test runs are not collected concurrently with timings.

The targeted `track.fresh-after-reorder-64` workload reverses 64 retained
sources, reads 64 sources from an unsubscribed alternating pool after the
first read, and drops the previous pool. Those fresh reads occur while the
old suffix is marked, so this exercises the new cheap absence proof rather
than the pre-existing proof before marking.

| Final vs baseline, seven rounds | Baseline | Final | Final/base |
| --- | ---: | ---: | ---: |
| Targeted reorder + fresh subscriptions, median ns/step | 2,631.6 | 2,527.9 | 0.961 |
| Range of round medians, ns/step | 2,568.3–2,776.1 | 2,481.3–2,587.2 | — |
| Median of paired round ratios | — | — | 0.952 |

Broader screens covered 21 cases in five rounds, plus seven-round narrow hot
path and validation screens. After rejecting the ascent candidate, the exact
final version was compared on all 21 cases for three more rounds. Selected
final results are below; they do not establish a portable general speedup.

| Final screen, three rounds | Ratio of medians | Median paired ratio |
| --- | ---: | ---: |
| `read.signal` | 1.004 | 1.003 |
| `read.computed-clean` | 1.004 | 0.994 |
| `write.no-subscribers` | 1.000 | 1.002 |
| `write.same-value` | 1.002 | 1.006 |
| `track.stable-1` | 1.006 | 1.031 |
| `track.stable-64` | 0.957 | 0.957 |
| `track.duplicate-64` | 0.991 | 0.971 |
| `track.swap-32` | 1.009 | 0.948 |
| `pull.validate-wide-256` | 0.949 | 0.949 |
| `reorder.rotate-256` | 1.007 | 0.997 |
| `shared-chaotic.64x32` | 0.988 | 0.988 |
| `lifecycle.mount-100` | 1.014 | 1.050 |

Many broad results overlap the spread of their round medians. In particular,
the lifecycle paired result and narrow stable-path variation are retained as
limitations, not hidden behind a geometric mean. The concrete performance
claim is the local seven-round target result and its eliminated lookups;
CI/other-engine confirmation remains separate.

## Validation

The new structural witness inserts a source with no subscribers in the
middle of a marked reverse pass. Only the 63 reordered old relations need
pair lookups; the fresh source allocates one relation without a lookup.
Development: 172/172. Production: 165 passed, seven C1 diagnosis tests skipped.
`no-fresh-source` fails two structural tests, `no-displaced` fails 25 tests,
and `repeat-refresh` fails three P5 tests. All 46 ablation anchors and Reflex
idle anchors validate; cost-probe bundles build.

Typecheck, lint, formatting, build and release checks pass. Minified and
unminified builds agree on 18 scenarios / 5,400 steps; ESM release size is
2,280 B gzip versus 2,262 B before this change. The extra source locals do not
change node/edge shapes or add allocation sites.

Experiment source snapshots, production twins, IR, timing rounds and rejected
variants are retained in `.cache/access-audit/` in the working checkout.
