import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const temporalFacts = [
  [
    "Stale",
    "write/mark below a changed source",
    "pending source validation",
    "validation descent or exec entry consumes old mark",
    "a new mark during the current validation/callback",
  ],
  [
    "Dirty",
    "direct change, first run or failure",
    "execution debt",
    "exec entry consumes old debt",
    "new in-pass invalidation or failed execution debt",
  ],
  [
    "Woken",
    "signal change reaches non-Busy watcher",
    "one delivery/body-attempt interval",
    "body entry consumes pre-body wake",
    "in-body wake uses Stale plus queue delivery, not Woken",
  ],
  [
    "Queued",
    "host wake appends watcher",
    "one physical queue entry",
    "dequeue transfers ownership to delivery",
    "new entry created by a callback",
  ],
  [
    "Busy",
    "exec entry",
    "one dynamic callback invocation",
    "success/failure unwind",
    "none at rest",
  ],
  [
    "Checking",
    "DEV validation descent",
    "one validation frame; aliases watcher Woken",
    "clean return, exec entry or failure unwind",
    "none on computed at rest",
  ],
  [
    "cleanup",
    "successful watcher body returns function",
    "one watcher lifecycle epoch",
    "before calling cleanup on rerun/dispose",
    "only cleanup returned by a later successful body",
  ],
  [
    "scope",
    "exec/untracked saves active and cursor",
    "one dynamic execution frame",
    "matching return/throw restores caller",
    "caller's exact saved execution context",
  ],
  [
    "UNREAD",
    "mark/index of old suffix",
    "one tracking pass or failed dirty frontier",
    "successful read/commit/cut; failure remains dirty",
    "unread old frontier while execution debt exists",
  ],
  [
    "SKIPPED",
    "one skipped edge in near tracking",
    "unread suffix in a pass/failed frontier",
    "successful observation or retirement",
    "marker may remain on a dirty failed frontier",
  ],
  [
    "slot",
    "index claim",
    "innermost indexed owner of a source",
    "matching unindex",
    "displaced outer owner's exact cell",
  ],
  [
    "stack",
    "traversal push/displaced slot claim",
    "one push-to-pop interval",
    "matching pop/unwind nulls physical cell",
    "other still-owned cells only; capacity policy is separate",
  ],
  [
    "tentative-gen",
    "edge birth at next execution epoch",
    "failed/current tentative frontier",
    "successful commit or retirement; SETTLE bounds counter age",
    "committed identity, not tentative classification",
  ],
  [
    "retirement",
    "unlink/cut removes relation identity",
    "operation-scoped retirement witness",
    "removal severs live neighbour pointers",
    "interior pointers within one retired cut run; immutable endpoints",
  ],
  [
    "host",
    "batch/drain opens hold and queue registers",
    "nested batch/drain interval",
    "outer drain/batch closes hold and empties slots",
    "bounded capacity plus spare/calm hysteresis",
  ],
  [
    "first-error",
    "first error in an operation",
    "operation plus remaining drain/rollback",
    "rethrow then next operation starts fresh",
    "no prior error in next operation",
  ],
  [
    "terminal",
    "dispose sets fn null",
    "remainder of object lifetime",
    "terminal state has no resurrection boundary",
    "cached computed value; no live deps or watcher cleanup",
  ],
].map(([fact, birth, owner, extinction, residue]) => ({
  fact,
  birth,
  owner,
  extinction,
  residue,
}));

const edit = (file, needle, replacement, all = false) => ({
  file,
  needle,
  replacement,
  ...(all ? { all } : {}),
});
const k = (needle, replacement, all) =>
  edit("kernel.ts", needle, replacement, all);
const h = (needle, replacement, all) =>
  edit("host.ts", needle, replacement, all);
const g = (needle, replacement, all) =>
  edit("graph.ts", needle, replacement, all);
const entry = "n.flags = (n.flags & ~Flag.PendingMarked) | Flag.Busy;";
const execStart = "export function exec(n: Node): void {";
const afterBody = "  const f = n.flags;\n\n  if (last !== null";

