// The tracking lab's engine: it runs real reflex-quant and records, read by read, what the kernel
// did to a consumer's dependency list. A public handle is the graph node itself (src/index.ts), so
// the recorder reads the runtime's own fields (firstDep, nextDep, firstSub, slot, ver, gen). They
// are not an API: this file follows the kernel of the version the site ships, and
// site/scripts/validate-tracking.mjs checks it against the kernel's research counters.
//
// `explain` replays the decision order of src/kernel.ts (`read`, `miss`, `near`, `lookup`,
// `settle`, `slot`) on the nodes as they are just before a read, and says which proof settles it.
// It changes nothing. The recorder brings a computed source up to date with `peek` first, so the
// state it explains is the state the read's tracking half sees.

/** The kernel's constants (src/graph.ts). */
export const UNREAD = -1, SKIPPED = -2, SCAN = 8, TAIL = 2, MASK = 0x3fffffff;

export interface QEdge {
  from: QNode; to: QNode; ver: number; gen: number;
  prevDep: QEdge | null; nextDep: QEdge | null; prevSub: QEdge | null; nextSub: QEdge | null;
}
export interface QNode {
  flags: number; value: unknown; ver: number; fn: unknown;
  firstDep: QEdge | null; lastDep: QEdge | null; firstSub: QEdge | null; slot: QEdge | null; gen: number;
}

/** What a read did to the list. */
export type Kind = "hit" | "repeat" | "new" | "skip" | "defer" | "tail" | "move";
/** Which proof settled it, in the kernel's order. */
export type Proof =
  | "cursor"      // the edge after the cursor is this source's
  | "own"         // the cursor's own source again
  | "empty"       // the first read of an empty list
  | "slot"        // an indexed pass: the source's slot decides
  | "nobody"      // the source has no subscribers
  | "others"      // the source's one or two subscribers are other readers
  | "marked"      // a marked pass: the source's subscribers decide
  | "one-past"    // found one past the edge under the cursor
  | "tail"        // found among the last two edges of the list
  | "ahead"       // found within 8 past the edge under the cursor
  | "behind"      // found within 8 behind the cursor: read already
  | "ends"        // both scans reached the ends of the list
  | "subs";       // the source's first 8 subscribers decide
export type Counter =
  | "hits" | "repeats" | "dups" | "links" | "scans" | "tails" | "moves"
  | "lookups" | "sweeps" | "indexes" | "indexed";

export interface Step {
  kind: Kind;
  proof: Proof;
  /** Position where a scan or a subscriber lookup found the edge (1 = first looked at). */
  at?: number;
  /** A lookup through the subscribers ran out of budget (more than 8 before ours). */
  budget?: boolean;
  /** The once-per-pass walk this read started, and how many edges it walked. */
  walk?: "mark" | "index";
  walked?: number;
  /** Slot cells of an outer pass that this read's index or claim saved on the work stack. */
  displaced?: number;
  /** The edge under the cursor that the read passed over (skip, defer). */
  over?: QEdge;
  /** The research counters (src/instrumentation.ts) this read adds. */
  counters: Partial<Record<Counter, number>>;
}

const step = (kind: Kind, proof: Proof, counters: Step["counters"], more: Partial<Step> = {}): Step => ({ kind, proof, counters, ...more });
const add = (a: Step["counters"], b: Step["counters"]) => {
  const out = { ...a };
  for (const k of Object.keys(b) as Counter[]) out[k] = (out[k] ?? 0) + (b[k] ?? 0);
  return out;
};

/** What reading `s` does to the running consumer `c`, whose last accepted edge is `last`. */
export function explain(c: QNode, s: QNode, last: QEdge | null): Step {
  const next = last === null ? c.firstDep : last.nextDep;
  if (next !== null && next.from === s) return step("hit", "cursor", { hits: 1 });
  if (last !== null) return last.from === s ? step("repeat", "own", { repeats: 1 }) : miss(c, s, last, next);
  if (next !== null) return miss(c, s, last, next);
  return step("new", "empty", { links: 1 });
}

function miss(c: QNode, s: QNode, last: QEdge | null, next: QEdge | null): Step {
  if (last !== null && last.from.slot === last) return slot(c, s, {}, "slot");
  const first = s.firstSub;
  if (first === null) return step("new", "nobody", { links: 1 });
  if (alien(first, c)) return step("new", "others", { links: 1 });
  if (next !== null && next.ver === UNREAD) return settle(c, s, next, pair(first, c), { lookups: 1 }, "marked");
  if (next !== null) {
    let e = next.nextDep;
    if (e !== null && e.from === s) return skip(next, "one-past", 1);
    let budget = TAIL;
    e = c.lastDep!;
    while (e !== next && e.from !== s && --budget !== 0) e = e.prevDep!;
    if (e.from === s) return step("tail", "tail", { tails: 1 });
  }
  return near(c, s, last, next, first);
}

