# V8 feedback audit

Measured on Node 25.2.0 / V8 14.1.146.11-node.13, Windows, from source
revision e97f9db. This is evidence about this engine and these profiles,
not a promise about other V8 releases. No contract or runtime change was
made by this audit. Inlining is covered separately in LOG 41.

## Method

The workloads in `bench/feedback.mjs` use the public API and production
flags. The name-retaining production twin makes source positions readable;
minified bundles are used for timing. The profiles exercise indexed reorders
(eight branches, width 600), a 1,200-deep push/pull chain, fanout to 1,000
computeds, creation/disposal of 100 watchers, heterogeneous values and
repeated failures/recovery.

- `--trace-deopt --trace-generalization --trace-elements-transitions
  --trace-file-names` collects runtime feedback, split at `STEADY_START`.
- `--trace-turbo --trace-turbo-filter=<function>
  --trace-turbo-path=<directory> --trace-turbo-cfg-file=<file>` collects IR
  and disassembly for read/write/mark/verify/exec/unindex.
- Compare guards at the same `V8.TFEarlyOptimization` phase and confirm
  relevant deopt exits in final disassembly. Static node counts include
  inlining and loop peeling; they are **not checks per iteration**.
- Trace runs are not timings. Timing uses separate processes, production
  bundles, five rounds with reversed variant order, warmup and seven samples
  per process. All compared checksums agree.

The full IR files and experimental source copies remain in the local
`.cache/engine-audit/` directory; they are not shipped with the package.

## Runtime feedback

| Profile | Warmup steps | Measured steps | Warmup bailouts | Steady bailouts |
| --- | ---: | ---: | ---: | ---: |
| Indexed reorder | 3000 | 12000 | 8 | 0 |
| Deep push/pull | 3000 | 12000 | 4 | 0 |
| Fanout | 3000 | 12000 | 5 | 0 |
| Lifecycle | 3000 | 12000 | 0 | 0 |
| Mixed values | 3000 | 12000 | 0 | 0 |
| Failure/recovery | 500 | 1500 | 0 | 0 |

These counts include workload callers, not just kernel functions. Warmup
counts can vary with compilation scheduling; the table records one run.
Recorded warmup reasons are insufficient feedback for calls, arithmetic and named access,
plus lazy bailouts of surrounding frames. No recurring wrong-map or numeric
overflow bailout was observed after warmup. This does **not** mean guards
disappear: guards can remain and succeed on every execution.

Numeric flags, versions and generations stay in Smi representation in the
observed field transitions. Their first writes change constness to mutable.
`value` correctly generalizes to tagged because the API accepts arbitrary
values. Edge `from`/`to` receive a class-specific heap-object field type and
remain const. `slot` changes constness when first used. These are expected
initialization transitions, not evidence for dummy writes at construction.
The host queue has a one-time PACKED_SMI_ELEMENTS→PACKED_ELEMENTS transition
on its first watcher. No steady elements-kind transition was observed.

## A real hint: make the numeric mask a compile-time literal

The ordinary exported `MASK` constant survives as a module binding in the
current bundle. On `s.ver = (s.ver + 1) & MASK`, current optimized `write`
retains an integer overflow guard and a small-integer conversion. Merely
adding `| 0` or masking the input with the same module binding does not
remove them.

Replacing MASK uses by a literal changes the generated IR:

| write, early optimized IR | Current | Literal MASK |
| --- | ---: | ---: |
| CheckedInt32Add | 1 | 0 |
| CheckedTaggedSignedToInt32 | 1 | 0 |
| LoadField | 21 | 20 |

The final `overflow` deopt exit disappears too. A TypeScript `const enum`
member produces that literal without duplicating the numeric definition in
source. This introduces no runtime field/register and preserves the existing
counter range. It is a concrete compiler hint, unlike `as number`/`as Edge`,
which disappear from emitted JavaScript.

The `enum-mask` prototype passed 64 generation, semantic, differential and
trim tests, including generation wrap. It is **not adopted**: five timing
rounds showed a tradeoff rather than a general win.

| Profile | Prototype/current median time |
| --- | ---: |
| Chain 100 | 0.950 |
| Stable width 8 | 0.982 |
| Stable width 256 | 0.988 |
| Computed fanout 1000 | 0.997 |
| Chaotic sharing | 1.009 |
| Rotate 256 | 0.968 |
| Lifecycle 100 | 0.964 |
| Deep validation | 1.003 |
| Indexed siblings, width 600 | 1.057 |

Fewer guards alone do not establish better end-to-end performance. Other
compile-time constants (SCAN/SETTLE/KEEP/TRIM) are plausible follow-up
candidates, but this audit does not claim measurements for changing them.

## Bounds: simple rewrites did not help

Two additional unindex prototypes were checked:

1. Decrement a local cursor and publish `top` once after restoring cells.
2. Do the same, preceded by explicit nonnegative-base/array-length guards.

At the same optimized IR phase:

| unindex | Current | Local cursor | Guarded local cursor |
| --- | ---: | ---: | ---: |
| Nodes | 157 | 168 | 188 |
| CheckedUint32Bounds | 2 | 2 | 2 |
| CheckedInt32Sub | 2 | 2 | 2 |
| CheckMaps | 7 | 8 | 7 |

`out of bounds` deopt exits also remain in final disassembly. The two bounds
nodes are from peeled/loop forms, not evidence that the same access is
checked twice on every iteration. The local-cursor prototype passed 49
tracking, stack, trim and differential tests. Five timing rounds range
0.976–1.031 across five profiles; there is no material consistent win.
Neither rewrite is adopted.

Do not replace `top`/`base` by `| 0`/`>>> 0` as a hint without a separate
range proof: those casts impose a finite wraparound domain on an otherwise
unmasked work-stack index. An invariant trusted by the researcher is not
automatically a fact known to the compiler.

## Practical conclusions

- Keep the current one-literal Node and Edge allocation shapes. Type/shape
  feedback is already stable; adding brands, constructors or runtime type
  assertions has no demonstrated benefit here.
- Preserve immutable edge endpoints and heap-reference/null fields. The
  engine records the actual field types; TypeScript assertions do not
  replace its guards. Do not narrow the arbitrary `value` payload.
- Do not cache mutable flags, versions, cursors or `fn` across user calls.
  Valid callbacks can write and dispose nodes, so reloads after a call can
  be required for correctness, not merely compiler conservatism.
- Treat module constants versus emitted literals as a genuine optimization
  axis, with IR, machine-code and workload evidence required before adoption.
- Do not add range assertions or dummy initialization writes just to placate
  the optimizer. The tested assertions added work without removing bounds
  checks; observed initialization generalization does not repeat steadily.
- Keep JIT shape checks outside semantic tests. Engine heuristics and code
  budgets are not part of the Quant contract.
