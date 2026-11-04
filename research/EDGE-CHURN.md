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

Use this probe to identify a repeatable correlation, then validate any
candidate change with `bench/run.mjs` and the runtime correctness suite on
the affected machine. No shape or pooling change is justified solely by a
single microbenchmark result.
