# Local Collections: executable contract prototype

This separate research module explores minimal local incremental maintenance
over Quant's public API. It is not part of the published package. Quant's source,
contract and mechanism basis are unchanged. Read [CONTRACT.md](CONTRACT.md) for
the exact supported semantics, preconditions and costs.

[First CI results](RESULTS.md): all contracts pass, and the one-row work
counters are identical from 1,000 through 1,000,000 rows.

```ts
import { get, effect } from "../../src/index";
import { createCollections } from "./index";

const db = createCollections();
const users = db.table({
  key: (user) => user.id,
  rows: [{ id: 17, team: "a", active: true, amount: 10n }],
});
const active = users.filter((user) => user.active);
const byTeam = active.groupBy((user) => user.team); // One explicit multi-index.
const counts = byTeam.count();
const totals = byTeam.sumBigInt((user) => user.amount);

const watcher = effect(() => {
  // Keyed reads currently track whole-view revisions, not per-key signals.
  console.log(get(active.size), counts.get("a"), totals.get("a"));
});
const stop = active.observeChanges((commit) => console.log(commit));
users.patch(17, { team: "b" });
// All stores/scalars are committed before either observer sees this change.
// Dispose watcher using Quant's public dispose(), unsubscribe, then close db.
```

The included mechanisms each have a witness:

| Mechanism                             | Why it is present                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Copy/freeze owned rows                | I1: mutable aliases would change data without deltas                                          |
| Immutable old/new delta payloads      | I2: derive old/new index keys from stable pure projections without per-row key caches         |
| Sparse Map/key write set              | I2–I5: late maintenance failure must leave no partial world; never clone a whole table/bucket |
| Stored filter membership              | I6: old membership is known without reevaluating the old row                                  |
| Shared Index object                   | I7: count, sum and delta consumers use one bucket map                                         |
| Operator work queue                   | Maintain a deep unary DAG without recursive propagation                                       |
| Two Quant scalar signals per operator | I4/I8: publish revisions/sizes without per-row graph allocation                               |

Row replacement changes are old/new pairs; primary-key changes become remove
plus insert. Index events explicitly report membership removal/insertion.
Group count and bigint sum publish only changed aggregate values. Snapshot is a
full frozen array of [key,value] entries. Index.lookup copies its result bucket.
There are no hidden full-refresh fallbacks.

Group counts are a view of the existing bucket sizes, without a duplicate count
map. Bigint sums retain one value per group; old/new row contributions are
recomputed with the pure projection, without a per-row sum cache.

## Verify locally (small inputs)

```sh
node node_modules/typescript/bin/tsc -p research/collections/tsconfig.json
node node_modules/vitest/vitest.mjs run --config research/collections/vitest.config.ts
node node_modules/vitest/vitest.mjs run --config research/collections/vitest.config.ts --mode production
node research/collections/build-witness.mjs
node .cache/collections/witness.mjs 10,1000
```

The tests cover I1–I8, unique conflicts, key changes, zero/empty bigint groups,
post-commit first-error delivery, rejected reentrancy, snapshots, and generated
operation sequences checked against full recomputation. The counting witness
adds a counter to Quant's actual createNode function through an esbuild plugin.
It checks physical node creations as well as adapter diagnostics. This counting
bundle is not a performance benchmark or a production build.

## CI scaling witness

CI alone runs N = 1e3, 1e4, 1e5, 1e6 with the same fixed plan. After construction
one row moves groups and changes its bigint contribution. The required result is
one predicate evaluation, two bigint projections (old/new), one shared index build,
constant index/store probes and staged writes, and eleven actual Quant node
creations (ten collection scalars plus one explicit test effect). A patch creates
no Quant node. All work counters must match across the sizes.

Construction and materialization remain O(N). This Map-based reference is not
a columnar-storage implementation and makes no minimum-memory claim. The
operation bound includes row payload size, affected operators, and observer
work, with expected hash lookup costs. The finite-size witness accompanies the
source argument that row loops never construct an Operator.

## Position and deferred work

D2TS already implements a more general differential dataflow model with
versions/frontiers and more operators; TanStack DB builds live queries on it.
This prototype asks a narrower question about local atomic maintenance and
minimal reactive publication, rather than claiming a new TypeScript dataflow
category. [D2TS](https://github.com/neondatabase/electric-d2ts),
[TanStack DB](https://tanstack.com/db/latest/docs/overview).

Explicit shared indexes borrow the reuse question, without promising a full
versioned Differential Dataflow Arrangement or trace. [Arrangements](https://docs.rs/differential-dataflow/latest/differential_dataflow/operators/arrange/).

Joins, parameters (including indexed range parameters), sumNumber, min/max,
per-key reactive handles, multi-source transactions and dynamic liveness are
deferred. Each needs its own semantic witness and bound. The semiring IVM paper
studies insert-only query classes; its constant-time results are not asserted
for this prototype's patch/delete operations. [The Role of Semirings in IVM](https://arxiv.org/abs/2606.07795).
