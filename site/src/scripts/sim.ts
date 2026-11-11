// Step recorders for the stack visualization. `quant` mirrors reflex-quant's kernel and host
// (write → mark, FIFO drain, check → pull → verify, exec with exact re-tracking; simplified:
// no failures, no batching, no slots). `naive` is a run-on-read runtime with recursive push.
// Each scenario is written once against `Api`, so test/stackviz-sim.mjs can run the same
// definition on the real library and compare callback order and console output.

export interface Api {
  signal<T>(name: string, line: string, v: T): unknown;
  computed<T>(name: string, line: string, fn: () => T): unknown;
  effect(name: string, line: string, fn: () => void): unknown;
  get<T>(h: unknown): T;
  set<T>(h: unknown, v: T): void;
  log(...a: unknown[]): void;
}
export interface Scenario {
  id: string;
  title: string;
  code: [string, string][];
  build(api: Api): Record<string, unknown>;
  actions: { line: string; run(api: Api, h: Record<string, unknown>): void }[];
  layout: Record<string, [number, number]>;
  blurb: string;
}
export interface Step {
  line: string;
  stack: { edge: string; why: "sibling" | "way back" }[];
  running: string[];
  frames: { t: string; get?: boolean }[];
  marks: Record<string, string>;
  edges: [string, string][];
  hot?: string;
  log: string[];
  note: string;
}

const fmt = (v: unknown): string =>
  typeof v === "string" ? v : Array.isArray(v) ? `[${v.map(fmt).join(", ")}]` : String(v);

// ------------------------------------------------------------------ quant
type Kind = "signal" | "computed" | "effect";
interface QEdge { from: QNode; to: QNode; ver: number }
interface QNode {
  id: string; kind: Kind; line: string; fn: (() => unknown) | null; value: unknown; ver: number;
  deps: QEdge[]; subs: QEdge[]; stale: boolean; dirty: boolean; woken: boolean; queued: boolean;
}