export function temporalMutants() {
  const out = [];
  const add = (fact, operator, ...edits) =>
    out.push({ id: `${fact}-${operator}`, fact, operator, edits });
  for (const fact of ["Stale", "Dirty", "Woken"]) {
    const remaining =
      fact === "Stale"
        ? "Flag.Dirty | Flag.Woken"
        : fact === "Dirty"
          ? "Flag.Stale | Flag.Woken"
          : "Flag.Pending";
    add(
      fact,
      "zombie",
      k(entry, `n.flags = (n.flags & ~(${remaining})) | Flag.Busy;`),
    );
    // Clear a current interval's newly born evidence at the end of the body.
    add(
      fact,
      "early",
      k(
        "n.flags = f & ~Flag.Busy;",
        `n.flags = f & ~(Flag.Busy | Flag.${fact});`,
      ),
    );
    const sibling =
      fact === "Stale" ? "Dirty" : fact === "Dirty" ? "Woken" : "Stale";
    add(
      fact,
      "sibling",
      k(
        entry,
        `n.flags = (n.flags & ~Flag.PendingMarked) | Flag.Busy | Flag.${sibling};`,
      ),
    );
    add(
      fact,
      "restore",
      k(execStart, execStart + `\n  const __past = n.flags & Flag.${fact};`),
      k("n.flags = f & ~Flag.Busy;", "n.flags = (f & ~Flag.Busy) | __past;"),
    );
  }
  add(
    "Queued",
    "zombie",
    h("queuedWatcher.flags & ~Flag.Queued", "queuedWatcher.flags"),
  );
  add(
    "Queued",
    "early",
    h("w.flags = flags | Flag.Queued;", "w.flags = flags & ~Flag.Queued;"),
  );
  add(
    "Queued",
    "sibling",
    h("w.flags = flags | Flag.Queued;", "w.flags = flags | Flag.Woken;"),
  );
  add(
    "Queued",
    "restore",
    h(
      "deliver(queuedWatcher, queuedWatcher.flags & ~Flag.Queued);",
      "deliver(queuedWatcher, queuedWatcher.flags & ~Flag.Queued); queuedWatcher.flags |= Flag.Queued;",
    ),
  );
  add("Busy", "zombie", k("n.flags = f & ~Flag.Busy;", "n.flags = f;"));
  add("Busy", "early", k(entry, "n.flags = n.flags & ~Flag.PendingMarked;"));
  add(
    "Busy",
    "sibling",
    k(entry, "n.flags = (n.flags & ~Flag.PendingMarked) | Flag.Checking;"),
  );
  add(
    "Busy",
    "restore",
    k(
      "    fail(n, base, last);",
      "    fail(n, base, last); n.flags |= Flag.Busy;",
    ),
  );
  add(
    "Checking",
    "zombie",
    k(
      "if (__DEV__) n.flags &= ~Flag.Checking;",
      "/* mutant: retain validation role */",
    ),
  );
  add(
    "Checking",
    "early",
    k(
      'if ((f & Flag.Active) !== 0) throw new Error("Cycle detected");',
      'root.flags &= ~Flag.Checking; if ((f & Flag.Busy) !== 0) throw new Error("Cycle detected");',
    ),
  );
  add(
    "Checking",
    "sibling",
    k("(f & ~Flag.Stale) | Flag.Checking", "(f & ~Flag.Stale) | Flag.Busy"),
  );
  add(
    "Checking",
    "restore",
    k(
      "if (__DEV__) n.flags &= ~Flag.Checking;",
      "if (__DEV__) n.flags |= Flag.Checking;",
    ),
  );
  add(
    "cleanup",
    "zombie",
    h(
      "    w.value = undefined;",
      "    /* mutant: resource remains installed */",
    ),
  );
  add(
    "cleanup",
    "early",
    h(
      "const cleanup = w.value as Cleanup;",
      "const cleanup = (w.value = undefined) as Cleanup;",
    ),
  );
  add("cleanup", "sibling", h("    w.value = undefined;", "    w.fn = null;"));
  add(
    "cleanup",
    "restore",
    h("    untracked(cleanup);", "    untracked(cleanup); w.value = cleanup;"),
  );
  add(
    "scope",
    "zombie",
    k(
      "    active = prev;\n    cursor = prevCursor;",
      "    /* mutant: failed nested frame owns caller registers */",
    ),
  );
  add(
    "scope",
    "early",
    k(
      "  active = n;\n  cursor = null;",
      "  active = prev;\n  cursor = prevCursor;",
    ),
  );
  add(
    "scope",
    "sibling",
    k(
      "cursor = prevCursor;",
      "cursor = prev === null ? null : prev.firstDep;",
      true,
    ),
  );
  add(
    "scope",
    "restore",
    k(
      "    active = prev;\n    cursor = prevCursor;",
      "    active = n;\n    cursor = prevCursor;",
    ),
  );
  const take = "  e.ver = s.ver;\n  moveDep(c, e, last, next!);";
  add(
    "UNREAD",
    "zombie",
    k(take, "  /* mutant: read keeps UNREAD */\n  moveDep(c, e, last, next!);"),
  );
  add(
    "UNREAD",
    "early",
    k("if (unread) e.ver = UNREAD;", "if (unread) e.ver = e.from.ver;"),
  );
  add(
    "UNREAD",
    "sibling",
    k("if (unread) e.ver = UNREAD;", "if (unread) e.ver = SKIPPED;"),
  );
  add(
    "SKIPPED",
    "zombie",
    k(
      "      next.ver = n.ver;",
      "      if (next.ver !== SKIPPED) next.ver = n.ver;",
    ),
  );
  add(
    "SKIPPED",
    "early",
    k("  next.ver = SKIPPED;", "  next.ver = next.from.ver;"),
  );
  add("SKIPPED", "sibling", k("  next.ver = SKIPPED;", "  next.ver = UNREAD;"));
  for (const marker of ["UNREAD", "SKIPPED"])
    add(
      marker,
      "restore",
      k(
        execStart,
        execStart +
          `\n  const __pastMarkers: Edge[] = []; for (let e = n.firstDep; e !== null; e = e.nextDep) if (e.ver === ${marker}) __pastMarkers.push(e);`,
      ),
      k(
        afterBody,
        `  for (const e of __pastMarkers) e.ver = ${marker};\n` + afterBody,
      ),
    );
  add("slot", "zombie", k("e.from.slot = null;", "e.from.slot = e;"));
  add("slot", "early", k("  s.slot = e;", "  s.slot = null;"));
  add("slot", "sibling", k("  s.slot = e;", "  s.slot = cell;"));
  add(
    "slot",
    "restore",
    k("cell.from.slot = cell;", "cell.from.slot = cell.nextDep;"),
  );
  add(
    "stack",
    "zombie",
    k(
      "stack[top] = null;",
      "/* mutant: popped physical cell retained */",
      true,
    ),
  );
  add("stack", "early", k("stack[top++] = e;", "stack[top++] = null;"));
  add(
    "stack",
    "sibling",
    k("const up = stack[--top] as Edge;", "const up = stack[top--] as Edge;"),
  );
  add(
    "stack",
    "restore",
    k(
      "stack[top] = null;",
      "stack[top] = top > 0 ? stack[top - 1] : null;",
      true,
    ),
  );
  add(
    "tentative-gen",
    "zombie",
    k(
      "if ((n.gen & SETTLE) === 0) settleDeps(n);",
      "/* mutant: tentative age not bounded */",
    ),
  );
  add(
    "tentative-gen",
    "early",
    k("gen: (c.gen + 1) & CounterLimit.Mask,", "gen: c.gen,"),
  );
  add(
    "tentative-gen",
    "sibling",
    k(
      "n.gen = (n.gen + 1) & CounterLimit.Mask;",
      "n.gen = (n.ver + 1) & CounterLimit.Mask;",
    ),
  );
  add(
    "tentative-gen",
    "restore",
    k(execStart, execStart + "\n  const __pastGen = n.gen;"),
    k("n.gen = (n.gen + 1) & CounterLimit.Mask;", "n.gen = __pastGen;"),
  );
  add(
    "retirement",
    "zombie",
    g("  e.nextSub = null;", "  /* mutant: retain next subscriber */"),
  );
  add(
    "retirement",
    "early",
    g(
      "  const before = e.prevSub!;",
      "  e.prevSub = null; const before = e.prevSub!;",
    ),
  );
  add("retirement", "sibling", g("  e.nextSub = null;", "  e.nextDep = null;"));
  add(
    "retirement",
    "restore",
    g("  e.nextSub = null;", "  e.nextSub = after;"),
  );
  add("host", "zombie", h("  hold = 0;", "  hold = 1;"));
  add("host", "early", h("  hold = 1;", "  hold = 0;", true));
  add(
    "host",
    "sibling",
    h("    head = (head + 1) & mask;", "    head = (head + 1) & size;"),
  );
  add(
    "host",
    "restore",
    h(
      "  hold++;\n  let value: T;",
      "  const __pastHold = hold; hold++;\n  let value: T;",
    ),
    h(
      "  if (--hold === 0) flush();",
      "  hold = __pastHold; if (--hold === 0) flush();",
    ),
  );
  add(
    "first-error",
    "zombie",
    h(
      "  drain(false, undefined);",
      '  drain(true, new Error("old-operation"));',
      true,
    ),
  );
  add(
    "first-error",
    "early",
    h(
      "      if (!failed) first = error;",
      "      if (!failed) first = undefined;",
    ),
  );
  add(
    "first-error",
    "sibling",
    h(
      "      if (!failed) first = error;",
      '      if (!failed) first = new Error("sibling");',
    ),
  );
  add(
    "first-error",
    "restore",
    h("      if (!failed) first = error;", "      first = error;"),
  );
  add(
    "terminal",
    "zombie",
    k("  n.fn = null;", "  /* mutant: disposed callback remains live */"),
  );
  add(
    "terminal",
    "early",
    k(
      "  if (n.fn === null) return detach(n);",
      "  n.fn = null; if (n.fn === null) return detach(n);",
      true,
    ),
  );
  add("terminal", "sibling", k("  n.fn = null;", "  n.value = null;"));
  add(
    "terminal",
    "restore",
    k("  n.fn = null;", "  const __pastFn = n.fn; n.fn = null;"),
    k(
      "  if ((n.flags & Flag.Busy) === 0) detach(n);",
      "  if ((n.flags & Flag.Busy) === 0) detach(n); n.fn = __pastFn;",
    ),
  );
  return out;
}

