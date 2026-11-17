import { ts } from "./transition-source.mjs";

// These are finite control protocols. Identities, payloads, exact counters and
// stack tails are parameters, not silently bounded by a one-node test universe.
const machine = (id, initial, edges, callbacks = []) => ({
  id,
  initial,
  states: [...new Set(edges.flatMap((e) => [e[0], e[2]]))],
  edges: edges.map(([from, event, to]) => ({ from, event, to })),
  callbacks,
});
export const protocols = [
  machine(
    "queue",
    "empty",
    [
      ["empty", "queue.flag", "flagged"],
      ["flagged", "queue.publish", "queued"],
      ["queued", "queue.borrow", "queued"],
      ["queued", "queue.pop", "popped"],
      ["popped", "queue.consume", "local"],
      ["local", "queue.reflag", "local+flag"],
      ["local+flag", "queue.republish", "local+queue"],
      ["local+queue", "queue.return-new", "queued"],
      ["local", "queue.return", "empty"],
    ],
    ["local", "local+queue"],
  ),
  machine(
    "attempt",
    "idle",
    [
      ["idle", "attempt.wake", "owed"],
      ["owed", "attempt.deliver", "ready"],
      ["ready", "attempt.enter", "busy"],
      ["busy", "attempt.invalidate", "busy+new"],
      ["busy", "attempt.success", "idle"],
      ["busy+new", "attempt.success-new", "owed"],
      ["busy", "attempt.failure", "cold-debt"],
      ["busy+new", "attempt.failure-new", "owed"],
      ["cold-debt", "attempt.causal-wake", "owed"],
      ["cold-debt", "attempt.computed-demand", "ready"],
      ["idle", "attempt.first-demand", "ready"],
      ...["idle", "owed", "ready", "cold-debt"].map((s) => [
        s,
        "attempt.dispose",
        "dead",
      ]),
      ["busy", "attempt.dispose-busy", "dead-busy"],
      ["busy+new", "attempt.dispose-busy", "dead-busy"],
      ["dead-busy", "attempt.unwind-dead", "dead"],
      ["dead", "attempt.dead-read", "dead"],
    ],
    ["busy", "busy+new", "ready"],
  ),
  machine(
    "cleanup",
    "none",
    [
      ["none", "cleanup.install", "slot"],
      ["slot", "cleanup.borrow", "borrowed"],
      ["borrowed", "cleanup.consume", "consumed"],
      ["consumed", "cleanup.call", "calling"],
      ["calling", "cleanup.return", "none"],
      ["calling", "cleanup.throw", "none"],
      ["none", "cleanup.body-fails", "none"],
      ["slot", "cleanup.dispose-borrow", "borrowed"],
    ],
    ["calling"],
  ),
  machine("slots", "outer", [
    ["outer", "slot.borrow", "saved-copy"],
    ["saved-copy", "slot.claim-inner", "inner+saved"],
    ["inner+saved", "slot.clear-inner", "saved"],
    ["saved", "slot.pop", "local"],
    ["local", "slot.restore", "outer"],
    ["outer", "slot.clear-outer", "empty"],
    ["empty", "slot.claim-first", "outer"],
  ]),
  machine("stack", "empty", [
    ["empty", "stack.reserve", "reserved"],
    ["reserved", "stack.publish", "owned"],
    ["owned", "stack.borrow", "owned"],
    ["owned", "stack.pop", "local+stale-cell"],
    ["local+stale-cell", "stack.clear", "local"],
    ["local", "stack.resume", "empty"],
  ]),
  machine("relation", "absent", [
    ["absent", "relation.birth", "tentative"],
    ["tentative", "relation.failed-read-retained", "tentative"],
    ["tentative", "relation.commit-same", "committed"],
    ["committed", "relation.stable-commit", "committed"],
    ["committed", "relation.restamp", "committed"],
    ["tentative", "relation.retire", "retired"],
    ["committed", "relation.retire", "retired"],
  ]),
  machine("marker", "observed", [
    ["observed", "marker.skip", "skipped"],
    ["observed", "marker.unread", "unread"],
    ["skipped", "marker.unread", "unread"],
    ["skipped", "marker.observe", "observed"],
    ["unread", "marker.observe", "observed"],
    ["observed", "marker.observe", "observed"],
    ["unread", "marker.failed-frontier", "unread"],
    ["skipped", "marker.failed-frontier", "skipped"],
    ...["observed", "skipped", "unread"].map((s) => [
      s,
      "marker.retire",
      "retired",
    ]),
  ]),
  machine("graph", "absent", [
    ["absent", "graph.allocate", "private"],
    ["private", "graph.publish", "linked"],
    ["linked", "graph.begin-rewire", "rewiring"],
    ["rewiring", "graph.store", "rewiring"],
    ["rewiring", "graph.finish-rewire", "linked"],
    ["linked", "graph.begin-retire", "retiring"],
    ["retiring", "graph.sever", "retiring"],
    ["retiring", "graph.finish-retire", "retired"],
  ]),
  machine(
    "scope",
    "caller",
    [
      ["caller", "scope.save", "saved"],
      ["saved", "scope.enter", "callee"],
      ["callee", "scope.return-local", "restoring"],
      ["callee", "scope.throw-local", "restoring"],
      ["restoring", "scope.restore", "caller"],
      ["saved", "scope.untracked-enter", "untracked"],
      ["untracked", "scope.untracked-return", "caller"],
    ],
    ["callee", "untracked"],
  ),
  machine("error", "none", [
    ["none", "error.capture", "first"],
    ["first", "error.later-preserve", "first"],
    ["first", "error.rollback-preserve", "first"],
    ["first", "error.rethrow", "none"],
  ]),
  machine(
    "host",
    "rest",
    [
      ["rest", "host.enter", "held"],
      ["held", "host.nest", "held"],
      ["held", "host.unnest", "held"],
      ["held", "host.drain", "draining"],
      ["draining", "host.queue-register", "draining"],
      ["draining", "host.hysteresis", "draining"],
      ["draining", "host.leave", "rest"],
      ["held", "host.batch-leave", "rest"],
      ["rest", "host.resize", "rest"],
    ],
    ["held", "draining"],
  ),
  machine("payload", "initial", [
    ["initial", "payload.write", "committed"],
    ["committed", "payload.write", "committed"],
    ["committed", "payload.observe", "committed"],
  ]),
  machine("startup", "unconfigured", [
    ["unconfigured", "startup.constant", "unconfigured"],
    ["unconfigured", "startup.root", "unconfigured"],
    ["unconfigured", "startup.register", "configured"],
    ["configured", "startup.constant", "configured"],
    ["configured", "startup.root", "configured"],
    ["configured", "startup.finish", "ready"],
    ["ready", "startup.public-entry", "ready"],
  ]),
];
const atomics = [
  "graph.moveDep",
  "graph.skipDep",
  "graph.cutDeps",
  "graph.unlinkSub",
  "graph.settleDeps",
  "kernel.link",
  "kernel.claim",
  "kernel.index",
  "kernel.unindex",
  "kernel.mark",
  "kernel.trim",
  "kernel.begin",
  "kernel.take",
  "kernel.skip",
  "host.wake",
  "host.grow",
  "host.shrink",
  "kernel.write",
];
export const atomicFunctions = atomics;
export const publicContracts = {
  signal: {
    entry: "index.signal",
    requires: "opaque initial payload",
    protocol: "fresh signal allocation; no callback",
    facts: [],
  },
  computed: {
    entry: "index.computed",
    requires: "callable body; optional initial value",
    protocol: "fresh computed with initial Dirty; no body execution",
    facts: ["Dirty"],
  },
  effect: {
    entry: "index.effect",
    requires: "callable watcher body",
    protocol:
      "fresh watcher; schedule/start; constructor failure rolls back unpublished identity",
    facts: ["Dirty", "Busy", "Queued", "cleanup", "terminal", "first-error"],
  },
  get: {
    entry: "kernel.read",
    requires: "readable handle and C1",
    protocol:
      "pull if owed; successful first observation; preserve caller frame",
    facts: ["scope", "Dirty", "Busy", "UNREAD", "SKIPPED", "tentative-gen"],
  },
  peek: {
    entry: "kernel.peek",
    requires: "readable handle and C1",
    protocol: "pull if owed, without caller dependency observation",
    facts: ["scope", "Dirty", "Busy"],
  },
  set: {
    entry: "index.set",
    requires: "signal handle",
    protocol: "Object.is commit/version; mark and queue; drain when not held",
    facts: ["Stale", "Dirty", "Woken", "Queued", "host"],
  },
  update: {
    entry: "index.update",
    requires: "signal handle and callable updater",
    protocol: "untracked updater; write only on normal callback return",
    facts: ["scope", "Stale", "Dirty", "Woken", "Queued", "host"],
  },
  dispose: {
    entry: "index.dispose",
    requires: "computed/effect handle",
    protocol:
      "fn becomes null; busy detach deferred to unwind; cleanup consumed after teardown",
    facts: ["terminal", "retirement", "cleanup"],
  },
  batch: {
    entry: "host.batch",
    requires: "callable body",
    protocol:
      "hold nest; deferred drain on normal/throw exit; first error retained",
    facts: ["host", "Queued", "first-error"],
  },
  untracked: {
    entry: "kernel.untracked",
    requires: "callable body",
    protocol: "suspend active consumer; restore caller in finally",
    facts: ["scope"],
  },
  typeOf: {
    entry: "index.typeOf",
    requires: "valid handle; disposed computed excluded by API precondition",
    protocol: "read-only query",
    facts: [],
  },
};

