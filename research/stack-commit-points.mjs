// RQ6 commit points: actual native stack exhaustion at the calls that follow
// a runtime store. Each witness runs in a fresh process against an esbuild
// bundle of the source (Vitest's module wrappers turn an overflow inside a
// cross-module call into a TypeError, so the suite cannot observe these
// windows itself), with optimization state of its own.
//
//   node research/stack-commit-points.mjs [--mode development|production]
//        [--src <dir>] [--only <witness>]
//
// Exit 0: every witness held. Exit 1: a witness observed a wedge.
// Exit 2: a sweep never reached the stack limit, or the harness failed.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const self = path.join(import.meta.dirname, "stack-commit-points.mjs");

// ------------------------------------------------------------------ child

const LEVELS = 8;

/**
 * Run `count` attempts in the few frames above the native stack limit. A
 * whole recursion frame is coarser than the windows between a store and its
 * next call, so successive sweeps shift each attempt by one stack slot (a
 * call with `pad` actual arguments). Only attempts that began count.
 */
function sweep(attempt, count) {
  let next = 0;
  let overflows = 0;
  let level = 0;
  let foreign = null;
  function invoke() {
    level++;
    try {
      attempt(next++);
    } catch (error) {
      if (error instanceof RangeError) overflows++;
      else foreign ??= error;
    }
  }
  for (let pad = 0; next < count; pad = (pad + 1) & 63) {
    const args = new Array(pad);
    level = 0;
    const descend = () => {
      try {
        descend();
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
      if (level < LEVELS && next < count) {
        try {
          Reflect.apply(invoke, null, args);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
        }
      }
    };
    descend();
  }
  return { overflows, foreign };
}

const QUEUED = 1 << 7; // Flag.Queued (src/graph.ts)
const BUSY = 1 << 2; // Flag.Busy

/** Each witness returns a list of violations; empty means it held. */
const witnesses = {
  // exec stores BUSY, then calls the body and, on failure, `fail`.
  activation(q) {
    const { signal, computed, get, set } = q;
    const input = signal(0);
    const nodes = Array.from({ length: 512 }, (_, i) => computed(() => get(input) + i));
    for (const node of nodes) get(node);
    set(input, 1);
    const run = sweep((i) => get(nodes[i]), nodes.length);
    const bad = [];
    if (run.foreign) bad.push(`attempt threw ${run.foreign.message}`);
    for (let i = 0; i < nodes.length; i++) {
      if ((nodes[i].flags & BUSY) !== 0) bad.push(`node ${i} BUSY`);
      try {
        if (get(nodes[i]) !== 1 + i) bad.push(`node ${i} value ${get(nodes[i])}`);
      } catch (error) {
        bad.push(`node ${i} threw ${error.message}`);
      }
    }
    return { run, bad };
  },
  // start stores hold = 1, then runs the watcher and opens the drain.
  create(q) {
    const { signal, effect, get, set, dispose } = q;
    const run = sweep(() => dispose(effect(() => {})), 512);
    const bad = [];
    if (run.foreign) bad.push(`attempt threw ${run.foreign.message}`);
    if (q.hold !== 0) bad.push(`hold ${q.hold}`);
    const input = signal(0);
    const seen = [];
    const watcher = effect(() => {
      seen.push(get(input));
    });
    set(input, 1);
    if (seen.join() !== "0,1") bad.push(`new watcher saw [${seen}]`);
    dispose(watcher);
    return { run, bad };
  },
  // drainNow stores hold = 1 and calls drain; drain takes a watcher off the
  // ring and calls deliver.
  drain(q) {
    const { signal, effect, get, set, dispose } = q;
    const trials = Array.from({ length: 512 }, () => {
      const input = signal(0);
      let seen = -1;
      const watcher = effect(() => {
        seen = get(input);
      });
      return { input, watcher, seen: () => seen };
    });
    const run = sweep((i) => set(trials[i].input, 1), trials.length);
    const bad = [];
    if (run.foreign) bad.push(`attempt threw ${run.foreign.message}`);
    if (q.hold !== 0) bad.push(`hold ${q.hold}`);
    trials.forEach((trial, i) => {
      set(trial.input, 2);
      if (trial.seen() !== 2) bad.push(`watcher ${i} saw ${trial.seen()}`);
      if ((trial.watcher.flags & QUEUED) !== 0) bad.push(`watcher ${i} QUEUED`);
      dispose(trial.watcher);
    });
    return { run, bad };
  },
  // wake stores QUEUED, then grows a full ring.
  enqueue(q) {
    const { signal, effect, get, set, dispose, batch } = q;
    const fillers = Array.from({ length: 4096 }, () => {
      const input = signal(0);
      return { input, watcher: effect(() => void get(input)) };
    });
    const targets = Array.from({ length: 512 }, () => {
      const input = signal(0);
      let seen = -1;
      const watcher = effect(() => {
        seen = get(input);
      });
      return { input, watcher, seen: () => seen };
    });
    let round = 0;
    const run = sweep((i) => {
      const full = Math.min(q.queueLength(), fillers.length);
      round++;
      batch(() => {
        for (let k = 0; k < full; k++) set(fillers[k].input, round);
        set(targets[i].input, 1);
      });
    }, targets.length);
    const bad = [];
    if (run.foreign) bad.push(`attempt threw ${run.foreign.message}`);
    if (q.hold !== 0) bad.push(`hold ${q.hold}`);
    targets.forEach((target, i) => {
      set(target.input, 2);
      if (target.seen() !== 2) bad.push(`target ${i} saw ${target.seen()}`);
      if ((target.watcher.flags & QUEUED) !== 0) bad.push(`target ${i} QUEUED`);
      dispose(target.watcher);
    });
    for (const filler of fillers) dispose(filler.watcher);
    return { run, bad };
  },
  // write stores STALE on a computed, then marks below it (mark); mark
  // stores STALE, then descends. A STALE computed stops every later push,
  // so an interrupted walk must not leave one above unmarked consumers.
  // Only computeds: a lost watcher delivery leaves its sources STALE by
  // design (D7), which is a different question. s -> a -> {b -> c, d}; an
  // unmarked computed returns its cached value, so reads observe the cone.
  cone(q) {
    const { signal, computed, get, set } = q;
    const trials = Array.from({ length: 512 }, () => {
      const s = signal(0);
      const a = computed(() => get(s));
      const b = computed(() => get(a));
      const c = computed(() => get(b));
      const d = computed(() => get(a));
      get(c);
      get(d);
      return { s, c, d };
    });
    const run = sweep((i) => set(trials[i].s, 1), trials.length);
    const bad = [];
    if (run.foreign) bad.push(`attempt threw ${run.foreign.message}`);
    trials.forEach((trial, i) => {
      set(trial.s, 2);
      const seen = [get(trial.c), get(trial.d)];
      if (seen.join() !== "2,2") bad.push(`trial ${i} read [${seen}]`);
    });
    return { run, bad };
  },
};

const { values: options } = parseArgs({
  options: {
    mode: { type: "string" },
    src: { type: "string" },
    only: { type: "string" },
    child: { type: "string" },
    bundle: { type: "string" },
  },
});

if (options.child !== undefined) {
  const q = await import(pathToFileURL(options.bundle).href);
  const { run, bad } = witnesses[options.child](q);
  console.log(JSON.stringify({ overflows: run.overflows, violations: bad.length, first: bad.slice(0, 3) }));
  process.exit(run.overflows === 0 ? 2 : bad.length > 0 ? 1 : 0);
}

// ----------------------------------------------------------------- parent

const modes = options.mode === undefined ? ["development", "production"] : [options.mode];
for (const mode of modes) {
  if (mode !== "development" && mode !== "production") throw new Error("--mode must be development or production");
}
const src = path.resolve(root, options.src ?? "src");
const names = options.only === undefined ? Object.keys(witnesses) : [options.only];
for (const name of names) if (!(name in witnesses)) throw new Error(`unknown witness ${name}`);

const { build } = await import("esbuild");
const out = path.join(root, ".cache/stack-commit-points");
mkdirSync(out, { recursive: true });

let worst = 0;
for (const mode of modes) {
  const development = mode === "development";
  // The release options, plus the host registers the witnesses inspect.
  const result = await build({
    stdin: {
      contents: 'export * from "./index"; export { hold, queueLength } from "./host";',
      resolveDir: src,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    define: { __DEV__: String(development), __STATS__: "false" },
    minify: !development,
    minifySyntax: true,
    legalComments: "none",
    write: false,
  });
  const file = path.join(out, `${process.pid}-${mode}.mjs`);
  writeFileSync(file, result.outputFiles[0].contents);
  for (const name of names) {
    const child = spawnSync(process.execPath, [self, "--child", name, "--bundle", file], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const status = child.status ?? 2;
    const verdict = status === 0 ? "held" : status === 1 ? "WEDGED" : "ERROR";
    console.log(`${verdict} ${name} (${mode}) ${(child.stdout || child.stderr || child.signal || "").trim().split("\n").at(-1)}`);
    worst = Math.max(worst, status === 0 ? 0 : status === 1 ? 1 : 2);
  }
}
process.exit(worst);