export function quant(sc: Scenario): Step[] {
  const nodes: QNode[] = [];
  const steps: Step[] = [];
  const stack: { e: QEdge; why: "sibling" | "way back" }[] = [];
  const chain: QNode[] = [];
  const log: string[] = [];
  const touched = new Map<string, string>();
  let rec = false, reads: QEdge[] | null = null, readSet: Set<QNode> | null = null, queue: QNode[] = [], draining = false;
  const L = (e: QEdge) => `${e.from.id}→${e.to.id}`;

  const state = (n: QNode) =>
    touched.get(n.id) === "ran" && !n.stale && !n.dirty ? "ran"
      : n.dirty ? "dirty" : chain.includes(n) ? "running" : touched.get(n.id) === "walk" && n.stale === false ? "walk"
      : n.stale ? "stale" : touched.get(n.id) ?? "";
  const snap = (line: string, note: string, hot?: QEdge | null) => {
    if (!rec) return;
    steps.push({
      line, note, hot: hot ? L(hot) : undefined,
      stack: stack.map((s) => ({ edge: L(s.e), why: s.why })),
      running: chain.map((n) => n.id),
      frames: chain.map((n) => ({ t: `${n.id}: ${sc.code.find(([id]) => id === n.line)?.[1].replace(/^.*?(\(\) =>.*?)\);?\s*(\/\/.*)?$/, "$1") ?? n.id}` })),
      marks: Object.fromEntries(nodes.map((n) => [n.id, state(n)])),
      edges: nodes.flatMap((n) => n.deps.map((e) => [e.from.id, n.id] as [string, string])),
      log: [...log],
    });
  };

  const wake = (w: QNode) => { if (!w.queued) { w.queued = true; queue.push(w); } };

  function mark(first: QEdge) {
    const base = stack.length;
    let e: QEdge | null = first;
    for (;;) {
      while (e) {
        const n = e.to, sibs = e.from.subs, next: QEdge | null = sibs[sibs.indexOf(e) + 1] ?? null;
        if (n.kind === "effect") {
          n.stale = true; wake(n);
          snap(n.line, `${n.id} is an effect: STALE, queued for the host.`, e);
        } else if (!n.stale) {
          n.stale = true;
          if (n.subs.length) {
            if (next) { stack.push({ e: next, why: "sibling" }); snap(n.line, `${n.id} STALE. Going deeper, so the sibling ${L(next)} waits in stack[].`, e); }
            else snap(n.line, `${n.id} STALE. No sibling left: go deeper, stack[] unchanged.`, e);
            e = n.subs[0];
            continue;
          }
          snap(n.line, `${n.id} STALE; nothing reads it.`, e);
        } else snap(n.line, `${n.id} already STALE: skipped.`, e);
        e = next;
      }
      if (stack.length === base) return;
      e = stack.pop()!.e;
      snap(e.to.line, `Pop ${L(e)}: resume at the saved sibling.`, e);
    }
  }

  function write(s: QNode, v: unknown) {
    if (Object.is(s.value, v)) { snap("", `${s.id} already holds ${fmt(v)}: nothing happens.`); return; }
    s.value = v; s.ver++; touched.set(s.id, "changed");
    snap("", `${s.id} = ${fmt(v)}. A write only marks; no user code runs yet.`);
    for (const e of [...s.subs]) {
      const n = e.to;
      if (n.kind === "effect") { n.dirty = true; n.woken = true; wake(n); snap(n.line, `${n.id} reads ${s.id} directly: DIRTY, queued.`, e); }
      else if (n.stale) { n.dirty = true; snap(n.line, `${n.id} was STALE, now DIRTY: ${s.id} surely changed.`, e); }
      else {
        n.dirty = n.stale = true;
        snap(n.line, `${n.id} reads ${s.id}: DIRTY.`, e);
        if (n.subs.length) mark(n.subs[0]);
      }
    }
    if (!draining) drain();
  }

  function drain() {
    draining = true;
    while (queue.length) {
      const w = queue.shift()!;
      w.queued = false;
      run(w);
    }
    draining = false;
  }

  function run(w: QNode) {
    if (!w.stale && !w.woken) return;
    const wasStale = w.stale;
    w.stale = false; w.woken = false;
    if (wasStale) {
      touched.set(w.id, "walk");
      snap(w.line, `The host takes ${w.id}. A source of it might have changed: check them before running.`);
      check(w);
    } else snap(w.line, `The host takes ${w.id}. It was woken by a signal directly, so no check is needed.`);
    if (!w.dirty) { touched.set(w.id, ""); snap(w.line, `Every source of ${w.id} is unchanged: it does not run (cutoff).`); return; }
    exec(w);
  }

  function check(w: QNode) {
    let i = 0;
    if (!w.dirty)
      for (; i < w.deps.length; i++) {
        const e = w.deps[i], s = e.from;
        if (s.stale || s.dirty) pull(s);
        if (s.ver !== e.ver) { w.dirty = true; i++; break; }
      }
    for (; i < w.deps.length; i++) { const s = w.deps[i].from; if (s.stale || s.dirty) pull(s); }
  }

  function pull(n: QNode) {
    if (n.dirty) return exec(n);
    if (n.stale) verify(n);
  }

  function verify(root: QNode) {
    root.stale = false; touched.set(root.id, "walk");
    const base = stack.length;
    let n = root, i = 0;
    for (;;) {
      let settled = false;
      while (i < n.deps.length) {
        const e = n.deps[i], s = e.from;
        if (s.stale || s.dirty) {
          if (!s.dirty) {
            s.stale = false; touched.set(s.id, "walk");
            stack.push({ e, why: "way back" });
            snap(s.line, `${s.id} is only STALE: remember ${L(e)} as the way back, go down into ${s.id}.`, e);
            n = s; i = 0;
            continue;
          }
          exec(s);
        }
        if (s.ver !== e.ver) { exec(n); settled = true; break; }
        i++;
      }
      if (!settled) { touched.set(n.id, "clean"); snap(n.line, `No source of ${n.id} changed: ${n.id} is fresh without running.`); }
      for (;;) {
        if (stack.length === base) return;
        const up = stack.pop()!.e;
        n = up.to;
        if (up.from.ver === up.ver) { i = n.deps.indexOf(up) + 1; snap(n.line, `Pop ${L(up)}: ${up.from.id} kept its value, continue with ${n.id}'s next source.`, up); break; }
        snap(n.line, `Pop ${L(up)}: ${up.from.id} changed, so ${n.id} must run.`, up);
        exec(n);
      }
    }
  }

  function exec(n: QNode) {
    n.stale = n.dirty = false;
    chain.push(n);
    snap(n.line, chain.length > 1
      ? `${n.id} runs inside ${chain[chain.length - 2].id}: it read ${n.id}, which was not fresh yet. Real nesting, one level.`
      : `${n.id} runs, alone: no other user closure beneath it.`);
    const prevReads = reads, prevSet = readSet;
    reads = []; readSet = new Set();
    const before = n.deps.map((e) => e.from.id);
    const v = n.fn!();
    const now = reads;
    reads = prevReads; readSet = prevSet;
    // Exact tracking: edges follow this run's reads; unread ones are removed.
    for (const e of n.deps) if (!now.includes(e)) e.from.subs.splice(e.from.subs.indexOf(e), 1);
    n.deps = now;
    const after = n.deps.map((e) => e.from.id);
    const added = after.filter((x) => !before.includes(x)), dropped = before.filter((x) => !after.includes(x));
    touched.set(n.id, "ran");
    let note: string;
    if (n.kind === "effect") note = `${n.id} done.`;
    else {
      const changed = !Object.is(v, n.value);
      if (changed) { n.value = v; n.ver++; }
      note = changed ? `${n.id} → ${fmt(v)}.` : `${n.id} → ${fmt(v)}, the same value: its version stays, so nothing below has to run (cutoff).`;
    }
    if (rec && (added.length || dropped.length))
      note += ` Dependencies change:${added.length ? ` now reads ${added.join(", ")}` : ""}${added.length && dropped.length ? ";" : ""}${dropped.length ? ` no longer reads ${dropped.join(", ")}` : ""}.`;
    snap(n.line, note);
    chain.pop();
  }

  function read(x: QNode): unknown {
    if (x.kind === "computed" && (x.stale || x.dirty)) pull(x);
    const a = chain[chain.length - 1];
    if (a && reads && readSet && !readSet.has(x)) {
      readSet.add(x);
      let e = a.deps.find((d) => d.from === x);
      if (!e) { e = { from: x, to: a, ver: x.ver }; x.subs.push(e); }
      else e.ver = x.ver;
      reads.push(e);
    }
    return x.value;
  }

  const api: Api = {
    signal: (id, line, v) => { const n = node(id, "signal", line, null); n.value = v; return n; },
    computed: (id, line, fn) => { const n = node(id, "computed", line, fn); n.dirty = true; return n; },
    effect: (id, line, fn) => { const n = node(id, "effect", line, fn); exec(n); return n; },
    get: (h) => read(h as QNode) as never,
    set: (h, v) => write(h as QNode, v),
    log: (...a) => { if (rec) log.push(a.map(fmt).join(" ")); },
  };
  function node(id: string, kind: Kind, line: string, fn: (() => unknown) | null): QNode {
    const n: QNode = { id, kind, line, fn, value: undefined, ver: 0, deps: [], subs: [], stale: false, dirty: false, woken: false, queued: false };
    nodes.push(n);
    return n;
  }

  const h = sc.build(api);
  rec = true;
  snap("", "Setup done: every computed and effect has run once. Now the writes.");
  for (const act of sc.actions) {
    touched.clear();
    const at = steps.length;
    act.run(api, h);
    for (let k = at; k < steps.length; k++) if (!steps[k].line) steps[k].line = act.line;
    steps.push({ ...steps[steps.length - 1], line: act.line, hot: undefined, stack: [], running: [], frames: [], note: steps[steps.length - 1].note.startsWith("Done") ? steps[steps.length - 1].note : `Done with this write. ${summary(steps.slice(at))}` });
  }
  return steps;
}