// Store schemas allow a data/pointer micro-write inside its protocol. Function
// boundaries supply begin/end edges; callback-free closure is checked separately.
export const storeRules = {
  "startup.constant": {
    events: ["startup.constant"],
    facts: [],
    obligation: "immutable configuration, not a new owned fact",
  },
  "startup.root": {
    events: ["startup.root"],
    facts: ["scope", "stack", "host"],
    obligation: "fresh empty roots and buffers",
  },
  "startup.register": {
    events: ["startup.register"],
    facts: [],
    obligation: "single host wake registration precedes public entry",
  },
  "node.allocate": {
    events: ["graph.allocate", "payload.write"],
    facts: ["Dirty", "terminal", "tentative-gen"],
    obligation: "factory establishes kind, empty adjacency/slot, zero counters",
  },
  "edge.allocate": {
    events: ["graph.allocate", "relation.birth"],
    facts: ["tentative-gen", "retirement"],
    obligation: "fresh identity, immutable endpoints and well-typed frontier",
  },
  "graph.rewire": {
    events: ["graph.begin-rewire", "graph.store", "graph.finish-rewire"],
    facts: ["retirement"],
    obligation:
      "adjacency/ring shape and unique identity; callback-free microtransaction",
  },
  "graph.retire": {
    events: [
      "graph.begin-retire",
      "graph.sever",
      "graph.finish-retire",
      "relation.retire",
    ],
    facts: ["retirement"],
    obligation: "retired run cannot point back into retained graph storage",
  },
  "marker.observe": {
    events: ["marker.observe", "payload.observe"],
    facts: ["UNREAD", "SKIPPED"],
    obligation:
      "only first successful observation changes the relation's observed version",
  },
  "marker.unread": {
    events: ["marker.unread"],
    facts: ["UNREAD", "SKIPPED"],
    obligation: "marker is owned by a tracking pass or dirty failed frontier",
  },
  "marker.skip": {
    events: ["marker.skip"],
    facts: ["SKIPPED"],
    obligation: "next unread relation only",
  },
  "relation.commit": {
    events: ["relation.commit-same", "relation.stable-commit"],
    facts: ["tentative-gen"],
    obligation:
      "commit all successful reads without replacing relation identity; counter-age lemma",
  },
  "relation.restamp": {
    events: ["relation.restamp"],
    facts: ["tentative-gen"],
    obligation:
      "SETTLE prevents old committed identity from looking tentative after wrap",
  },
  "payload.commit": {
    events: ["payload.write", "cleanup.install"],
    facts: ["cleanup", "tentative-gen"],
    obligation:
      "Object.is change and version increment; only successful live watcher publishes cleanup",
  },
  "scope.save": {
    events: ["scope.save"],
    facts: ["scope", "stack"],
    obligation: "dynamic frame snapshot is restored on both completion modes",
  },
  "scope.store": {
    events: [
      "scope.enter",
      "scope.restore",
      "scope.untracked-enter",
      "scope.untracked-return",
    ],
    facts: ["scope"],
    obligation: "exact caller active/cursor pair, including nested failure",
  },
  "stack.store": {
    events: [
      "stack.reserve",
      "stack.publish",
      "stack.pop",
      "stack.clear",
      "stack.resume",
    ],
    facts: ["stack"],
    obligation:
      "top/cell split is callback-free; exact base restoration and physical clearing",
  },
  "slot.store": {
    events: [
      "slot.borrow",
      "slot.claim-inner",
      "slot.clear-inner",
      "slot.pop",
      "slot.restore",
      "slot.claim-first",
    ],
    facts: ["slot", "stack"],
    obligation: "restore the exact displaced owner, not a sibling cell",
  },
  "queue.store": {
    events: [
      "queue.flag",
      "queue.publish",
      "queue.borrow",
      "queue.pop",
      "queue.consume",
      "queue.reflag",
      "queue.republish",
      "queue.return",
      "queue.return-new",
    ],
    facts: ["Queued", "host"],
    obligation:
      "one logical queued identity per cell; fresh requeue survives old delivery",
  },
  "host.store": {
    events: [
      "host.enter",
      "host.nest",
      "host.unnest",
      "host.drain",
      "host.queue-register",
      "host.hysteresis",
      "host.leave",
      "host.batch-leave",
      "host.resize",
    ],
    facts: ["host"],
    obligation:
      "unbounded counters, circular indexing, capacity and hold arithmetic",
  },
  "cleanup.borrow": {
    events: ["cleanup.borrow", "cleanup.dispose-borrow"],
    facts: ["cleanup"],
    obligation: "borrow is not a second invocation right",
  },
  "cleanup.consume": {
    events: ["cleanup.consume"],
    facts: ["cleanup"],
    obligation: "old closure is removed before its callback",
  },
  "error.store": {
    events: [
      "error.capture",
      "error.later-preserve",
      "error.rollback-preserve",
    ],
    facts: ["first-error"],
    obligation: "retain earliest operation error across remaining obligations",
  },
  "terminal.store": {
    events: ["attempt.dispose", "attempt.dispose-busy", "attempt.unwind-dead"],
    facts: ["terminal"],
    obligation: "fn null is terminal; in-flight code must recheck it",
  },
  "flag.store": {
    events: [
      "attempt.wake",
      "attempt.enter",
      "attempt.invalidate",
      "attempt.success",
      "attempt.failure",
      "attempt.failure-new",
      "attempt.unwind-dead",
      "queue.flag",
      "queue.consume",
    ],
    facts: ["Stale", "Dirty", "Woken", "Queued", "Busy", "Checking"],
    obligation:
      "finite flag transfer proof under declared phase/type/snapshot premises",
  },
};
export const transferKinds = {
  "startup.constant": {
    births: [],
    handoffs: [],
    extinctions: [],
    residue: "read-only configuration",
  },
  "startup.root": {
    births: ["empty roots/buffers"],
    handoffs: [],
    extinctions: [],
    residue: "fresh empty storage",
  },
  "startup.register": {
    births: ["configured wake dispatch"],
    handoffs: ["noop hook -> reference host"],
    extinctions: ["unconfigured startup"],
    residue: "immutable dispatch after startup",
  },
  "node.allocate": {
    births: ["identity/kind", "Dirty for computed or watcher"],
    handoffs: [],
    extinctions: [],
    residue: "cached initial payload, zero counters, empty graph/slot",
  },
  "edge.allocate": {
    births: ["tentative-gen", "relation identity"],
    handoffs: [],
    extinctions: [],
    residue: "sealed from/to endpoints",
  },
  "graph.rewire": {
    births: [],
    handoffs: ["same identity between list positions"],
    extinctions: [],
    residue: "transient rewiring is private to a callback-free helper",
  },
  "graph.retire": {
    births: ["retirement interval"],
    handoffs: ["live relation -> retired run"],
    extinctions: ["live relation ownership"],
    residue: "immutable endpoints and interior retired-run links only",
  },
  "marker.observe": {
    births: ["first-observation version"],
    handoffs: ["marker -> observed version"],
    extinctions: ["UNREAD/SKIPPED when overwritten"],
    residue: "first version remains as execution evidence",
  },
  "marker.unread": {
    births: ["UNREAD"],
    handoffs: ["old observation or SKIPPED -> unread suffix"],
    extinctions: ["SKIPPED where applicable"],
    residue: "dirty failed frontier may keep marker",
  },
  "marker.skip": {
    births: ["SKIPPED"],
    handoffs: [],
    extinctions: [],
    residue: "unread suffix only",
  },
  "relation.commit": {
    births: ["committed frontier"],
    handoffs: ["tentative -> same committed relation"],
    extinctions: ["tentative classification"],
    residue: "relation identity",
  },
  "relation.restamp": {
    births: [],
    handoffs: ["old committed epoch -> current committed epoch"],
    extinctions: ["dangerous age distance"],
    residue: "same relation identity",
  },
  "payload.commit": {
    births: [
      "new cached value/version; cleanup only for successful live watcher",
    ],
    handoffs: ["staged result -> cache"],
    extinctions: ["old cache value on Object.is change"],
    residue: "opaque application payload",
  },
  "scope.save": {
    births: ["scoped frame snapshot"],
    handoffs: ["caller evidence -> local borrowed snapshot"],
    extinctions: [],
    residue: "borrow has no extra execution right",
  },
  "scope.store": {
    births: [],
    handoffs: ["active/cursor to callee or exact saved caller"],
    extinctions: ["callee context on unwind"],
    residue: "caller context",
  },
  "stack.store": {
    births: ["owned stack reservation/cell"],
    handoffs: ["cell -> local resume/owner"],
    extinctions: ["popped physical root"],
    residue: "other live frames, bounded capacity",
  },
  "slot.store": {
    births: ["inner indexed owner"],
    handoffs: ["slot -> displaced stack cell -> restored slot"],
    extinctions: ["inner slot ownership"],
    residue: "exact outer owner",
  },
  "queue.store": {
    births: ["Queued/new queue entry"],
    handoffs: ["old entry -> local delivery"],
    extinctions: ["old Queued/physical cell"],
    residue: "new entry has independent ownership",
  },
  "host.store": {
    births: ["hold/drain interval"],
    handoffs: ["nested -> enclosing host interval"],
    extinctions: ["outer hold on completion"],
    residue: "capacity/spare/calm policy",
  },
  "cleanup.borrow": {
    births: ["borrowed callback reference"],
    handoffs: [],
    extinctions: [],
    residue: "invocation right remains singular",
  },
  "cleanup.consume": {
    births: ["local invocation right"],
    handoffs: ["cleanup slot -> consumed local callback"],
    extinctions: ["old cleanup slot"],
    residue: "local reference may remain until frame exit",
  },
  "error.store": {
    births: ["caught error/first-error ownership"],
    handoffs: ["callback error -> retained first error"],
    extinctions: ["later error precedence"],
    residue: "earliest error until rethrow",
  },
  "terminal.store": {
    births: ["fn null terminality"],
    handoffs: ["busy teardown -> deferred unwind detach"],
    extinctions: ["future callback eligibility"],
    residue: "cached value, no callback resurrection",
  },
  "flag.store": {
    births: [],
    handoffs: ["per-site declared born/died set below"],
    extinctions: [],
    residue: "other flag facts preserved",
  },
};
export function ruleForSite(s) {
  const { owner: o, target: t, operation: op } = s;
  if (o.endsWith(".<init>"))
    return t.startsWith("graph.") ||
      t === "kernel.compare" ||
      o === "index.<init>"
      ? "startup.constant"
      : "startup.root";
  if (op === "exception-capture") return "error.store";
  if (o === "kernel.onWake") return "startup.register";
  if (o === "graph.createNode") return "node.allocate";
  if (op === "object-initialize" && o === "kernel.link") return "edge.allocate";
  if (t === "Node.flags") return "flag.store";
  if (t === "Node.fn") return "terminal.store";
  if (t === "Node.gen") return "relation.commit";
  if (t === "Edge.gen") return "relation.restamp";
  if (t === "Node.value")
    return ["host.deliver", "host.stop"].includes(o)
      ? "cleanup.consume"
      : "payload.commit";
  if (t === "Node.ver") return "payload.commit";
  if (t === "Edge.ver")
    return s.text.includes("UNREAD")
      ? "marker.unread"
      : s.text.includes("SKIPPED")
        ? "marker.skip"
        : "marker.observe";
  if (t === "Node.slot") return "slot.store";
  if (t === "kernel.active" || t === "kernel.cursor") return "scope.store";
  if (t === "kernel.top" || (t.startsWith("array.") && o.startsWith("kernel.")))
    return "stack.store";
  if (o === "kernel.claim" && s.kind === "scoped-owner") return "slot.store";
  if (s.kind === "scoped-owner") {
    if (t.endsWith(".cleanup")) return "cleanup.borrow";
    if (t.endsWith(".first") || t.endsWith(".failed")) return "error.store";
    if (t.endsWith(".queuedWatcher")) return "queue.store";
    return "scope.save";
  }
  if (
    t.startsWith("host.") ||
    (t.startsWith("array.") && o.startsWith("host."))
  )
    return o === "host.wake" ||
      (o === "host.drain" && ["array.cell", "host.size"].includes(t))
      ? "queue.store"
      : "host.store";
  if (
    (t.startsWith("Node.") || t.startsWith("Edge.")) &&
    ["graph.moveDep", "graph.skipDep", "kernel.link"].includes(o)
  )
    return "graph.rewire";
  if (
    (t.startsWith("Node.") || t.startsWith("Edge.")) &&
    ["graph.cutDeps", "graph.unlinkSub", "kernel.fail"].includes(o)
  )
    return "graph.retire";
  throw new Error(`No transition schema for ${s.id}`);
}

