# Fireflies on six runtimes

One model, written on each runtime the way that runtime allows, and checked for the same answers
before anything is compared. It is the model of the site's
[Fireflies](https://volynetstyle.github.io/reflex-quant/fireflies/) page on a fixed grid:
pulse-coupled oscillators on a torus, where a firefly that flashes writes into its four
neighbours' inboxes from inside its own transition.

The model is useful as a probe because it needs two things at once: a computation with its own
previous state, and writes made during a computation, including writes that land on a
computation that has already run in this pass, or is still running.

This is separate from the project's benchmark suite (`bench/run.mjs`). It has its own
`package.json`, is not part of CI, and its timings are from one local machine.

## Run

```sh
cd bench/fireflies
npm install
npm run wakeup                                   # the minimal lost wake-up case
npm run check                                    # same state as the worklist after every tick
node check.mjs alien 1500                        # the direct alien-signals port, no repair
for n in plain quant preact vue solid angular alienDrain; do node time.mjs $n; done
node depth.mjs                                   # effect nesting depth in alien-signals
FW=200 FH=200 node big.mjs quant 900             # a 200x200 field, default stack
```

## The ports

`impls.mjs` holds all of them; every port returns `{ step, phases, lits, runs }`.

| name | how it is written |
| --- | --- |
| `plain` | No library: arrays and a worklist of fireflies with mail. The reference. |
| `quant` | `computed(prev)` per firefly holding its state, one `effect` reading all of them. |
| `preact`, `vue`, `solid`, `alien` | One effect per firefly, state in a closure, writes inside the effect. A computed there has no previous value or may not write, so the transition lives in an effect. |
| `angular` | `@angular/core/primitives/signals`: `createWatch` with a scheduler that drains a queue. A signal write inside `computed` is an error there (NG0600), so watchers. |
| `alienDrain` | `alien` plus a repair: after each tick, re-trigger every firefly whose inbox is not empty, until none is. |

The final state of a tick does not depend on the order in which an avalanche is processed (a
firefly that flashed is at 0, the others have summed every pulse), so all ports can be required
to agree exactly on who flashed when, and on phases to 1e-9.

## Results

Node 25.2.0, Windows, one machine. Versions are pinned in `package.json`:
alien-signals 3.2.1, @preact/signals-core 1.14.5, @vue/reactivity 3.5.45, solid-js 1.9.19,
@angular/core 21.2.26, reflex-quant 1.1.2.

### Same answers (64x40, 1,500 ticks, 40,980 flashes)

`quant`, `preact`, `vue`, `solid` and `angular` have the same state as the worklist after every
tick. Callbacks per tick are within about 1 % of the worklist's 2,601 for all of them.

`alien` differs at tick 1: fireflies are left with unread pulses.

### The lost wake-up

`lost-wakeup.mjs` reduces it to two effects. A writes into B's inbox; B's effect runs inside
that write and writes into A's inbox while A's effect is still running.

```text
alien   A received 0; left unread in A's inbox: 0.2
preact  A received 0.2; left unread in A's inbox: 0
quant   A received 0.2; left unread in A's inbox: 0
```

In alien-signals 3.2.1 the effect is not run again for a dependency written during its own run.
Quant does not reach that position: effects run one at a time from the host's queue, so B runs
after A has returned and B's write wakes A normally (logged order: A, A ends, B, A again). A write
that does land on a running effect is contract W2 (a watcher invalidated during its own run is
delivered again).
Whether alien-signals intends this is a question for its maintainers; this file only shows what
it does.

### Nesting depth

In alien-signals a write inside an effect runs the dependent effect inside that write, so an
avalanche nests effects on the call stack. `depth.mjs` counts the nesting on the repaired port:
on the default stack it overflows at tick 262 with 2,457 effects nested; with
`--stack-size=20000` it completes and the deepest nesting is 2,560, the whole 64x40 field.
At this size the outcome on the default stack depends on frame size: `check.mjs alienDrain`
overflowed at tick 262, while the same port completed in `time.mjs`.

### Time (64x40, median of 7 rounds of 1,500 ticks, one process per runtime)

| | ms / tick |
| --- | ---: |
| plain worklist | 0.014 |
| quant | 0.123 |
| preact | 0.146 |
| alienDrain | 0.180 |
| vue | 0.187 |
| angular | 0.205 |
| solid | 0.642 |

### A 200x200 field

40,000 fireflies, 900 ticks, default stack size (`FW=200 FH=200 node big.mjs <name> 900`):

| | result |
| --- | --- |
| quant | same state as the worklist; all 40,000 flash in one tick; 5.3 s |
| angular | same state as the worklist; 7.6 s |
| solid | same state as the worklist; 44.7 s |
| preact | `Cycle detected` at tick 167 (its limit on repeated effect runs) |
| vue | call stack overflow at tick 341 |
| alienDrain | call stack overflow at tick 247 |

## Limits

- One model and one machine. This is a probe of semantics and stack behaviour, not a ranking.
- Each port is one reasonable way to write the model on that runtime, not the only one.
- The Angular port uses the internal signal primitives with a queue written here; an Angular
  application gets its scheduler from the framework.
- The hand-written worklist is about nine times faster than any runtime here. The comparison is
  between runtimes, and about what each needs added to get the right answer.
