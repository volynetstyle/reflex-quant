// Programs of the tracking lab. Each runs on real reflex-quant through `record` (tracking.ts); the
// lab draws what the runtime's own nodes hold after every read. `expect` lists the kinds of the
// drawn consumers' reads in a step (`Name.kind` when two are drawn): the page's prose relies on
// them, and site/scripts/validate-tracking.mjs fails if the runtime does something else.
import type { Lab, LabStep } from "./tracking";

export interface Scenario {
  id: string;
  title: string;
  /** Contract items it shows (CONTRACT.md). */
  tags: string[];
  blurb: string;
  code: string;
  /** Consumers whose dependency lists are drawn. */
  lists: string[];
  /** Sources whose subscribers and slot are drawn. */
  sources?: string[];
  /** Draw edge and source versions. */
  versions?: boolean;
  build: (lab: Lab) => LabStep[];
}

const letters = (s: string) => s.split("");
/** A program that reads `src[k]` for every key of `order`, in that order. */
function reader(lab: Lab, name: string, order: unknown, src: Record<string, unknown>) {
  return lab.computed(name, (r) => {
    let t = 0;
    for (const k of r(order) as string[]) t += r(src[k]) as number;
    return t;
  });
}

export const SCENARIOS: Scenario[] = [
  {
    id: "branch",
    title: "Branch switch",
    tags: ["T1", "S2"],
    blurb: "The dependency list is whatever the last run read. A branch that starts reading a source gets an edge for it; a branch that stops loses it when the run succeeds.",
    code: `const full = signal(false);
const first = signal("Ada");
const last = signal("Lovelace");
const name = computed(() =>
  get(full) ? \`\${get(first)} \${get(last)}\` : get(first));`,
    lists: ["name"],
    build(lab) {
      const { get, set } = lab.api;
      const full = lab.signal("full", false), first = lab.signal("first", "Ada"), last = lab.signal("last", "Lovelace");
      const name = lab.computed("name", (r) => (r(full) ? `${r(first)} ${r(last)}` : r(first)));
      return [
        { label: "get(name)", run: () => get(name), expect: "new new" },
        { label: "set(full, true); get(name)", run: () => (set(full, true), get(name)), expect: "hit hit new" },
        { label: 'set(last, "Byron"); get(name)', run: () => (set(last, "Byron"), get(name)), expect: "hit hit hit" },
        { label: "set(full, false); get(name)", run: () => (set(full, false), get(name)), expect: "hit hit" },
        { label: 'set(last, "King"); get(name)', run: () => (set(last, "King"), get(name)), expect: "" },
      ];
    },
  },
  {
    id: "reorder",
    title: "Reorders",
    tags: ["S1", "S2", "S3"],
    blurb: "The same six sources read in a new order. No edge is created or removed: each one moves. A swap costs one out-of-place read, a rotation two, a source moved to the front is found among the last two edges, and one moved back is found a few edges ahead.",
    code: `const src = { a: signal(0), b: signal(0), /* … */ f: signal(0) };
const order = signal("abcdef");
const view = computed(() => {
  for (const k of get(order)) get(src[k]);
});`,
    lists: ["view"],
    build(lab) {
      const { get, set } = lab.api;
      const src = Object.fromEntries(letters("abcdef").map((k) => [k, lab.signal(k, 0)]));
      const order = lab.signal("order", letters("abcdef"));
      const view = reader(lab, "view", order, src);
      const to = (s: string) => () => (set(order, letters(s)), get(view));
      return [
        { label: "get(view)", run: () => get(view), expect: "new new new new new new new" },
        { label: "set(a, 1); get(view)  // same order", run: () => (set(src.a, 1), get(view)), expect: "hit hit hit hit hit hit hit" },
        { label: 'set(order, "acbdef")  // swap b, c', run: to("acbdef"), expect: "hit hit skip hit hit hit hit" },
        { label: 'set(order, "cbdefa")  // rotate', run: to("cbdefa"), expect: "hit skip defer hit hit hit hit" },
        { label: 'set(order, "acbdef")  // a to the front', run: to("acbdef"), expect: "hit tail hit hit hit hit hit" },
        { label: 'set(order, "fedbca")  // reverse', run: to("fedbca"), expect: "hit tail tail tail tail skip hit" },
        { label: 'set(order, "debcaf")  // f back to the end', run: to("debcaf"), expect: "hit skip defer hit hit hit hit" },
      ];
    },
  },
  {
    id: "edits",
    title: "Insert and delete",
    tags: ["T1", "S2"],
    blurb: "Dropping a source is a rotation of the rest: two out-of-place reads, and the dropped edge, sent to the end, is cut when the run succeeds. A source nobody reads is new without any search.",
    code: `const src = { a: signal(0), /* … */ f: signal(0), x: signal(0), y: signal(0) };
const order = signal("abcdef");
const view = computed(() => {
  for (const k of get(order)) get(src[k]);
});`,
    lists: ["view"],
    build(lab) {
      const { get, set } = lab.api;
      const src = Object.fromEntries(letters("abcdefxy").map((k) => [k, lab.signal(k, 0)]));
      const order = lab.signal("order", letters("abcdef"));
      const view = reader(lab, "view", order, src);
      const to = (s: string) => () => (set(order, letters(s)), get(view));
      return [
        { label: "get(view)", run: () => get(view), expect: "new new new new new new new" },
        { label: 'set(order, "abdef")  // drop c', run: to("abdef"), expect: "hit hit hit skip defer hit" },
        { label: 'set(order, "abxdef")  // insert x', run: to("abxdef"), expect: "hit hit hit new hit hit hit" },
        { label: 'set(order, "abxyef")  // d becomes y', run: to("abxyef"), expect: "hit hit hit hit new skip defer" },
      ];
    },
  },
  {
    id: "versions",
    title: "Versions and repeats",
    tags: ["T2", "P5"],
    blurb: "An edge stores the version of its source when the run first read it. Reading the source again in the same run changes nothing, not even after a write in between: the run saw the old value, so it owes another run.",
    code: `const a = signal(1);
const b = signal(0);
const c = computed(() => {
  const x = get(a);          // observes a
  if (x === 1) set(a, 2);    // a changes during the run
  get(a);                    // the cursor's own source again
  get(b);
  return x + get(a);         // read earlier in this run
});`,
    lists: ["c"],
    sources: ["a", "b"],
    versions: true,
    build(lab) {
      const { get, set } = lab.api;
      const a = lab.signal("a", 1), b = lab.signal("b", 0);
      const c = lab.computed("c", (r) => {
        const x = r(a) as number;
        if (x === 1) set(a, 2);
        r(a);
        r(b);
        return x + (r(a) as number);
      });
      return [
        { label: "get(c)  // 1 + 2", run: () => get(c), expect: "new repeat new repeat" },
        { label: "get(c)  // owed: runs again, 2 + 2", run: () => get(c), expect: "hit repeat hit repeat" },
        { label: "get(c)  // up to date: no run", run: () => get(c), expect: "" },
      ];
    },
  },
  {
    id: "shuffle",
    title: "Shuffle past the budget",
    tags: ["S3"],
    blurb: "When the bounded scans cannot settle a read, the source's subscribers do. If this list's edge is the first one there, the run marks its unread edges once, and every later out-of-place read is one lookup and one move.",
    code: `const s = Array.from({ length: 16 }, (_, i) => signal(i));
const order = signal([0, 1, 2, /* … */ 15]);
const sum = computed(() =>
  get(order).reduce((t, i) => t + get(s[i]), 0));`,
    lists: ["sum"],
    build(lab) {
      const { get, set } = lab.api;
      const keys = Array.from({ length: 16 }, (_, i) => `s${i}`);
      const src = Object.fromEntries(keys.map((k) => [k, lab.signal(k, 0)]));
      const order = lab.signal("order", keys);
      const sum = reader(lab, "sum", order, src);
      const perm = [11, 3, 7, 0, 14, 5, 9, 1, 12, 6, 15, 2, 8, 13, 4, 10].map((i) => `s${i}`);
      return [
        { label: "get(sum)", run: () => get(sum), expect: "new new new new new new new new new new new new new new new new new" },
        { label: "set(order, [11, 3, 7, 0, 14, …])", run: () => (set(order, perm), get(sum)), expect: "hit move move move hit move move move hit move move move hit move move hit hit" },
      ];
    },
  },
  {
    id: "shared",
    title: "Shared sources",
    tags: ["S1", "S3"],
    blurb: "Here every source has nine other readers, created first. A scan of this list alone can still prove a source absent; one or two other readers prove it from the source's side. When a lookup through the subscribers runs out of budget, the run indexes its edges into the sources' slots, once, and the slot answers every later read.",
    code: `const p = Array.from({ length: 12 }, (_, i) => signal(i));
const q = signal(0);
// nine readers of every p, and two of q, created first
const others = Array.from({ length: 9 }, () =>
  computed(() => p.reduce((t, x) => t + get(x), 0)));
const qa = computed(() => get(q)), qb = computed(() => get(q));
const order = signal(["p0", "p1", /* … */ "p11"]);
const C = computed(() => get(order).reduce((t, k) => t + get(src[k]), 0));`,
    lists: ["C"],
    sources: Array.from({ length: 12 }, (_, i) => `p${i}`).concat("q"),
    build(lab) {
      const { get, set } = lab.api;
      const keys = Array.from({ length: 12 }, (_, i) => `p${i}`);
      const src: Record<string, unknown> = Object.fromEntries(keys.map((k) => [k, lab.signal(k, 0)]));
      src.q = lab.signal("q", 0);
      const others = Array.from({ length: 9 }, (_, j) => lab.computed(`R${j + 1}`, (r) => keys.reduce((t, k) => t + (r(src[k]) as number), 0)));
      const qa = lab.computed("qa", (r) => r(src.q)), qb = lab.computed("qb", (r) => r(src.q));
      const order = lab.signal("order", keys);
      const C = reader(lab, "C", order, src);
      const perm = [9, 2, 6, 0, 11, 4, 8, 1, 10, 3, 7, 5].map((i) => `p${i}`).concat("q");
      return [
        { label: "others.forEach(get); get(qa); get(qb)", run: () => { others.forEach((o) => get(o)); get(qa); get(qb); }, expect: "" },
        { label: "get(C)", run: () => get(C), expect: "new new new new new new new new new new new new new" },
        { label: 'set(order, [...p, "q"])  // C reads q too', run: () => (set(order, keys.concat("q")), get(C)), expect: "hit hit hit hit hit hit hit hit hit hit hit hit hit new" },
        { label: 'set(order, ["p9", "p2", "p6", …])', run: () => (set(order, perm), get(C)), expect: "hit move move move hit move move move hit move hit move hit hit" },
      ];
    },
  },
  {
    id: "nesting",
    title: "Nesting",
    tags: ["T3", "S6"],
    blurb: "O and I read the same shared sources in shuffled orders, and O reads I halfway. Both index. I's index takes the slots O's index holds: O's cells go on the work stack, and come back when I's run ends, before O's next read.",
    code: `// p0 … p11 with nine other readers each, as in "Shared sources"
const I = computed(() => get(orderI).reduce((t, k) => t + get(p[k]), 0));
const O = computed(() => {
  let t = 0;
  for (const k of get(orderO)) t += k === "I" ? get(I) : get(p[k]);
  return t;
});`,
    lists: ["O", "I"],
    sources: Array.from({ length: 12 }, (_, i) => `p${i}`),
    build(lab) {
      const { get, set } = lab.api;
      const keys = Array.from({ length: 12 }, (_, i) => `p${i}`);
      const src: Record<string, unknown> = Object.fromEntries(keys.map((k) => [k, lab.signal(k, 0)]));
      const others = Array.from({ length: 9 }, (_, j) => lab.computed(`R${j + 1}`, (r) => keys.reduce((t, k) => t + (r(src[k]) as number), 0)));
      const orderI = lab.signal("orderI", keys), orderO = lab.signal("orderO", [...keys.slice(0, 6), "I", ...keys.slice(6)]);
      const I = reader(lab, "I", orderI, src);
      src.I = I;
      const O = reader(lab, "O", orderO, src);
      const pI = [9, 4, 0, 11, 2, 7, 1, 10, 5, 3, 8, 6].map((i) => `p${i}`);
      const pO = [9, 2, 6, 0, 11, 4].map((i) => `p${i}`).concat("I", [8, 1, 10, 3, 7, 5].map((i) => `p${i}`));
      return [
        { label: "others.forEach(get); get(O)", run: () => { others.forEach((o) => get(o)); get(O); }, expect: "O.new O.new O.new O.new O.new O.new O.new I.new I.new I.new I.new I.new I.new I.new I.new I.new I.new I.new I.new I.new O.new O.new O.new O.new O.new O.new O.new" },
        { label: "set(orderI, …); set(orderO, …); get(O)", run: () => { set(orderI, pI); set(orderO, pO); get(O); }, expect: "O.hit O.move O.move O.move O.hit O.move O.move I.hit I.move I.move I.hit I.move I.move I.move I.hit I.move I.move I.hit I.move I.hit O.move O.move O.hit O.move O.hit O.move O.hit" },
      ];
    },
  },
  {
    id: "failure",
    title: "Failure",
    tags: ["R", "S5"],
    blurb: "A run that throws commits nothing. Its list keeps what it read and what the last success read beyond that point: both still wake it. An edge born in a failed run is tentative, and a later failed run drops it, so repeated failures do not pile up edges.",
    code: `const a = signal(1), b = signal(2), c = signal(3);
const x = signal(0), y = signal(0);
const mode = signal("ok");
const v = computed(() => {
  const t = get(a), m = get(mode);
  if (m === "x") { get(x); throw new Error("x"); }
  if (m === "y") { get(y); throw new Error("y"); }
  return t + get(b) + get(c);
});`,
    lists: ["v"],
    build(lab) {
      const { get, set, dispose } = lab.api;
      const s = Object.fromEntries(letters("abcxy").map((k) => [k, lab.signal(k, 1)]));
      const mode = lab.signal("mode", "ok");
      const v = lab.computed("v", (r) => {
        const t = r(s.a) as number, m = r(mode);
        if (m === "x") { r(s.x); throw new Error("x"); }
        if (m === "y") { r(s.y); throw new Error("y"); }
        return t + (r(s.b) as number) + (r(s.c) as number);
      });
      return [
        { label: "get(v)", run: () => get(v), expect: "new new new new" },
        { label: 'set(mode, "x"); get(v)  // throws', run: () => (set(mode, "x"), get(v)), expect: "hit hit new" },
        { label: 'set(mode, "y"); get(v)  // throws again', run: () => (set(mode, "y"), get(v)), expect: "hit hit new" },
        { label: 'set(mode, "ok"); get(v)', run: () => (set(mode, "ok"), get(v)), expect: "hit hit skip defer" },
        { label: "dispose(v)", run: () => dispose(v), expect: "" },
      ];
    },
  },
];