export function checkProtocols(machines = protocols) {
  const events = new Set(),
    report = [];
  for (const m of machines) {
    const states = new Set(m.states);
    if (!states.has(m.initial))
      throw new Error(`${m.id}: initial state outside carrier`);
    for (const e of m.edges) {
      if (!states.has(e.from) || !states.has(e.to))
        throw new Error(`${m.id}: transition outside carrier`);
      events.add(e.event);
    }
    const reached = new Set([m.initial]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of m.edges)
        if (reached.has(e.from) && !reached.has(e.to)) {
          reached.add(e.to);
          changed = true;
        }
    }
    if (reached.size !== states.size)
      throw new Error(`${m.id}: unreachable state`);
    for (const c of m.callbacks)
      if (!states.has(c)) throw new Error(`${m.id}: callback outside carrier`);
    if (
      ["relation", "graph", "marker"].includes(m.id) &&
      m.edges.some((e) => e.from === "retired")
    )
      throw new Error(`${m.id}: retired identity resurrected`);
    if (
      m.id === "attempt" &&
      m.edges.some(
        (e) =>
          e.from === "dead" &&
          !(e.to === "dead" && e.event === "attempt.dead-read"),
      )
    )
      throw new Error("terminal attempt resurrected");
    if (
      m.id === "cleanup" &&
      m.edges.some(
        (e) =>
          ["cleanup.return", "cleanup.throw"].includes(e.event) &&
          e.to !== "none",
      )
    )
      throw new Error("consumed cleanup resurrected");
    if (
      m.id === "queue" &&
      m.callbacks.some((s) => !["local", "local+queue"].includes(s))
    )
      throw new Error("callback before queue ownership transfer");
    if (
      m.id === "stack" &&
      m.edges.some(
        (e) =>
          e.event === "stack.clear" &&
          !(e.from === "local+stale-cell" && e.to === "local"),
      )
    )
      throw new Error("physical stack cell not cleared after pop");
    report.push({
      id: m.id,
      states: states.size,
      edges: m.edges.length,
      reachable: reached.size,
    });
  }
  for (const [id, r] of Object.entries(storeRules))
    for (const e of r.events)
      if (!events.has(e)) throw new Error(`${id}: unmapped event ${e}`);
  return report;
}

