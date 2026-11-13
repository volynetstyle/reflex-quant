<div align="center">

# ⚛ reflex-quant

**Reactive state in under 3 KB.**
Signals, computeds and effects that update exactly what changed, nothing more.

[![npm](https://img.shields.io/npm/v/reflex-quant?color=cb3837&label=npm)](https://www.npmjs.com/package/reflex-quant)
[![CI](https://github.com/volynetstyle/reflex-quant/actions/workflows/ci.yml/badge.svg)](https://github.com/volynetstyle/reflex-quant/actions/workflows/ci.yml)
[![types](https://img.shields.io/badge/types-included-3178c6)](#api-at-a-glance)
[![license](https://img.shields.io/npm/l/reflex-quant?color=blue)](LICENSE)

[**Website & live examples**](https://volynetstyle.github.io/reflex-quant/) ·
[How it works](https://volynetstyle.github.io/reflex-quant/reactive-runtime-anatomy/) ·
[Benchmarks](https://volynetstyle.github.io/reflex-quant/benchmarks/)

</div>

```ts
import { signal, computed, effect, get, set } from "reflex-quant";

const count = signal(0);
const doubled = computed(() => get(count) * 2);

effect(() => console.log(`count=${get(count)} doubled=${get(doubled)}`));
// count=0 doubled=0

set(count, 1); // count=1 doubled=2
set(count, 2); // count=2 doubled=4
```

That covers most of it. You store values in **signals**, derive values with **computeds**, and react
to changes with **effects**. Quant tracks what each one reads, so you never
list dependencies by hand.

## Why quant?

- 🤏 **Tiny.** About 2.7 KB min+gzip for the whole library, and no dependencies.
- 🎯 **Exact.** Dependencies are whatever the last run actually read. Take a
  branch and the old dependencies drop away. Write a value that nothing
  currently reads and nothing reruns.
- ⚡ **Fast.** Comparable to the fastest signal libraries on the
  [benchmarks](#performance), and reordering dependencies allocates nothing.
- 🧱 **Stack-safe.** Updates travel through an explicit work stack instead of
  recursion, so a 100 000-deep chain of computeds updates without overflowing
  the call stack.
- 🔬 **Proven, not guessed.** Every mechanism in the runtime is backed by a test
  that fails without it. Quant's invariants also found
  [two real bugs in Vue's reactivity](#correctness).
- 🧩 **Framework-free.** Plain functions over plain values. You can use it in
  Node, the browser, workers, or behind any UI layer.
- 🟦 **TypeScript-first.** Signals, computeds and effects are distinct types:
  the compiler won't let you `set` a computed.

## Install

```sh
npm install reflex-quant
```

ESM and CommonJS builds are included, along with type declarations. It needs Node.js 18+ or any modern browser.

---

## The 5-minute tour

### 1. Signals hold values

```ts
import { signal, get, set, update } from "reflex-quant";

const name = signal("Ada");

get(name); // "Ada"
set(name, "Grace"); // replace
update(name, (n) => n.toUpperCase()); // derive from current: "GRACE"
```

### 2. Computeds derive values, lazily and cached

A computed doesn't run until something reads it. It reruns only when a value it
read has changed.

```ts
const price = signal(4);
const qty = signal(2);

let runs = 0;
const total = computed(() => {
  runs++;
  return get(price) * get(qty);
});

set(qty, 3);
set(qty, 5); // runs === 0: nobody asked yet

get(total); // 20, runs === 1
get(total); // 20, runs === 1: cached
```

### 3. Effects react to changes

An effect runs once right away, then again whenever something it read changes.
If it returns a function, quant calls that function before the next run and on
dispose. This is the place to clean up timers, listeners and subscriptions.

```ts
import { effect, dispose } from "reflex-quant";

const room = signal("general");

const chat = effect(() => {
  const r = get(room);
  console.log("join", r);
  return () => console.log("leave", r);
});
// join general

set(room, "random");
// leave general
// join random

dispose(chat);
// leave random
```

### 4. Dependencies follow your code

Quant doesn't use dependency arrays. Each run records exactly what it read,
so the dependencies change along with your `if` statements:

```ts
const showFull = signal(false);
const first = signal("Ada");
const last = signal("Lovelace");

const displayName = computed(() =>
  get(showFull) ? `${get(first)} ${get(last)}` : get(first),
);

effect(() => console.log(get(displayName))); // "Ada"

set(last, "Byron"); //  (nothing: `last` isn't being read right now)
set(showFull, true); // "Ada Byron"
set(showFull, false); // "Ada"
set(last, "King"); //   (nothing again)
```

### 5. No glitches, no duplicate runs

When two computeds share a source, the effect still runs **once**, and it
never sees a half-updated state:

```ts
const first = signal("Ada");
const last = signal("Lovelace");
const upper = computed(() => get(first).toUpperCase());
const initials = computed(() => get(first)[0] + get(last)[0]);

effect(() => console.log(`${get(upper)} (${get(initials)})`));
// ADA (AL)

set(first, "Grace");
// GRACE (GL)   (one run, both values already fresh)
```

### 6. Unchanged results stop propagation

If a computed recalculates and gets the same value, everything downstream stays
put:

```ts
const n = signal(1);
const parity = computed(() => (get(n) % 2 === 0 ? "even" : "odd"));

effect(() => console.log(get(parity))); // "odd"

set(n, 3); // (nothing: still "odd")
set(n, 4); // "even"
```

Writing the same value to a signal is also a no-op (compared with `Object.is`).

### 7. Batch several writes into one update

```ts
import { batch } from "reflex-quant";

const x = signal(0);
const y = signal(0);
effect(() => console.log(`(${get(x)}, ${get(y)})`)); // (0, 0)

batch(() => {
  set(x, 10);
  set(y, 20);
}); // (10, 20)   (one run, not two)
```

### 8. Read without subscribing

`peek` gives you an up-to-date value without making it a dependency.
`untracked` does the same for a whole block of code.

```ts
import { peek, untracked } from "reflex-quant";

const query = signal("cats");
const page = signal(1);

effect(() => console.log(`search "${get(query)}" page ${peek(page)}`));
// search "cats" page 1

set(page, 2); //        (nothing: page was only peeked)
set(query, "dogs"); //  search "dogs" page 2
```

---

## Recipes

<details open>
<summary><b>🛒 Shopping cart</b></summary>

```ts
const items = signal([
  { name: "Coffee", price: 4, qty: 2 },
  { name: "Bagel", price: 3, qty: 1 },
]);
const discount = signal(0);

const subtotal = computed(() =>
  get(items).reduce((sum, i) => sum + i.price * i.qty, 0),
);
const total = computed(() => get(subtotal) * (1 - get(discount)));

effect(() => console.log(`Total: $${get(total).toFixed(2)}`));
// Total: $11.00

update(items, (list) => [...list, { name: "Juice", price: 5, qty: 1 }]);
// Total: $16.00

set(discount, 0.1);
// Total: $14.40
```

</details>

<details>
<summary><b>✅ Todo list with a filter</b></summary>

```ts
const todos = signal([
  { text: "Write README", done: true },
  { text: "Ship 1.2.0", done: false },
]);
const filter = signal<"all" | "open" | "done">("all");

const visible = computed(() => {
  const f = get(filter);
  if (f === "all") return get(todos);
  return get(todos).filter((t) => t.done === (f === "done"));
});
const left = computed(() => get(todos).filter((t) => !t.done).length);

effect(() =>
  console.log(`${get(visible).map((t) => t.text).join(", ")} | ${get(left)} left`),
);
// Write README, Ship 1.2.0 | 1 left

set(filter, "open");
// Ship 1.2.0 | 1 left

update(todos, (list) => list.map((t) => ({ ...t, done: true })));
//  | 0 left
```

</details>

<details>
<summary><b>⏱ Debounced search</b> (with effect cleanup)</summary>

```ts
const query = signal("");

effect(() => {
  const q = get(query);
  const id = setTimeout(() => fetchResults(q), 300);
  return () => clearTimeout(id); // a new keystroke cancels the previous timer
});

set(query, "r");
set(query, "re");
set(query, "reflex"); // only "reflex" is fetched
```

</details>

<details>
<summary><b>🖱 Binding to the DOM</b> (no framework)</summary>

```ts
const count = signal(0);
const button = document.querySelector("button")!;

button.addEventListener("click", () => update(count, (n) => n + 1));

effect(() => {
  button.textContent = `Clicked ${get(count)} times`;
});
```

</details>

<details>
<summary><b>💾 Persisting to localStorage</b></summary>

```ts
const theme = signal(localStorage.getItem("theme") ?? "light");

effect(() => localStorage.setItem("theme", get(theme)));

set(theme, "dark"); // saved
```

</details>

<details>
<summary><b>🎛 Custom equality</b> (skip updates that don't matter)</summary>

A computed receives its previous value. If you return that same object,
dependents treat the result as unchanged and don't rerun, so you don't need a
separate comparator option:

```ts
type Cell = { col: number; row: number };
const mouse = signal({ x: 0, y: 0 });

const cell = computed((prev: Cell | undefined) => {
  const { x, y } = get(mouse);
  const next = { col: Math.floor(x / 100), row: Math.floor(y / 100) };
  return prev && prev.col === next.col && prev.row === next.row ? prev : next;
});

effect(() => console.log(get(cell))); // { col: 0, row: 0 }

set(mouse, { x: 10, y: 20 }); //  (nothing: same cell)
set(mouse, { x: 150, y: 20 }); // { col: 1, row: 0 }
```

</details>

---

## API at a glance

| Function                 | What it does                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `signal(value)`          | Create a writable value.                                                                      |
| `computed(fn, initial?)` | Create a lazy, cached derived value. `fn(prev)` receives the last committed value.             |
| `effect(fn)`             | Run `fn` now and again on every change it read. `fn` may return a cleanup function. Returns a handle. |
| `get(x)`                 | Read a signal or computed and **subscribe** the current computation to it.                    |
| `peek(x)`                | Read the up-to-date value **without** subscribing.                                            |
| `set(s, value)`          | Write a signal. Ignored if `Object.is(old, value)`.                                           |
| `update(s, fn)`          | `set(s, fn(current))`. `fn` runs untracked. If it throws, nothing is written.                 |
| `batch(fn)`              | Run `fn`, then deliver all its writes as a single update. Returns `fn`'s result.                       |
| `untracked(fn)`          | Run `fn` without subscribing to anything it reads.                                            |
| `dispose(x)`             | Stop an effect (running its cleanup) or detach a computed (its last value stays readable).    |
| `typeOf(x)`              | `"signal"`, `"computed"` or `"effect"`, without evaluating anything.                          |

> **Why `get(count)` and not `count()` or `count.value`?** Here the handle *is*
> the reactive node. Quant allocates no wrapper object or getter closure, so
> each signal costs one object.

## Good to know

**Replace values, don't mutate them.** Quant compares values with `Object.is`.
If you push into the same array, the array reference doesn't change, so nothing
updates:

```ts
update(todos, (list) => { list.push("eggs"); return list; }); // ❌ no update
update(todos, (list) => [...list, "eggs"]);                   // ✅ updates
```

**`prev` advances once per run, not once per write.** Computeds are lazy, so
several writes made before anyone reads collapse into a single run:

```ts
const clicks = signal(0);
const history = computed((prev) => [...prev, get(clicks)], [] as number[]);

set(clicks, 1);
set(clicks, 2);
get(history); // [2]   (1 was never observed)
```

If you need every write, append to the log in the code that does the writing,
not in a computed.

**Errors don't break the graph.** If a computed throws, `get` rethrows the error
and the computed keeps its last good value as `prev`. Once its inputs are fixed,
it recovers on the next read. If an effect throws during creation, it leaves
nothing running.

**Use the development build to catch cycles.** Bundlers that resolve the
`development` export condition (Vite, webpack, and Node with
`--conditions=development`) load a build that throws `Cycle detected` when a
computed ends up reading itself. The production build skips this check and
costs nothing extra.

## When to use something else

Quant is deliberately a **core**: values, derivations, reactions. It doesn't
include:

- deep reactive objects or proxies (`store.user.name = …`),
- async resources or suspense,
- component lifecycles or ownership scopes (`effectScope` and similar),
- a renderer.

Each of these can be built on top of quant. None of them is included, because
the [contract](CONTRACT.md) doesn't require them. If you need them out of the box, a
full framework (Vue, Solid, Preact Signals, MobX) is a better fit.

---

## Performance

Measured on CI against [Reflex](https://github.com/volynetstyle/Reflex) and
[alien-signals](https://github.com/stackblitz/alien-signals), with all three
runtimes on the same runner
([run 42794143933](https://github.com/volynetstyle/reflex-quant/actions/runs/42794143933), quant 1.1.2):

- within 25 % of the faster of the two on **17 of 18** scenarios, and faster than both on **7**;
- geometric mean: **0.99×** Reflex, **0.45×** alien-signals (lower is faster);
- reorders allocate nothing. If a computation reads the same 256 sources in a
  rotated order on every pass, quant creates and removes **0** links per pass
  where alien-signals relinks 255 (`node bench/structure.mjs`);
- Reflex is still faster on the reorder scenarios (quant 1.20–1.21× of it) and on
  `value-sort.256x32` (1.43×).

The suite is this project's own. Per-scenario numbers are on the
[benchmarks page](https://volynetstyle.github.io/reflex-quant/benchmarks/), and the
trajectory over CI runs is in [research/HISTORY.md](research/HISTORY.md).

## Correctness

Quant is also a research project. It asks: what is the **smallest** reactive
runtime that satisfies a fixed contract? The contract is a set of semantic invariants and structural bounds in
[CONTRACT.md](CONTRACT.md). It was extracted from the executable spec of
[Reflex](https://github.com/volynetstyle/Reflex)
(provenance in [research/REPORT.md](research/REPORT.md)). A mechanism is added
only if dropping it would break the contract or the asymptotics.

- **It found real bugs in Vue.** A port of quant's invariants to Vue 3.6 exposed
  two regressions in its Alien-derived reactivity core, both also reproducible
  in `alien-signals` 3.2.0. One was a lost update
  ([vuejs/core#16174](https://github.com/vuejs/core/issues/16174)). The other was
  generational-GC retention through removed links
  ([vuejs/core#16176](https://github.com/vuejs/core/issues/16176)). Both are
  now fixed upstream with permanent regression tests
  ([#16210](https://github.com/vuejs/core/pull/16210),
  [#16211](https://github.com/vuejs/core/pull/16211)).
- **Differentially tested.** Quant gives the same answers as Reflex's executable
  spec, with three documented choices applied, on all 27 061 bounded and
  18 660 recovery programs and on 100 000 generated ones. Graph integrity is
  checked after every operation.
- **Nothing is optional.** Removing any of the 34 mechanisms makes a test fail:
  25 fail a semantic test, 8 fail only a structural-bound or representation test,
  and 1 fails only a sibling-order test (a convention). All 7 ablations of the
  development diagnostic fail a test of the development build.
- Current Reflex is the same contract plus three failure-path choices. One of
  them drops an execution obligation that the contract (R2) says survives a
  failure.

Read more: the [report](research/REPORT.md), the
[design log](research/LOG.md) (one counterexample per mechanism), and the
[`padawan`](https://github.com/volynetstyle/reflex-quant/tree/padawan) branch.
That branch has the same semantics without the engineering (recursive push and pull,
no counters), written as a guided tour, and it passes the same differential corpus.

## Under the hood

The runtime has three layers:

- **kernel**: the dependency machine (graph, tracking, propagation, validation);
- **host**: effect lifecycle and delivery;
- **surface**: the typed public API. It is a thin layer: no operation adds a field,
  a flag or a branch on a hot path ([research/LOG.md](research/LOG.md) item 26).

The production build strips research instrumentation and development
diagnostics. The illustrated
[anatomy page](https://volynetstyle.github.io/reflex-quant/reactive-runtime-anatomy/)
walks through each part.

```text
src/        graph representation, kernel, host, public surface, instrumentation
test/       differential (spec, contract spec, Reflex, quant), tracking,
            semantics, structural bounds; tools/ (QUANT_TOOLS=1)
bench/      scenarios, adapters, build, timing (CI only), structure counters
research/   evidence, design log, ablations, historical benchmark snapshots
reference/  frozen Reflex implementation and provenance fixtures
site/       the website (Astro)
```

<details>
<summary><b>Contributing: build, test and benchmark</b></summary>

Development (including the site) uses Node.js 22.23.4 (see `.nvmrc`) or 24+
and npm. The published library supports Node.js 18+. Run `npm ci` to install.
The Reflex sources, spec harness and fixed production baseline live in
`reference/reflex`, so you don't need a Reflex checkout.

```sh
npm run lint                                    # lint production TypeScript
npm run format:check                            # check production formatting
npm run format                                  # format production code and tool config
npm run build && npm run check                  # standalone release and declarations
npx vitest run --config vitest.config.ts        # all tests, development build
npm run test:production                         # the same suite, production build
npx tsc -p tsconfig.json                        # typecheck src
node research/mutants.mjs                       # ablation -> research/mutants.json
node bench/build.mjs                            # bundles: quant, Reflex bf71877, alien-signals
node bench/run.mjs --verify-only                # same answers on all three runtimes
node bench/structure.mjs                        # structural work per step
node bench/run.mjs --rounds 9                   # timing: run it on CI, not locally
node bench/run.mjs --suite mechanisms --only '^push\.'   # one mechanism: read write track push pull effect batch lifecycle
node bench/run.mjs --suite scaling --only '^chain@' --out .cache/bench/s.json && node bench/scaling-report.mjs .cache/bench/s.json
                                                # growth with load: N = 16..4096, log-log slope per runtime
node bench/cost/build.mjs && node bench/cost/run.mjs regime --rounds 0
                                                # cost-model probes (research/COST-MODEL.md); timing on CI
```

CI runs on Windows, macOS and Linux with Node 22.23.4 and 24. Each matrix job
checks declarations, release artifacts, development and production tests, cost
probe verification, and the site. Dependencies are installed from both lockfiles
with `npm ci` (root and `site/`).

`npm run check:bench` builds every cost probe and runs it in verification mode,
including the independent leaf and decomposition cells, without collecting timings.
`npm run check:bench -- --smoke` limits this to leaf and decomposition.
`npm run check:site` builds the runtime and bench bundles, compares the site's
visualizations with the runtime, builds Astro, and checks the generated internal
page and asset URLs under the deployment base. Install site dependencies first
with `npm ci --prefix site`.

`.github/workflows/benchmark.yml` verifies all cost probes before any timing job
starts, and it shares the verified bundles. Each timing job runs all three
runtimes on one runner: compare ratios within a job, never times across jobs.
Pages deployment uploads only a site that passed its checks. The Reflex
benchmark baseline is fixed at commit `bf71877`; see
`reference/reflex/README.md` for its provenance.

Before proposing a change to the runtime, read [AGENTS.md](AGENTS.md) and
[ARCHITECTURE.md](ARCHITECTURE.md). They describe the inclusion criterion
a new mechanism has to meet.

</details>

## License

[MIT](LICENSE) © Andrii Volynets