function near(c: QNode, s: QNode, last: QEdge | null, next: QEdge | null, first: QEdge): Step {
  let e: QEdge | null = null;
  if (next !== null) {
    let budget = SCAN, at = 1;
    e = next.nextDep;
    while (e !== null && e.from !== s && --budget !== 0) { e = e.nextDep; at++; }
    if (e !== null && e.from === s) return skip(next, "ahead", at);
  }
  let p = last !== null ? last.prevDep : null, budget = SCAN, at = 1;
  while (p !== null && p.from !== s && --budget !== 0) { p = p.prevDep; at++; }
  if (p !== null && p.from === s) return step("repeat", "behind", { dups: 1 }, { at });
  if (e === null && p === null) return step("new", "ends", { links: 1 });
  const found = pair(first, c);
  let counters: Step["counters"] = { lookups: 1 }, more: Partial<Step> = {}, unread: Set<QEdge> | undefined;
  if (found.edge && next !== null) {
    // Either walk marks the unread suffix, from `next` on, before the found edge is taken.
    unread = suffix(next);
    if (found.edge !== first) {
      const w = indexWalk(c);
      more = { walk: "index", walked: w.walked, displaced: w.displaced };
      counters = add(counters, { indexes: 1, indexed: w.walked });
    } else {
      more = { walk: "mark", walked: unread.size };
      counters = add(counters, { sweeps: 1, indexed: unread.size });
    }
  }
  const r = settle(c, s, next, found, counters, "subs", unread);
  return { ...r, ...more, walk: more.walk ?? r.walk, walked: more.walked ?? r.walked, displaced: more.displaced ?? r.displaced };
}

/** A skip: the first time the edge under the cursor is marked, the second time it goes to the end. */
function skip(next: QEdge, proof: Proof, at: number): Step {
  return step(next.ver === SKIPPED ? "defer" : "skip", proof, { scans: 1 }, { at, over: next });
}

/** The answer of a lookup through the source's subscribers. */
function settle(c: QNode, s: QNode, next: QEdge | null, found: { edge: QEdge | null | undefined; at: number },
  counters: Step["counters"], proof: Proof, unread?: Set<QEdge>): Step {
  if (found.edge === null) return step("new", proof, add(counters, { links: 1 }), { at: found.at });
  if (found.edge !== undefined) return take(found.edge, counters, proof, { at: found.at }, unread);
  // Past the budget: index the pass (marking the unread suffix), then the slot decides.
  const w = indexWalk(c);
  const r = slot(c, s, add(counters, { indexes: 1, indexed: w.walked }), proof, w.claimed, next !== null ? suffix(next) : undefined);
  return { ...r, budget: true, walk: "index", walked: w.walked, displaced: w.displaced + (r.displaced ?? 0) };
}

/** An indexed pass's lookup: the source's slot holds the pair's edge, or the pair is absent. */
function slot(c: QNode, s: QNode, counters: Step["counters"], proof: Proof, claimed?: Map<QNode, QEdge>, unread?: Set<QEdge>): Step {
  const cell = claimed?.get(s) ?? s.slot;
  const n = add(counters, { lookups: 1 });
  if (cell !== null && cell.to === c) return take(cell, n, proof, {}, unread);
  // A new edge, claimed into the slot: a cell already there (an outer pass's) goes on the stack.
  return step("new", proof, add(n, { links: 1 }), { displaced: cell !== null ? 1 : 0 });
}

/** Edges from `next` to the end: the unread suffix a mark or index walk sets to UNREAD. */
function suffix(next: QEdge) {
  const set = new Set<QEdge>();
  for (let u: QEdge | null = next; u !== null; u = u.nextDep) set.add(u);
  return set;
}

function take(e: QEdge, counters: Step["counters"], proof: Proof, more: Partial<Step>, unread?: Set<QEdge>): Step {
  if (e.ver !== UNREAD && !unread?.has(e)) return step("repeat", proof, add(counters, { dups: 1 }), more);
  return step("move", proof, add(counters, { moves: 1 }), more);
}

