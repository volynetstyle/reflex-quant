# Local Collections: first structural result

The first CI run passed the collection contract, the frozen Quant tests, and
the one-row locality witness through 1,000,000 source rows.

- Tested commit: `d8b0aada1f66781a1f4111ac900b9d9f90497d4d`.
- [CI run 43626132260](https://github.com/volynetstyle/reflex-quant/actions/runs/43626132260),
  2026-11-14, all three jobs successful.
- Node v22.23.4, Ubuntu GitHub-hosted VM; structural job reports AMD EPYC 7763,
  four visible logical CPUs. The witness process is pinned to its first allowed
  logical CPU with taskset, with a 2 GiB V8 heap limit.
- Artifacts: `collections-tests-development`, `collections-tests-production`,
  `collections-locality-witness` (JSON counters and lscpu output; 30-day retention).

## Contract validation

| Suite                | Development |            Production |
| -------------------- | ----------: | --------------------: |
| Collection prototype |   17 passed |             17 passed |
| Frozen Quant core    |  187 passed | 180 passed, 7 skipped |
| Type check           |      passed |                passed |

The collection tests cover I1-I8, nested row ownership, exact shared indexes,
primary/secondary key changes, unique-key conflicts, coherent reads inside
delta callbacks and Quant effects, failed late maintenance with no publication,
post-commit observer errors, reentrancy rejection, exact bigint/empty-group
semantics, and count views composed with downstream filters/indexes. A generated
command test compares mutation sequences with fresh full recomputation (75
seeded runs, up to 40 commands per run).

## One-row scaling witness

The plan is fixed: table → active filter → shared team index → count and bigint
sum. Two delta consumers share that index; one Quant effect checks the complete
committed world. Initially all rows are active in team `a`. A patch moves row 3
to team `b` and changes its amount from 3n to 50n.

The counters below are mutation deltas after construction. The physical node
counter instruments the real Quant createNode function in an isolated counting
bundle; it is independent of the adapter's own node diagnostic.

| Source rows | Predicate calls | Key calls | Bigint projections | Index probes | Store reads | Staged writes | Physical Quant nodes created in plan | Nodes created by patch |
| ----------: | --------------: | --------: | -----------------: | -----------: | ----------: | ------------: | -----------------------------------: | ---------------------: |
|       1,000 |               1 |         3 |                  2 |            6 |          21 |             7 |                                   11 |                      0 |
|      10,000 |               1 |         3 |                  2 |            6 |          21 |             7 |                                   11 |                      0 |
|     100,000 |               1 |         3 |                  2 |            6 |          21 |             7 |                                   11 |                      0 |
|   1,000,000 |               1 |         3 |                  2 |            6 |          21 |             7 |                                   11 |                      0 |

At every size: one index build, ten collection scalar nodes plus the explicit
effect, one successful commit, zero rejected operations, and five changed
operator publications. Each delta consumer runs once; the effect runs once on
creation and once after commit. The witness asserts identical work objects
across all four sizes and checks the new counts/sums inside the effect.

Three key calls mean one primary-key projection plus old/new secondary-key
projections. Two bigint calls recompute old/new contributions from immutable
rows. No per-row key/projection cache is retained. Count uses the existing
bucket sizes rather than a separate count map. The six index probes include
the grouped aggregate maintenance; diagnostic store reads count calls to the
transaction accessor, not every JavaScript Map operation.

## Scope of the result

For this fixed unary plan and local mutation, counted maintenance work remains
independent of source population. Source inspection explains the bound: the
maintenance loops traverse incoming changes and affected group keys; no source
scan or bucket copy occurs. Only operator construction creates Quant signals.
The growing-N witness checks those claims on this implementation.

The bound includes affected operator entries, row payload/projection cost and
observer work, under expected hash-map lookup costs. Initial construction,
snapshot materialization and returning all matches remain linear in their
respective input/output sizes. Keyed reads currently subscribe to a whole-view
revision, so fine-grained per-key invalidation is not claimed.

This run measures no latency, memory footprint or advantage over another engine.
It establishes no representation-independent minimum-state theorem. Pure stable
callbacks and owned plain-data rows are explicit preconditions. Reentrant
same-engine mutations are rejected. Joins, query parameters, floating-point
aggregates, multi-table transactions and persistence remain outside this
prototype's contract.

The production Quant runtime, public package exports and frozen contract are
unchanged. Collection transactions belong to this separate research layer.
