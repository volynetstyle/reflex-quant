# Local Collections contract — research prototype

This is a separate research object, not an amendment to Quant's frozen
CONTRACT.md. Its question is: what state and publication contract are necessary
to maintain keyed local views incrementally over Quant's public API?

The current graph is a synchronous unary DAG: table → filter/index → grouped
count/sum. Each insert/remove/patch is one atomic collection operation. There
are no distributed workers, frontiers, version lattices, recursion, persistence,
joins, automatic callback equivalence, global proxies, or per-row Quant nodes.

## Invariants

- **I1 owned rows.** Input rows are copied into deeply frozen plain data trees;
  returned rows, snapshot tuples and delta payloads are immutable. Later writes
  to input objects cannot alter the stored rows.
- **I2 exact indexes.** Every committed index contains precisely the committed
  rows of its source, under its stored key projection and cardinality constraint.
- **I3 one committed world.** Reads through collection methods see committed
  stores. During preparation they see the old world; publication sees the new
  world, including every affected view and aggregate.
- **I4 commit before publication.** All physical stores commit before any scalar
  publication or delta callback. All changed scalar handles are updated inside
  Quant batch before callbacks and deferred Quant effects run.
- **I5 failed maintenance publishes nothing.** A selector, predicate, bigint
  projection or constraint failure during preparation leaves every store and
  revision unchanged. No deltas or scalar notifications are published. Diagnostic
  counters count attempted work, including failed attempts.
- **I6 row-local predicate work.** An incoming new row is evaluated once per
  affected filter, using stored old membership; a deletion evaluates no predicate.
  No other source row is rescanned for that operation.
- **I7 explicit sharing.** One explicit Index/Grouped handle owns one physical
  bucket map. Its consumers do not rebuild that index. A second
  indexBy/groupBy call creates another index even with equivalent JS functions.
- **I8 bounded reactive representation.** Only Operator construction creates
  Quant nodes: two scalar signals per operator, independent of row/group count.
  count() on an ungrouped view aliases its size handle. This version does not
  create independent per-key reactive nodes.

## Data and operation semantics

Rows are ordinary or null-prototype records with enumerable own string data
properties. Values may be primitives (including bigint/undefined), plain records
and arrays. Cycles, accessors, functions, symbols, class instances, Date, Map and
Set payloads are rejected. Proxies are outside the plain-data precondition.
Input/returned object identity is not preserved: the engine owns its copy.

Keys are strings, bigint or finite numbers, using Map/SameValueZero identity
(including 0 = -0). insert rejects a duplicate primary key; remove on a missing
key returns false without a commit; patch on a missing key throws. patch is a
shallow field merge followed by ownership copying. It produces a fresh row even
when its fields are equal. A primary-key change is remove-old + insert-new,
with destination conflicts rejected atomically. Index key changes similarly
retract old membership and insert new membership.

Callbacks must return stable results from their row argument, with no mutable
ambient dependency or side effects other than diagnostic instrumentation.
Declared reactive query parameters are deferred: get(threshold) in a predicate
is not implicitly tracked. Callback evaluation is untracked in Quant.

Reentrant mutation or query construction on the same engine during preparation
or publication is rejected. This first contract does not silently queue writes
from observers or promise collection feedback loops. Public Quant batch can
defer its effects across several collection operations, but does not combine
those operations into one collection transaction. Multi-table transactions are
not implemented.

sumBigInt requires actual bigint projection results and is exact. count uses
exact nonnegative population integers representable by number. Zero-sum groups
remain present while nonempty. Number sums, min/max and ordered views have no
implicit fallback in this prototype. Iteration order is not query semantics.

Revisions are monotonically increasing safe integers per engine. Exhaustion
rejects the next mutation before preparation. Resource exhaustion during native
allocation is outside this in-memory contract; ordinary user callback failures
are covered by I5.

## Publication, errors and lifetime

An operation prepares a sparse write set over existing Map/key pairs, propagates
changes through an iterative queue, commits all writes, then publishes. It does
not clone the source table, existing buckets or whole indexes on mutation.
Temporary writes/queues are released after the operation; there is no retained
delta history or replay cursor.

Delta callbacks receive frozen commit batches. Subscription lists are captured
for the publication; unsubscription affects subsequent publications. Callback
failures are collected without suppressing later deliveries. After stores have
committed, observer/effect failures do not roll back already visible state.
The first delta-callback error remains first if a later Quant effect also fails,
using Quant batch's existing first-error behavior.

The engine owns all constructed operators/indexes until dispose(). Disposal
clears stores, operator links and delta subscribers. Quant scalar handles
remain inert with their last numeric values; Quant has no public signal disposal
API, and external effects remain caller-owned. Collection data reads after
disposal throw. No scope/ownership mechanism is added to Quant.

## Costs and observation

- View.get(key) is an expected O(1) committed keyed lookup in the hash-map model.
  It tracks the view revision, so reactive invalidation is coarse per view.
- View.snapshot() returns a frozen array of [key, value] tuples, costing O(rows).
- Index.lookup(key) copies the matching rows into a frozen array, costing O(matches).
  bucketSize(key) is an expected O(1) lookup. Index.size counts distinct keys.
- observeChanges publishes only changed rows/groups, with observer work added to
  engine cost. Slow or snapshot-taking observers can dominate the total cost.
- Grouped.count()/sumBigInt() return keyed scalar-result views, not per-group
  Quant nodes. Unchanged group results do not publish a new revision.

For a fixed unary plan and fixed-width rows, mutation work depends on changed
entries across affected operators, not total table size. Owning a row costs its
payload size. Hash-map lookup bounds are expected, not a JavaScript worst-case
constant-time guarantee. Initial construction and a full snapshot remain linear.

The structural argument for I8 is the single signal-allocation site in Operator;
row loops construct no Operator. Counters at increasing N are witnesses of that
argument, not a replacement for it. stats.quantNodes/operators count adapter
creations, not garbage-collector liveness. No compact-columnar memory claim is
made: this reference implementation uses ordinary JS Maps and immutable records.

## Research boundary

An engine write set is admitted here by I2–I5; those obligations are new to this
layer. It is not evidence for adding transactional writes to Quant's core.
Joins, explicit parameters, per-key reactive publication and range indexes need
their own contract extensions and witnesses before being implemented.