/** The index walk: every edge of `c` into its source's slot; cells already there are displaced. */
function indexWalk(c: QNode) {
  let walked = 0, displaced = 0;
  const claimed = new Map<QNode, QEdge>();
  for (let e = c.firstDep; e !== null; e = e.nextDep) {
    walked++;
    if ((claimed.get(e.from) ?? e.from.slot) !== null) displaced++;
    claimed.set(e.from, e);
  }
  return { walked, displaced, claimed };
}

function alien(first: QEdge, c: QNode): boolean {
  const tail = first.prevSub!;
  return first.to !== c && tail.to !== c && (tail === first || first.nextSub === tail);
}

function pair(first: QEdge | null, c: QNode): { edge: QEdge | null | undefined; at: number } {
  let budget = SCAN, at = 0;
  for (let e = first; e !== null; e = e.nextSub) {
    at++;
    if (e.to === c) return { edge: e, at };
    if (--budget === 0) return { edge: undefined, at };
  }
  return { edge: null, at };
}

// ------------------------------------------------------------------ recording

/** The part of the public API the lab uses: reflex-quant itself, or a build with counters. */
export interface Api {
  signal<T>(v: T): unknown;
  computed<T>(fn: (prev: T | undefined) => T): unknown;
  get(x: unknown): unknown;
  peek(x: unknown): unknown;
  set(x: unknown, v: unknown): void;
  dispose(x: unknown): void;
}

export interface EdgeView {
  id: number; src: string; ver: number; srcVer: number;
  /** Accepted in the running pass (before the cursor). */
  read: boolean;
  unread: boolean; skipped: boolean; tentative: boolean;
  /** The edge sits in its source's slot (an indexed pass). */
  slot: boolean;
}
export interface ListView { name: string; edges: EdgeView[]; /** Cursor position while its pass runs; null when idle. */ cursor: number | null; gen: number }
export interface SourceView { name: string; ver: number; subs: string[]; slot: { owner: string; id: number } | null }
export interface Snapshot { lists: ListView[]; sources: SourceView[] }

export type Frame =
  | { type: "step"; step: number; label: string; snap: Snapshot }
  | { type: "run"; step: number; consumer: string; snap: Snapshot }
  | { type: "read"; step: number; consumer: string; src: string; explain: Step; over?: string; snap: Snapshot }
  | { type: "end"; step: number; consumer: string; ok: boolean; error?: string; disposed?: boolean; removed: string[]; born: string[]; snap: Snapshot };

export interface LabStep { label: string; run: () => void; /** Read kinds of `focus` in this step, checked by the validator. */ expect?: string }
export interface Lab {
  api: Api;
  signal<T>(name: string, v: T): unknown;
  /** A computed whose body reads through `r` (a tracked `get`) and is recorded. */
  computed<T>(name: string, body: (r: (x: unknown) => any, prev: T | undefined) => T): unknown;
  /** Inside a recorded body: `peek` (no relation). */
  untracked(x: unknown): unknown;
}

interface Ctx { node: QNode; name: string; read: QNode[] }

export interface RecordOptions {
  lists: string[];
  sources?: string[];
  /** Called right after every tracked read (validation). */
  onRead?: (consumer: QNode, src: QNode, explain: Step, read: QNode[]) => void;
}