function summary(ss: Step[]): string {
  const ran = [...new Set(ss.filter((s) => / runs/.test(s.note)).map((s) => s.note.split(" ")[0]))];
  const peak = Math.max(0, ...ss.map((s) => s.stack.length));
  const depth = Math.max(0, ...ss.map((s) => s.running.length));
  return `${ran.length ? `Ran: ${ran.join(", ")}.` : "Nothing ran."} Peak stack[]: ${peak}; deepest user-closure nesting: ${depth}.`;
}

// ------------------------------------------------------------------ naive
interface NNode { id: string; kind: Kind; line: string; fn: (() => unknown) | null; value: unknown; deps: Set<NNode>; subs: Set<NNode>; stale: boolean }

export function naive(sc: Scenario): Step[] {
  const nodes: NNode[] = [];
  const steps: Step[] = [];
  const frames: { t: string; get?: boolean }[] = [];
  const running: NNode[] = [];
  const log: string[] = [];
  const touched = new Map<string, string>();
  let rec = false;
  let queue: NNode[] = [];
  const fnText = (n: NNode) => `${n.id}: ${sc.code.find(([id]) => id === n.line)?.[1].replace(/^.*?(\(\) =>.*?)\);?\s*(\/\/.*)?$/, "$1") ?? n.id}`;
  const snap = (line: string, note: string) => {
    if (!rec) return;
    steps.push({
      line, note, stack: [], running: running.map((n) => n.id), frames: frames.map((f) => ({ ...f })),
      marks: Object.fromEntries(nodes.map((n) => [n.id, running.includes(n) ? "running" : n.stale ? "stale" : touched.get(n.id) ?? ""])),
      edges: nodes.flatMap((n) => [...n.deps].map((d) => [d.id, n.id] as [string, string])),
      log: [...log],
    });
  };
  function markN(n: NNode) {
    for (const s of n.subs) {
      if (s.stale) continue;
      s.stale = true;
      if (s.kind === "effect") { queue.push(s); frames.push({ t: `queue ${s.id}`, get: true }); snap(s.line, `${s.id} queued, ${frames.filter((f) => !f.get).length} frames deep.`); frames.pop(); continue; }
      frames.push({ t: `mark(${s.id})` });
      snap(s.line, `${s.id} stale. Recursive push: one more JS frame.`);
      markN(s);
      frames.pop();
    }
  }
  function exec(n: NNode) {
    for (const d of n.deps) d.subs.delete(n);
    n.deps.clear();
    n.stale = false;
    running.push(n); frames.push({ t: fnText(n) });
    snap(n.line, `${n.id} runs, ${running.length} user closure${running.length > 1 ? "s" : ""} deep.`);
    const v = n.fn!();
    if (n.kind !== "effect") n.value = v;
    touched.set(n.id, "ran");
    running.pop(); frames.pop();
  }
  function read(x: NNode) {
    if (x.kind === "computed" && x.stale) { frames.push({ t: `get(${x.id}) → stale, run it inside`, get: true }); exec(x); frames.pop(); }
    const a = running[running.length - 1];
    if (a) { a.deps.add(x); x.subs.add(a); }
    return x.value;
  }
  const api: Api = {
    signal: (id, line, v) => { const n = mk(id, "signal", line, null); n.value = v; return n; },
    computed: (id, line, fn) => { const n = mk(id, "computed", line, fn); n.stale = true; return n; },
    effect: (id, line, fn) => { const n = mk(id, "effect", line, fn); exec(n); return n; },
    get: (h) => read(h as NNode) as never,
    set: (h, v) => {
      const s = h as NNode;
      if (Object.is(s.value, v)) { snap("", `${s.id} already holds ${fmt(v)}: nothing happens.`); return; }
      s.value = v; touched.set(s.id, "changed");
      frames.push({ t: `set(${s.id})` });
      snap("", `${s.id} = ${fmt(v)}.`);
      markN(s);
      frames.pop();
      const q = queue; queue = [];
      for (const w of q) if (w.stale) exec(w);
    },
    log: (...a) => { if (rec) { log.push(a.map(fmt).join(" ")); snap(running[running.length - 1]?.line ?? "", `Logged after a nesting of ${running.length}.`); } },
  };
  function mk(id: string, kind: Kind, line: string, fn: (() => unknown) | null): NNode {
    const n: NNode = { id, kind, line, fn, value: undefined, deps: new Set(), subs: new Set(), stale: false };
    nodes.push(n);
    return n;
  }
  const h = sc.build(api);
  rec = true;
  snap("", "Setup done. Now the writes.");
  for (const act of sc.actions) {
    touched.clear();
    const at = steps.length;
    act.run(api, h);
    for (let k = at; k < steps.length; k++) if (!steps[k].line) steps[k].line = act.line;
    const ss = steps.slice(at);
    const depth = Math.max(0, ...ss.map((s) => s.running.length));
    const ran = [...new Set(ss.filter((s) => / runs,/.test(s.note)).map((s) => s.note.split(" ")[0]))];
    steps.push({ ...steps[steps.length - 1], line: act.line, frames: [], running: [], note: `Done with this write. ${ran.length ? `Ran: ${ran.join(", ")}.` : "Nothing ran."} Deepest user-closure nesting: ${depth}.` });
  }
  return steps;
}