export function validFlags(role, flags) {
  if (flags < 0 || flags > 255 || flags & 8) return false;
  if (role === "signal") return flags === 0;
  if (role === "computed") return (flags & ~7) === 0;
  return (
    Boolean(flags & 16) &&
    (!(flags & 128) || Boolean(flags & 64)) &&
    (!(flags & 4) || !(flags & 32)) &&
    (!(flags & 32) || Boolean(flags & 2))
  );
}
export const flagStates = ["signal", "computed", "watcher"].flatMap((role) =>
  Array.from({ length: 256 }, (_, flags) => ({ role, flags })).filter((s) =>
    validFlags(s.role, s.flags),
  ),
);
const bits = { Stale: 1, Dirty: 2, Busy: 4, Woken: 32, Queued: 128 };
const action = (id, born = [], died = [], input = "current") => ({
  id,
  born,
  died,
  input,
});
const entryAction = action("body-entry", ["Busy"], ["Stale", "Dirty", "Woken"]);
export function flagAction(site) {
  const which = Number(site.id.split("|").at(-1));
  if (site.owner === "kernel.write")
    return [
      action("busy-invalidation", ["Stale"]),
      action("signal-wake", ["Dirty", "Woken"]),
      action("direct-debt", ["Dirty"]),
      action("direct-stale-debt", ["Dirty", "Stale"]),
    ][which - 1];
  if (site.owner === "kernel.mark") return action("transitive-mark", ["Stale"]);
  if (site.owner === "kernel.verify")
    return which <= 2
      ? action("validation-entry", [], ["Stale"])
      : action("validation-failure", ["Dirty"]);
  if (site.owner === "kernel.check") return action("watcher-debt", ["Dirty"]);
  if (site.owner === "kernel.exec")
    return which === 1
      ? entryAction
      : action("body-success-exit", [], ["Busy"]);
  if (site.owner === "kernel.fail")
    return which === 1
      ? action("body-failure-exit", [], ["Busy"])
      : action("failed-debt", ["Dirty"]);
  if (site.owner === "kernel.detach")
    return action("terminal-pending-consume", [], ["Stale", "Dirty", "Woken"]);
  if (site.owner === "host.wake")
    return action("queue-token-publish", ["Queued"]);
  if (site.owner === "host.deliver")
    return which === 1
      ? action("dequeue-dead-or-cold", [], [], "snapshot")
      : which === 2
        ? action("delivery-consume", [], ["Stale", "Woken"], "snapshot")
        : action("watcher-check-failure", ["Stale"]);
  throw new Error(`No flag action ${site.id}`);
}
export function applyFlagAction(a, input, snapshot = input) {
  let out = a.input === "snapshot" ? snapshot : input;
  for (const bit of a.died) out &= ~bits[bit];
  for (const bit of a.born) out |= bits[bit];
  return out;
}
const UNKNOWN = Symbol("unknown");
function value(n, env, source) {
  n = source.unwrap(n);
  if (!n) return UNKNOWN;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(n))
    return ["__DEV__", "__STATS__"].includes(n.text)
      ? false
      : ["f", "sf", "flags"].includes(n.text)
        ? env.snapshot
        : UNKNOWN;
  if (ts.isPropertyAccessExpression(n)) {
    const c = source.checker.getConstantValue(n);
    if (c !== undefined) return c;
    if (n.name.text === "flags") return env.flags;
    if (n.name.text === "fn") return env.alive ? 1 : null;
    return UNKNOWN;
  }
  if (ts.isConditionalExpression(n)) {
    const c = value(n.condition, env, source);
    return c === UNKNOWN
      ? UNKNOWN
      : value(c ? n.whenTrue : n.whenFalse, env, source);
  }
  if (ts.isPrefixUnaryExpression(n)) {
    const v = value(n.operand, env, source);
    if (v === UNKNOWN) return UNKNOWN;
    return n.operator === ts.SyntaxKind.TildeToken
      ? ~v
      : n.operator === ts.SyntaxKind.ExclamationToken
        ? !v
        : n.operator === ts.SyntaxKind.MinusToken
          ? -v
          : UNKNOWN;
  }
  if (ts.isBinaryExpression(n)) {
    const a = value(n.left, env, source),
      b = value(n.right, env, source),
      op = n.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken)
      return a === false || b === false
        ? false
        : a === UNKNOWN || b === UNKNOWN
          ? UNKNOWN
          : a && b;
    if (op === ts.SyntaxKind.BarBarToken)
      return a === true || b === true
        ? true
        : a === UNKNOWN || b === UNKNOWN
          ? UNKNOWN
          : a || b;
    if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
    if (op === ts.SyntaxKind.AmpersandToken) return a & b;
    if (op === ts.SyntaxKind.BarToken) return a | b;
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return a === b;
    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return a !== b;
  }
  return UNKNOWN;
}
function predicates(node) {
  const out = [];
  const abrupt = (n) =>
    ts.isReturnStatement(n) ||
    ts.isThrowStatement(n) ||
    (ts.isBlock(n) && n.statements.length > 0 && abrupt(n.statements.at(-1)));
  for (let child = node, p = node.parent; p; child = p, p = p.parent) {
    if (ts.isIfStatement(p)) {
      if (child === p.thenStatement) out.push([p.expression, true]);
      else if (child === p.elseStatement) out.push([p.expression, false]);
    }
    if (ts.isBlock(p))
      for (const s of p.statements) {
        if (s === child) break;
        if (ts.isIfStatement(s) && !s.elseStatement && abrupt(s.thenStatement))
          out.push([s.expression, false]);
      }
    if (ts.isFunctionLike(p)) break;
  }
  return out;
}
export function proveFlagStores(source) {
  const results = [],
    edges = [];
  for (const site of source.writes.filter(
    (s) => s.target === "Node.flags" && s.operation === "assign",
  )) {
    const n = site._node;
    if (!ts.isBinaryExpression(n)) throw new Error("Unexpected flag store AST");
    const pre =
      site.owner === "kernel.verify"
        ? ["computed"]
        : site.owner.startsWith("host.") || site.owner === "kernel.check"
          ? ["watcher"]
          : ["computed", "watcher"];
    let checked = 0;
    // The check() callback may mutate/dispose w before this catch store. Its
    // incoming flags parameter is historical, not the current node snapshot.
    const historical = site.owner === "host.deliver" && site.id.endsWith("|3");
    const guards = historical ? [] : predicates(n);
    for (const s of flagStates)
      if (pre.includes(s.role))
        for (const alive of [false, true])
          for (const snapshot of historical
            ? flagStates
                .filter(
                  (p) =>
                    p.role === "watcher" &&
                    (p.flags & 64) === (s.flags & 64) &&
                    !(p.flags & 4),
                )
                .map((p) => p.flags)
            : site.owner === "host.deliver"
              ? [...new Set([s.flags, s.flags & ~128])]
              : [s.flags]) {
            if (
              site.owner === "kernel.exec" &&
              (site.id.endsWith("|1")
                ? !alive || Boolean(s.flags & 4)
                : !(s.flags & 4))
            )
              continue;
            if (
              site.owner === "kernel.fail" &&
              site.text.includes("|= Flag.Dirty") &&
              s.flags & 4
            )
              continue;
            const env = { ...s, alive, snapshot };
            if (
              guards.some(([p, truth]) => {
                const v = value(p, env, source);
                return v !== UNKNOWN && Boolean(v) !== truth;
              })
            )
              continue;
            const rhs = value(n.right, env, source);
            if (rhs === UNKNOWN)
              throw new Error(`Uninterpreted flag expression: ${site.id}`);
            const op = n.operatorToken.kind,
              post =
                op === ts.SyntaxKind.EqualsToken
                  ? rhs
                  : op === ts.SyntaxKind.BarEqualsToken
                    ? s.flags | rhs
                    : op === ts.SyntaxKind.AmpersandEqualsToken
                      ? s.flags & rhs
                      : UNKNOWN;
            const declared = flagAction(site),
              expected = applyFlagAction(declared, s.flags, snapshot);
            if (
              post === UNKNOWN ||
              !validFlags(s.role, post) ||
              (post ^ s.flags) & (16 | 64) ||
              post !== expected
            )
              throw new Error(
                `Flag transfer not closed: ${site.id} ${JSON.stringify({ ...env, post, expected, action: declared.id })}`,
              );
            edges.push({
              site: site.id,
              role: s.role,
              from: s.flags,
              to: post,
              alive,
              snapshot,
              action: declared.id,
            });
            checked++;
          }
    if (!checked) throw new Error(`Vacuous flag proof ${site.id}`);
    results.push({
      id: site.id,
      action: flagAction(site),
      cases: checked,
      precondition: pre.join("|"),
      premises: historical
        ? "current node and incoming flags may differ after check callback; independent same-role/same-Auto non-Busy entry snapshot; pre-callback mutable guards cannot be reused"
        : "opaque handles; snapshot stability before any callback; C1 phase admission; exact local path predicates",
      guards: guards.map(([p, t]) => ({ condition: p.getText(), truth: t })),
    });
  }
  return {
    states: flagStates.length,
    carrier: flagStates,
    transitions: edges,
    stores: results,
    checkedCases: results.reduce((n, s) => n + s.cases, 0),
  };
}