export function record(api: Api, opts: RecordOptions, build: (lab: Lab) => LabStep[]) {
  const names = new Map<QNode, string>();
  const byName = new Map<string, QNode>();
  const ids = new WeakMap<QEdge, number>();
  let nextId = 1, current = -1;
  const id = (e: QEdge) => { let n = ids.get(e); if (n === undefined) ids.set(e, (n = nextId++)); return n; };
  const stack: Ctx[] = [];
  const frames: Frame[] = [];
  const finished: { name: string; error?: string }[] = [];
  /** Edge ids per consumer: every one seen since its last end frame, and its list at that end. */
  const seen = new Map<string, Map<number, string>>();
  const base = new Map<string, Set<number>>();
  const counters: { step: number; consumer: string; src: string; explain: Step }[] = [];

  const nth = (c: QNode, k: number) => { let e = c.firstDep; for (let i = 0; i < k; i++) e = e!.nextDep; return e; };

  const snapshot = (): Snapshot => {
    const lists = opts.lists.map((n) => {
      const c = byName.get(n);
      if (!c) return { name: n, edges: [], cursor: null, gen: 0 };
      const ctx = stack.find((x) => x.node === c);
      const cursor = ctx ? ctx.read.length : null;
      const tentative = (c.gen + 1) & MASK;
      const edges: EdgeView[] = [];
      let k = 0;
      for (let e = c.firstDep; e !== null; e = e.nextDep, k++) {
        edges.push({
          id: id(e), src: names.get(e.from) ?? "?", ver: e.ver, srcVer: e.from.ver,
          read: cursor !== null && k < cursor,
          unread: e.ver === UNREAD, skipped: e.ver === SKIPPED,
          // While a pass runs every edge it linked is new; after a failure they stay tentative.
          tentative: e.gen === tentative, slot: e.from.slot === e,
        });
      }
      const seenIds = seen.get(n) ?? new Map();
      for (const e of edges) seenIds.set(e.id, e.src);
      seen.set(n, seenIds);
      return { name: n, edges, cursor, gen: c.gen };
    });
    const sources = (opts.sources ?? []).map((n) => {
      const s = byName.get(n)!;
      const subs: string[] = [];
      for (let e = s.firstSub; e !== null; e = e.nextSub) subs.push(names.get(e.to) ?? "?");
      return { name: n, ver: s.ver, subs, slot: s.slot ? { owner: names.get(s.slot.to) ?? "?", id: id(s.slot) } : null };
    });
    return { lists, sources };
  };

  /** An end frame for `name`: edges gone since its last end, and edges it holds that are new since. */
  const end = (name: string, ok: boolean, error?: string, disposed?: boolean) => {
    const prior = new Map(seen.get(name) ?? []);
    const snap = snapshot();
    const list = snap.lists.find((l) => l.name === name)!;
    const now = new Set(list.edges.map((e) => e.id));
    const was = base.get(name) ?? new Set<number>();
    const removed = [...prior].filter(([i]) => !now.has(i)).map(([, s]) => s);
    const born = list.edges.filter((e) => !was.has(e.id)).map((e) => e.src);
    base.set(name, now);
    seen.set(name, new Map(list.edges.map((e) => [e.id, e.src])));
    frames.push({ type: "end", step: current, consumer: name, ok, error, disposed, removed, born, snap });
  };

  const flush = () => {
    while (finished.length) {
      const f = finished.shift()!;
      end(f.name, f.error === undefined, f.error);
    }
  };

  const r = (x: unknown) => {
    const ctx = stack.at(-1);
    if (!ctx) return api.get(x);
    try { api.peek(x); } finally { flush(); }   // bring it up to date first: nested runs end here
    const s = x as QNode;
    const last = ctx.read.length ? nth(ctx.node, ctx.read.length - 1) : null;
    const ex = explain(ctx.node, s, last);
    const over = ex.over ? names.get(ex.over.from) : undefined;
    const v = api.get(x);
    if (!ctx.read.includes(s)) ctx.read.push(s);
    opts.onRead?.(ctx.node, s, ex, ctx.read);
    counters.push({ step: current, consumer: ctx.name, src: names.get(s) ?? "?", explain: ex });
    if (opts.lists.includes(ctx.name)) frames.push({ type: "read", step: current, consumer: ctx.name, src: names.get(s) ?? "?", explain: ex, over, snap: snapshot() });
    return v;
  };

  const lab: Lab = {
    api,
    signal(name, v) { const n = api.signal(v) as QNode; names.set(n, name); byName.set(name, n); return n; },
    computed(name, body) {
      let node: QNode;
      node = api.computed((prev: any) => {
        stack.push({ node, name, read: [] });
        if (opts.lists.includes(name)) frames.push({ type: "run", step: current, consumer: name, snap: snapshot() });
        let error: string | undefined;
        try { return body(r, prev); }
        catch (e) { error = e instanceof Error ? e.message : String(e); throw e; }
        finally { stack.pop(); if (opts.lists.includes(name)) finished.push({ name, error }); }
      }) as QNode;
      names.set(node, name); byName.set(name, node);
      return node;
    },
    untracked: (x) => api.peek(x),
  };

  const steps = build(lab);
  steps.forEach((s, k) => {
    current = k;
    frames.push({ type: "step", step: k, label: s.label, snap: snapshot() });
    try { s.run(); } catch { /* a failed run is recorded by its end frame */ }
    flush();
    // A disposed consumer loses its edges without a run: show that as the step's end.
    snapshot();
    for (const n of opts.lists) {
      const c = byName.get(n);
      if (c && c.firstDep === null && (base.get(n)?.size ?? 0) > 0 && !frames.some((f) => f.step === k && f.type === "end" && f.consumer === n)) end(n, true, undefined, true);
    }
  });
  return { frames, steps, counters };
}