// ------------------------------------------------------------------ scenarios
export const SCENARIOS: Scenario[] = [
  {
    id: "fan",
    title: "Fan-out",
    blurb: "One write, two effects, a shared computed.",
    code: [
      ["L1", "const a = signal(1);"],
      ["L2", "const b = computed(() => get(a) * 2);"],
      ["L3", "const c = computed(() => get(b) + 1);"],
      ["L4", "const d = computed(() => get(b) - 1);"],
      ["L5", "const e = computed(() => get(c) * 10);"],
      ["L6", 'effect(() => log("e =", get(e)));   // W1'],
      ["L7", 'effect(() => log("d =", get(d)));   // W2'],
      ["L8", ""],
      ["L9", "set(a, 2);"],
    ],
    build(q) {
      const a = q.signal("a", "L1", 1);
      const b = q.computed("b", "L2", () => q.get<number>(a) * 2);
      const c = q.computed("c", "L3", () => q.get<number>(b) + 1);
      const d = q.computed("d", "L4", () => q.get<number>(b) - 1);
      const e = q.computed("e", "L5", () => q.get<number>(c) * 10);
      q.effect("W1", "L6", () => q.log("e =", q.get(e)));
      q.effect("W2", "L7", () => q.log("d =", q.get(d)));
      return { a };
    },
    actions: [{ line: "L9", run: (q, h) => q.set(h.a, 2) }],
    layout: { a: [40, 100], b: [150, 100], c: [270, 45], d: [270, 155], e: [390, 45], W1: [510, 45], W2: [390, 155] },
  },
  {
    id: "branch",
    title: "Dynamic branch",
    blurb: "Dependencies follow the branch that actually ran.",
    code: [
      ["L1", "const full = signal(false);"],
      ["L2", 'const first = signal("Ada");'],
      ["L3", 'const last = signal("Lovelace");'],
      ["L4", "const name = computed(() =>"],
      ["L5", "  get(full) ? get(first) + ' ' + get(last) : get(first));"],
      ["L6", "effect(() => log(get(name)));   // W"],
      ["L7", ""],
      ["L8", 'set(last, "Byron");   // not read: nothing runs'],
      ["L9", "set(full, true);      // name now reads last"],
      ["L10", 'set(last, "King");    // now it matters'],
      ["L11", "set(full, false);     // last is dropped again"],
      ["L12", 'set(last, "Brown");   // nothing runs'],
    ],
    build(q) {
      const full = q.signal("full", "L1", false);
      const first = q.signal("first", "L2", "Ada");
      const last = q.signal("last", "L3", "Lovelace");
      const name = q.computed("name", "L5", () => (q.get(full) ? `${q.get(first)} ${q.get(last)}` : q.get<string>(first)));
      q.effect("W", "L6", () => q.log(q.get(name)));
      return { full, last };
    },
    actions: [
      { line: "L8", run: (q, h) => q.set(h.last, "Byron") },
      { line: "L9", run: (q, h) => q.set(h.full, true) },
      { line: "L10", run: (q, h) => q.set(h.last, "King") },
      { line: "L11", run: (q, h) => q.set(h.full, false) },
      { line: "L12", run: (q, h) => q.set(h.last, "Brown") },
    ],
    layout: { full: [60, 40], first: [60, 110], last: [60, 180], name: [250, 110], W: [430, 110] },
  },
  {
    id: "views",
    title: "Switching subtrees",
    blurb: "A view picks one of two subtrees; the unread one stays cold.",
    code: [
      ["L1", 'const mode = signal("list");'],
      ["L2", 'const items = signal(["a", "b"]);'],
      ["L3", "const count = computed(() => get(items).length);"],
      ["L4", 'const list = computed(() => get(items).join(", "));'],
      ["L5", 'const summary = computed(() => get(count) + " items");'],
      ["L6", "const view = computed(() =>"],
      ["L7", '  get(mode) === "list" ? get(list) : get(summary));'],
      ["L8", "effect(() => log(get(view)));   // W"],
      ["L9", ""],
      ["L10", 'set(items, ["a", "b", "c"]);'],
      ["L11", 'set(mode, "summary");'],
      ["L12", 'set(items, ["x"]);       // list is not read now'],
    ],
    build(q) {
      const mode = q.signal("mode", "L1", "list");
      const items = q.signal("items", "L2", ["a", "b"]);
      const count = q.computed("count", "L3", () => q.get<string[]>(items).length);
      const list = q.computed("list", "L4", () => q.get<string[]>(items).join(", "));
      const summary = q.computed("summary", "L5", () => `${q.get(count)} items`);
      const view = q.computed("view", "L7", () => (q.get(mode) === "list" ? q.get(list) : q.get(summary)));
      q.effect("W", "L8", () => q.log(q.get(view)));
      return { mode, items };
    },
    actions: [
      { line: "L10", run: (q, h) => q.set(h.items, ["a", "b", "c"]) },
      { line: "L11", run: (q, h) => q.set(h.mode, "summary") },
      { line: "L12", run: (q, h) => q.set(h.items, ["x"]) },
    ],
    layout: { mode: [50, 40], items: [50, 160], count: [200, 200], list: [200, 120], summary: [340, 200], view: [400, 80], W: [530, 80] },
  },
  {
    id: "mesh",
    title: "Branchy graph",
    blurb: "Fan-out, diamonds and cutoff in one write.",
    code: [
      ["L1", "const a = signal(1);"],
      ["L2", "const b = computed(() => get(a) + 1);"],
      ["L3", "const c = computed(() => get(a) * 2);"],
      ["L4", "const p = computed(() => get(a) % 2);   // parity"],
      ["L5", "const d = computed(() => get(b) + get(c));"],
      ["L6", "const e = computed(() => get(b) * 10);"],
      ["L7", "const f = computed(() => get(c) - 1);"],
      ["L8", "const g = computed(() => get(d) + get(e) + get(f));"],
      ["L9", 'effect(() => log("g =", get(g)));   // W1'],
      ["L10", 'effect(() => log("f =", get(f)));   // W2'],
      ["L11", 'effect(() => log("p =", get(p)));   // W3'],
      ["L12", ""],
      ["L13", "set(a, 3);   // parity stays 1"],
    ],
    build(q) {
      const a = q.signal("a", "L1", 1);
      const b = q.computed("b", "L2", () => q.get<number>(a) + 1);
      const c = q.computed("c", "L3", () => q.get<number>(a) * 2);
      const p = q.computed("p", "L4", () => q.get<number>(a) % 2);
      const d = q.computed("d", "L5", () => q.get<number>(b) + q.get<number>(c));
      const e = q.computed("e", "L6", () => q.get<number>(b) * 10);
      const f = q.computed("f", "L7", () => q.get<number>(c) - 1);
      const g = q.computed("g", "L8", () => q.get<number>(d) + q.get<number>(e) + q.get<number>(f));
      q.effect("W1", "L9", () => q.log("g =", q.get(g)));
      q.effect("W2", "L10", () => q.log("f =", q.get(f)));
      q.effect("W3", "L11", () => q.log("p =", q.get(p)));
      return { a };
    },
    actions: [{ line: "L13", run: (q, h) => q.set(h.a, 3) }],
    layout: { a: [40, 120], b: [150, 50], c: [150, 130], p: [150, 205], d: [270, 90], e: [270, 20], f: [270, 160], g: [390, 90], W1: [510, 90], W2: [390, 175], W3: [270, 230] },
  },
];
