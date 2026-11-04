# Isolated edge churn probe

`bench/edge-churn.mjs` needs only Node. It runs each shape and case in a
fresh process, shuffles case order each round, warms up, then reports the
median of 21 batches and the range of round medians. It records Node, V8,
CPU and OS in its output. The experiment workflow also saves its JSON and
table as artifacts on the same runner as the runtime benchmarks.

```sh
node bench/edge-churn.mjs --rounds 7 --out edge-churn.json
# An individual subset, useful for repeated runs and V8 traces:
node bench/edge-churn.mjs --rounds 7 --only '^8\.(replace|replace-pool)$'
```

Run the same revision, Node binary version and options on each machine;
keep the JSON files and runtime benchmark results. Compare round ranges as
well as medians, and repeat noisy results. CPU frequency, OS, V8 flags,
thermal state and runner contention can all affect comparisons. A GitHub
hosted runner is not a guarantee of a particular CPU model.

Each step processes 128 edges. Values are nanoseconds per edge, including
loops, list maintenance and cleanup, not standalone allocation latency:

| Case | Timed work |
| --- | --- |
| allocate | Allocate edges and store them in an escaping array. |
| source | Allocate, append to source subscriber lists, then unlink. |
| consumer | Allocate, insert in a consumer dependency list, then detach it. |
| full | Allocate, link both lists and unlink the source lists. |
| pool | Same as full, but reset and reuse preallocated edges. |
| replace | Insert 128 allocated edges before a previous suffix, cut and unsubscribe that suffix; alternate two source sets. |
| replace-pool | Same as replace, but reset and reuse two sets of edges. |
| replace-defer | Same as replace, but defer updating the old suffix's `prev` pointer until all new edges have been linked. |
| replace-old-store | Write the retained prefix to the old suffix's `prev` on every insert, then repair it once at the end. |
| replace-pool-defer | Same as replace-defer, with preallocated edges. |

The 8-field shape matches the production Edge's property names and order;
7 fields omit `gen`, and 9 add an initialized Smi. The 7-field variant is
only a layout experiment and does not preserve the runtime's invariants.
Sources and consumers are simplified, subscriber lists start empty, and no
tracking, indexed lookup, scheduling or runtime code is measured. Even the
replacement case is a model of the pointer operations, not a reproduction of
the complete runtime workload. The allocation-only case retains its last
128 objects; the replacement case retains only its active graph, whereas the
pool necessarily retains both sets. Reuse changes object age, GC behaviour,
stores and memory locality, so a pool/fresh difference does not by itself
prove an allocator defect. Differences between cases are not additive costs.

The three `defer`/`old-store` cases deliberately break the dependency list's
backward links during insertion. They restore the links before the synthetic
step finishes, but reactive code may read, reorder, reenter or throw between
individual insertions. These cases control for the repeated store to the old
suffix, not implementations that can safely be substituted into the runtime.
`replace-old-store` also changes the value being stored: it tests a different
reference pattern, not a direct measurement of a write barrier.

An EPYC 9V74 run on Node 24.22.1 / V8 13.6 reported 8-field medians of
9.80 ns for allocate, 27.02 ns for full, 48.88 ns for replace and 16.86 ns
for replace-pool. The 7- and 9-field replacements were 45.33 and 50.74 ns;
these measurements do not show an abrupt 8-field size-class cliff. In the
same run, runtime `replace-half.256` was 3.17x Reflex but `branch.switch-100`
was 0.86x, so churn alone is not sufficient to explain the slowdown. The
new controls have not yet been measured on that EPYC.

Use this probe to identify a repeatable correlation, then validate any
candidate change with `bench/run.mjs` and the runtime correctness suite on
the affected machine. No shape or pooling change is justified solely by a
single microbenchmark result.
