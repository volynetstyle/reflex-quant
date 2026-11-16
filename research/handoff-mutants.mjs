export const handoffProtocols = [
  {
    id: "queue",
    from: "Queued + physical cell",
    to: "local delivery + possible new queue entry",
    boundary: "dequeue/first callback",
    facts: ["Queued", "Busy", "host"],
  },
  {
    id: "wake",
    from: "Woken before body",
    to: "Busy then fresh Stale/delivery",
    boundary: "exec entry",
    facts: ["Woken", "Busy", "Stale"],
  },
  {
    id: "debt",
    from: "old Dirty",
    to: "Busy then new failed Dirty",
    boundary: "exec entry/failure unwind",
    facts: ["Dirty", "Busy"],
  },
  {
    id: "slots",
    from: "source.slot",
    to: "displaced stack cell then restored slot",
    boundary: "nested claim/unindex",
    facts: ["slot", "stack"],
  },
  {
    id: "relation",
    from: "tentative relation",
    to: "same committed relation",
    boundary: "successful commit",
    facts: ["tentative-gen", "retirement"],
  },
  {
    id: "cleanup",
    from: "old cleanup",
    to: "consumed callback then replacement epoch",
    boundary: "consume/body/commit",
    facts: ["cleanup", "terminal"],
  },
  {
    id: "error",
    from: "callback error",
    to: "drain first error then caller",
    boundary: "catch/drain/rollback",
    facts: ["first-error", "host"],
  },
  {
    id: "alias",
    from: "Checking on computed / Woken on watcher",
    to: "same node role, properly expired bit",
    boundary: "validation/body entry",
    facts: ["Checking", "Woken", "Busy"],
  },
];
const k = (needle, replacement, all = false) => ({
  file: "kernel.ts",
  needle,
  replacement,
  ...(all ? { all } : {}),
});
const h = (needle, replacement, all = false) => ({
  file: "host.ts",
  needle,
  replacement,
  ...(all ? { all } : {}),
});
const entry = "n.flags = (n.flags & ~Flag.PendingMarked) | Flag.Busy;";
const exec = "export function exec(n: Node): void {";
const delivery = "deliver(queuedWatcher, queuedWatcher.flags & ~Flag.Queued);";
export function handoffMutants() {
  const out = [];
  const add = (protocol, operator, ...edits) =>
    out.push({
      id: `handoff-${protocol}-${operator}`,
      protocol,
      operator,
      edits,
    });
  add(
    "queue",
    "destination-missing",
    h(delivery, "queuedWatcher.flags &= ~Flag.Queued;"),
  );
  add(
    "queue",
    "source-survives",
    h("    queue[head] = null;", "    /* old physical token survives */"),
  );
  add(
    "queue",
    "overlap",
    h(
      delivery,
      "deliver(queuedWatcher, queuedWatcher.flags); queuedWatcher.flags &= ~Flag.Queued;",
    ),
  );
  add(
    "queue",
    "early",
    h(
      "    queue[head] = null;\n    head = (head + 1) & mask;\n    size--;",
      "    /* queue cell held until delivery returns */",
    ),
    h(
      delivery,
      "try { deliver(queuedWatcher, queuedWatcher.flags & ~Flag.Queued); } finally { queue[head] = null; head = (head + 1) & mask; size--; }",
    ),
  );
  add(
    "queue",
    "identity-theft",
    h(
      delivery,
      "const oldFlags = queuedWatcher.flags; deliver(queuedWatcher, oldFlags & ~Flag.Queued); queuedWatcher.flags = oldFlags & ~Flag.Queued;",
    ),
  );
  add(
    "wake",
    "destination-missing",
    k(entry, "n.flags &= ~Flag.PendingMarked;"),
  );
  add(
    "wake",
    "source-survives",
    k(entry, "n.flags = (n.flags & ~Flag.Pending) | Flag.Busy;"),
  );
  add(
    "wake",
    "overlap",
    k(entry, "n.flags = (n.flags & ~Flag.Stale) | Flag.Busy;"),
  );
  add(
    "wake",
    "early",
    k("n.flags = f & ~Flag.Busy;", "n.flags = f & ~(Flag.Busy | Flag.Stale);"),
  );
  add(
    "wake",
    "identity-theft",
    k(exec, exec + "\n const priorFlags = n.flags;"),
    k(
      "n.flags = f & ~Flag.Busy;",
      "n.flags = priorFlags & ~(Flag.PendingMarked | Flag.Busy);",
    ),
  );
  add(
    "debt",
    "destination-missing",
    k(
      "  n.flags |= Flag.Dirty;\n  const tentative",
      "  /* no failed execution debt */\n  const tentative",
    ),
  );
  add(
    "debt",
    "source-survives",
    k(
      entry,
      "n.flags = (n.flags & ~(Flag.Stale | Flag.Checking)) | Flag.Busy;",
    ),
  );
  add(
    "debt",
    "overlap",
    k("  n.flags &= ~Flag.Busy;", "  /* Busy overlaps new failed Dirty */"),
  );
  add(
    "debt",
    "early",
    k(
      entry,
      "n.flags = (n.flags & ~Flag.PendingMarked) | Flag.Busy | Flag.Dirty;",
    ),
  );
  add(
    "debt",
    "identity-theft",
    k(
      "    fail(n, base, last);",
      "    fail(n, base, last); n.flags &= ~Flag.Pending;",
    ),
  );
  add(
    "slots",
    "destination-missing",
    k(
      "if (cell !== null) stack[top++] = cell;",
      "/* displaced owner is lost */",
    ),
  );
  add("slots", "source-survives", k("  s.slot = e;", "  s.slot = cell;"));
  add(
    "slots",
    "overlap",
    k(
      "    cell.from.slot = cell;",
      "    cell.from.slot = cell; stack[top] = cell;",
    ),
  );
  add(
    "slots",
    "early",
    k(
      "export function index(c: Node, next: Edge | null): void {",
      "export function index(c: Node, next: Edge | null): void {\n const earlyBase = top;",
    ),
    k(
      "    claim(e.from, e);\n  }\n}",
      "    claim(e.from, e);\n  }\n  unindex(c, earlyBase);\n}",
    ),
  );
  add(
    "slots",
    "identity-theft",
    k("cell.from.slot = cell;", "cell.from.slot = cell.nextDep;"),
  );
  add(
    "relation",
    "destination-missing",
    k(
      "n.gen = (n.gen + 1) & CounterLimit.Mask;",
      "/* no commit epoch advance */",
    ),
    k(
      "if ((n.gen & SETTLE) === 0) settleDeps(n);",
      "/* no compensating restamp */",
    ),
  );
  add(
    "relation",
    "source-survives",
    k(
      "if ((n.gen & SETTLE) === 0) settleDeps(n);",
      "if ((n.gen & SETTLE) === 0) settleDeps(n); for (let e = n.firstDep; e !== null; e = e.nextDep) e.gen = (n.gen + 1) & CounterLimit.Mask;",
    ),
  );
  add(
    "relation",
    "overlap",
    k("e.gen !== tentative", "e.gen !== tentative && e.gen !== w.gen", true),
  );
  add(
    "relation",
    "early",
    k("gen: (c.gen + 1) & CounterLimit.Mask,", "gen: c.gen,"),
  );
  add(
    "relation",
    "identity-theft",
    k(
      "  n.gen = (n.gen + 1) & CounterLimit.Mask;",
      `  const oldDeps: {from: Node; ver: number; gen: number}[] = [];
  for (let e = n.firstDep; e !== null; e = e.nextDep) oldDeps.push({from:e.from,ver:e.ver,gen:e.gen});
  cutDeps(n,null); const savedCursor = cursor;
  for (const d of oldDeps) { link(n,d.from,n.lastDep,null); n.lastDep!.ver=d.ver; n.lastDep!.gen=d.gen; }
  cursor = savedCursor;
  n.gen = (n.gen + 1) & CounterLimit.Mask;`,
    ),
  );
  add(
    "cleanup",
    "destination-missing",
    h("  exec(w);\n}", "  /* old cleanup consumed, no new body */\n}"),
  );
  add(
    "cleanup",
    "source-survives",
    h("    w.value = undefined;", "    /* old cleanup remains installed */"),
  );
  add(
    "cleanup",
    "overlap",
    h("    untracked(cleanup);", "    untracked(cleanup); untracked(cleanup);"),
  );
  add(
    "cleanup",
    "early",
    h("    untracked(cleanup);", "    exec(w); untracked(cleanup);"),
  );
  add(
    "cleanup",
    "identity-theft",
    h(
      "  exec(w);\n}",
      "  exec(w); if (typeof cleanup === 'function') w.value = cleanup;\n}",
    ),
  );
  add(
    "error",
    "destination-missing",
    h(
      "      if (!failed) first = error;",
      "      /* source caught, first error not retained */",
    ),
  );
  add(
    "error",
    "source-survives",
    h(
      "  drain(false, undefined);",
      "  drain(true, new Error('earlier-operation'));",
      true,
    ),
  );
  add(
    "error",
    "overlap",
    h("      failed = true;", "      failed = true; throw error;"),
  );
  add(
    "error",
    "early",
    h("      if (!failed) first = error;", "      if (!failed) throw error;"),
  );
  add(
    "error",
    "identity-theft",
    h("      if (!failed) first = error;", "      first = error;"),
  );
  add(
    "alias",
    "destination-missing",
    k(entry, "n.flags &= ~Flag.PendingMarked;"),
  );
  add(
    "alias",
    "source-survives",
    k(entry, "n.flags = (n.flags & ~Flag.Pending) | Flag.Busy;"),
  );
  add(
    "alias",
    "overlap",
    k(
      "root.flags = __DEV__ ? (f & ~Flag.Stale) | Flag.Checking : f & ~Flag.Stale;",
      "root.flags = (__DEV__ ? (f & ~Flag.Stale) | Flag.Checking : f & ~Flag.Stale) | Flag.Watch;",
    ),
  );
  add(
    "alias",
    "early",
    k(
      entry,
      "n.flags = (n.flags & ~Flag.PendingMarked) | Flag.Busy | Flag.Checking;",
    ),
  );
  add(
    "alias",
    "identity-theft",
    h(
      "  w.flags = flags & ~Flag.Wake;",
      "  w.flags = (flags & ~Flag.Wake) | Flag.Checking;",
    ),
  );
  return out;
}
export function annotateHandoffs(report) {
  report.handoffProtocols = handoffProtocols;
  const survivors =
    report.mutations?.results.filter((r) => r.verdict === "survived") ?? [];
  for (const survivor of survivors) {
    if (survivor.id === "handoff-queue-early")
      survivor.assessment = {
        category: "delayed-release-policy-variant",
        basis:
          "Delivery clears the old flag before invoking the callback; the physical queue entry is released in finally afterwards. The new entry has its own slot. This changes transient occupancy without leaving a token/root at rest in the admitted domain.",
        limit:
          "Finite semantic/ownership result and construction inspection, not universal equivalence or a timing claim.",
      };
  }
  report.explanationCoverage = {
    survived: survivors.length,
    assessed: survivors.filter(
      (r) => r.assessment && r.assessment.category !== "unresolved-coverage",
    ).length,
    unexplainedSurvivors: survivors.filter(
      (r) => !r.assessment || r.assessment.category === "unresolved-coverage",
    ).length,
    meaning:
      "Post-campaign classification coverage; all source seeds stay in the kill-score denominator.",
  };
}
