// Collect JIT feedback against a public-API production bundle. This is a
// workload, not a test that pins compiler heuristics. Trace runs are not
// timing runs. Examples (after build):
// node --trace-deopt --trace-generalization --trace-elements-transitions \
//   bench/feedback.mjs .cache/release/inspect.js indexed 3000 12000
// node --trace-turbo --trace-turbo-filter=unindex --trace-turbo-path=<dir> \
//   bench/feedback.mjs .cache/release/inspect.js indexed 2000 5000
import path from "node:path";
import { pathToFileURL } from "node:url";

const [bundle, profile = "indexed", warm = "3000", count = "12000"] =
  process.argv.slice(2);
const profiles = ["indexed", "deep", "fanout", "lifecycle", "values", "errors"];
if (!bundle || !profiles.includes(profile)) {
  throw new Error(
    `usage: node bench/feedback.mjs <bundle> <${profiles.join("|")}> [warmup] [steps]`,
  );
}
const warmup = Number(warm);
const steps = Number(count);
if (![warmup, steps].every(Number.isSafeInteger) || warmup < 0 || steps < 1) {
  throw new Error(
    "warmup must be a nonnegative integer and steps a positive integer",
  );
}
const { signal, computed, get, set, effect, dispose } = await import(
  pathToFileURL(path.resolve(bundle)).href
);
let step;
if (profile === "indexed") {
  const width = 600;
  const tick = signal(0);
  const sources = Array.from({ length: width }, (_, i) => signal(i));
  const sum = () => {
    const t = get(tick);
    let value = 0;
    for (let i = 0; i < width; i++)
      value += get(sources[t & 1 ? width - 1 - i : i]);
    return value;
  };
  const branches = Array.from({ length: 8 }, () => {
    const inner = computed(sum);
    return computed(() => sum() + get(inner) + get(sources[0]));
  });
  const root = computed(() => {
    get(tick);
    return branches.reduce((sum, c) => sum + get(c), 0);
  });
  get(root);
  const expected = 8 * width * (width - 1);
  step = (i) => {
    set(tick, i & 1);
    const value = get(root);
    if (value !== expected) throw new Error("indexed checksum");
    return value;
  };
} else if (profile === "deep") {
  const source = signal(0);
  let tip = computed(() => get(source));
  get(tip);
  for (let i = 0; i < 1200; i++) {
    const below = tip;
    tip = computed(() => get(below) + 1);
    get(tip);
    get(computed(() => get(below)));
  }
  step = (i) => {
    set(source, i & 1);
    const value = get(tip);
    if (value !== 1200 + (i & 1)) throw new Error("deep checksum");
    return value;
  };
} else if (profile === "fanout") {
  const source = signal(0);
  const branches = Array.from({ length: 1000 }, () =>
    computed(() => get(source) + 1),
  );
  const root = computed(() => branches.reduce((sum, c) => sum + get(c), 0));
  get(root);
  step = (i) => {
    set(source, i & 255);
    const value = get(root);
    if (value !== 1000 * ((i & 255) + 1)) throw new Error("fanout checksum");
    return value;
  };
} else if (profile === "lifecycle") {
  const sources = Array.from({ length: 4 }, (_, i) => signal(i));
  step = () => {
    let sum = 0;
    const effects = Array.from({ length: 100 }, () =>
      effect(() => {
        for (const source of sources) sum += get(source);
      }),
    );
    for (const e of effects) dispose(e);
    if (sum !== 600) throw new Error("lifecycle checksum");
    return sum;
  };
} else if (profile === "values") {
  const values = [0, 1, NaN, -0, {}, null, "text", Infinity];
  const source = signal(values[0]);
  const c = computed(() => get(source));
  let seen;
  effect(() => {
    seen = get(c);
  });
  step = (i) => {
    const value = values[i % values.length];
    set(source, value);
    if (!Object.is(seen, value)) throw new Error("value mismatch");
    return i & 7;
  };
} else {
  const source = signal(0);
  const c = computed(() => {
    const value = get(source);
    if (value === 1) throw new Error("expected");
    return value;
  });
  effect(() => {
    get(c);
  });
  step = (i) => {
    try {
      set(source, i % 3);
    } catch (error) {
      if (error.message !== "expected") throw error;
    }
    if (i % 3 !== 1 && get(c) !== i % 3) throw new Error("recovery");
    return i % 3;
  };
}
let checksum = 0;
for (let i = 1; i <= warmup; i++)
  checksum = (checksum + Number(step(i))) & 0x3fffffff;
console.log("STEADY_START");
for (let i = warmup + 1; i <= warmup + steps; i++)
  checksum = (checksum + Number(step(i))) & 0x3fffffff;
console.log(
  JSON.stringify({
    profile,
    warmup,
    steps,
    checksum,
    node: process.versions.node,
    v8: process.versions.v8,
  }),
);