/** Conditional masks/stores and guarded flag stores, at their exact AST ranges. */
export function discoverDevMutants(root) {
  const require = createRequire(path.join(root, "package.json")),
    ts = require("typescript");
  const out = [];
  for (const file of ["kernel.ts", "host.ts", "graph.ts"]) {
    const code = readFileSync(path.join(root, "src", file), "utf8"),
      source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        ts.isConditionalExpression(node) &&
        node.condition.getText(source) === "__DEV__"
      ) {
        const offset = node.getStart(source),
          needle = node.getText(source),
          line = source.getLineAndCharacterOfPosition(offset).line + 1;
        for (const [branch, chosen] of [
          ["then", node.whenTrue],
          ["else", node.whenFalse],
        ])
          out.push({
            id: `dev-${file}-${line}-${branch}`,
            fact: "DEV/PROD",
            operator: "force-conditional-branch",
            line,
            edits: [
              {
                file,
                offset,
                needle,
                replacement: `(${chosen.getText(source)})`,
              },
            ],
          });
      }
      if (
        ts.isIfStatement(node) &&
        node.expression.getText(source) === "__DEV__" &&
        node.thenStatement.getText(source).includes(".flags")
      ) {
        const offset = node.getStart(source),
          needle = node.getText(source),
          line = source.getLineAndCharacterOfPosition(offset).line + 1;
        for (const [branch, replacement] of [
          ["then", `{ ${node.thenStatement.getText(source)} }`],
          ["else", node.elseStatement?.getText(source) ?? ";"],
        ])
          out.push({
            id: `dev-${file}-${line}-if-${branch}`,
            fact: "DEV/PROD",
            operator: "force-conditional-branch",
            line,
            edits: [{ file, offset, needle, replacement }],
          });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

/** Interpretation is attached after observing verdicts, never used by the oracle. */
export function annotateTemporalReport(report) {
  report.factMatrix = temporalFacts;
  for (const result of report.mutations?.results ?? []) {
    for (const witness of result.witnesses)
      if (witness.at !== undefined)
        witness.firstDivergenceStep = witness.at + 1;
    if (result.verdict !== "survived") continue;
    const limit =
      "Survived the recorded finite corpus; no universal equivalence or necessity conclusion.";
    let category = "unresolved-coverage",
      basis = limit;
    if (result.fact === "DEV/PROD" || result.id === "Checking-early") {
      category = "valid-domain-diagnostic-path";
      basis =
        "These branch choices were not distinguished with C1-invalid demands excluded. This does not test preservation of C1 diagnostics.";
    } else if (["Dirty-early", "Woken-early"].includes(result.id)) {
      category = "inert-success-store-by-inspection";
      basis =
        "Busy writes create Stale, not Dirty/Woken. This edit clears its named bit only after a successful body; failure debt is installed on a separate path.";
    } else if (result.id === "SKIPPED-early") {
      category = "work-bound-not-measured";
      basis =
        "This corpus checks semantic traces, graph, retirement and root ownership, not the tracking edit-work envelope. Survival is not an asymptotic result.";
    } else if (result.id === "tentative-gen-restore") {
      category = "alternative-restamping-path";
      basis =
        "Keeping gen at zero makes the existing SETTLE condition true on every successful commit, restamping the full frontier each time. The corpus does not establish the cost or general correctness of that alternative.";
    }
    result.assessment = { category, basis, limit };
  }
  const survivors =
    report.mutations?.results.filter((r) => r.verdict === "survived") ?? [];
  report.explanationCoverage = {
    survived: survivors.length,
    assessed: survivors.filter((r) => r.assessment).length,
    unexplainedSurvivors: survivors.filter(
      (r) => !r.assessment || r.assessment.category === "unresolved-coverage",
    ).length,
    meaning:
      "Post-campaign classification coverage, not a proof of equivalence or a second kill score.",
  };
  return report;
}
