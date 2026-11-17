import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { root } from "./experiment-runtime.mjs";
import { productionSource, ts } from "./transition-source.mjs";
import {
  protocols,
  storeRules,
  transferKinds,
  ruleForSite,
  checkProtocols,
  proveFlagStores,
  flagAction,
  atomicFunctions,
  publicContracts,
} from "./transition-model.mjs";
import { temporalFacts } from "./temporal-facts.mjs";
import { handoffProtocols } from "./handoff-mutants.mjs";

export function makeLedger(source) {
  return source.writes.map(({ _node, ...s }) => ({
    ...s,
    sourceSha256: source.sourceSha256,
    bodySha256: source.bodyHashes[s.owner] ?? null,
    constantEnvironmentSha256: source.constantEnvironmentSha256,
    rule: ruleForSite(s),
  }));
}
export function effectClosure(source, ledger) {
  if (
    !isDeepStrictEqual(
      source.api.map((a) => a.name).sort(),
      Object.keys(publicContracts).sort(),
    )
  )
    throw new Error("Public operation lacks an explicit entry contract");
  for (const a of source.api)
    if (publicContracts[a.name].entry !== a.entry)
      throw new Error(`Public entry alias changed: ${a.name}`);
  const effects = new Map(
    source.reachable.map((f) => [
      f,
      new Set(ledger.filter((s) => s.owner === f).map((s) => s.rule)),
    ]),
  );
  const callbacks = new Set(
    source.calls.filter((c) => c.kind === "callback").map((c) => c.owner),
  );
  let changed = true,
    iterations = 0;
  while (changed) {
    changed = false;
    iterations++;
    const publicEffects = new Set(
      source.api.flatMap((a) => [...(effects.get(a.entry) ?? [])]),
    );
    for (const f of source.reachable) {
      const own = effects.get(f),
        before = own.size;
      for (const c of source.calls.filter(
        (c) => c.owner === f && c.kind === "internal",
      )) {
        if (!effects.has(c.target))
          throw new Error(`Unresolved procedure ${c.target}`);
        for (const e of effects.get(c.target)) own.add(e);
      }
      if (callbacks.has(f)) for (const e of publicEffects) own.add(e);
      // Literal closure bodies have qualified callback@line owners; a generic
      // callback may execute them as well as a conforming public operation.
      for (const [child, parent] of Object.entries(source.closureParents))
        if (parent === f) for (const e of effects.get(child)) own.add(e);
      if (own.size !== before) changed = true;
    }
  }
  const alphabet = new Set(Object.keys(storeRules));
  for (const [f, set] of effects)
    for (const e of set)
      if (!alphabet.has(e))
        throw new Error(`Public effect escapes transition alphabet: ${f}/${e}`);
  const mayCallback = new Set(callbacks);
  changed = true;
  while (changed) {
    changed = false;
    for (const c of source.calls)
      if (
        c.kind === "internal" &&
        mayCallback.has(c.target) &&
        !mayCallback.has(c.owner)
      ) {
        mayCallback.add(c.owner);
        changed = true;
      }
    for (const [child, parent] of Object.entries(source.closureParents))
      if (mayCallback.has(child) && !mayCallback.has(parent)) {
        mayCallback.add(parent);
        changed = true;
      }
  }
  for (const f of atomicFunctions)
    if (mayCallback.has(f))
      throw new Error(`Atomic transaction invokes user code: ${f}`);
  for (const name of ["signal", "computed", "typeOf"]) {
    const entry = publicContracts[name].entry;
    if (
      mayCallback.has(entry) ||
      [...effects.get(entry)].some(
        (e) => e !== "node.allocate" || name === "typeOf",
      )
    )
      throw new Error(`Pure public entry contract violated: ${name}`);
  }
  const registration = source.calls.filter((c) => c.target === "kernel.onWake");
  if (
    registration.length !== 1 ||
    registration[0].owner !== "host.<init>" ||
    registration[0].registrationTarget !== "host.wake"
  )
    throw new Error(
      "Wake dispatch is not the checked startup-only registration",
    );
  return {
    iterations,
    public: source.api.map((a) => ({
      ...a,
      contract: publicContracts[a.name],
      effects: [...effects.get(a.entry)].sort(),
      mayCallback: mayCallback.has(a.entry),
    })),
    atomic: atomicFunctions.map((f) => ({ function: f, callbackFree: true })),
    callbackSites: source.calls.filter((c) => c.kind === "callback"),
    registration,
  };
}
function dataLemmas(source) {
  const endpoints = source.writes.filter((s) =>
    ["Edge.from", "Edge.to"].includes(s.target),
  );
  if (
    endpoints.length !== 2 ||
    endpoints.some((s) => s.operation !== "object-initialize")
  )
    throw new Error("Endpoint identity is mutated outside allocation");
  const terminal = source.writes.filter(
    (s) => s.target === "Node.fn" && s.operation !== "object-initialize",
  );
  if (terminal.length !== 1 || !/^n\.fn\s*=\s*null$/.test(terminal[0].text))
    throw new Error("Callback identity can resurrect");
  const initial = source.writes.filter((s) => s.owner === "graph.createNode");
  if (initial.length !== 9) throw new Error("Unexpected Node shape");
  for (const field of ["fn", "value", "flags"]) {
    const site = initial.find((s) => s.target === `Node.${field}`);
    const parameter = source.functionNodes["graph.createNode"].parameters.find(
      (p) => p.name.getText() === field,
    );
    if (
      !site ||
      !parameter ||
      !ts.isShorthandPropertyAssignment(site._node) ||
      source.checker.getShorthandAssignmentValueSymbol(site._node) !==
        source.checker.getSymbolAtLocation(parameter.name)
    )
      throw new Error(`Node parameter forwarding invariant failed: ${field}`);
  }
  for (const [field, literal] of Object.entries({
    ver: "0",
    gen: "0",
    firstDep: "null",
    lastDep: "null",
    firstSub: "null",
    slot: "null",
  })) {
    const site = initial.find((s) => s.target === `Node.${field}`);
    if (!site || site._node.initializer?.getText() !== literal)
      throw new Error(`Node initialization invariant failed: ${field}`);
  }
  let mask;
  for (const s of source.writes.filter((s) => s.target === "Node.ver")) {
    const visit = (n) => {
      if (
        ts.isPropertyAccessExpression(n) &&
        n.expression.getText() === "CounterLimit" &&
        n.name.text === "Mask"
      )
        mask = source.checker.getConstantValue(n);
      ts.forEachChild(n, visit);
    };
    visit(s._node);
  }
  if (!Number.isInteger(mask)) throw new Error("No concrete CounterLimit.Mask");
  if ((mask & (mask + 1)) !== 0 || mask < 0 || mask > 0x7fffffff)
    throw new Error("Invalid nonnegative bitmask");
  const counters = source.writes.filter((s) =>
    ["Node.ver", "Node.gen", "Edge.gen"].includes(s.target),
  );
  for (const fill of source.writes.filter((s) => s.operation === "bulk-fill"))
    if (
      fill._node.arguments.length !== 1 ||
      fill._node.arguments[0].kind !== ts.SyntaxKind.NullKeyword
    )
      throw new Error("Fresh buffer is not null-filled");
  const rhs = (s) =>
    source.unwrap(
      s.operation === "object-initialize" ? s._node.initializer : s._node.right,
    );
  const masked = (s) => {
    const n = rhs(s);
    return (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.AmpersandToken &&
      source.checker.getConstantValue(source.unwrap(n.right)) === mask
    );
  };
  const known = counters.every((s) =>
    s.operation === "object-initialize" && s.target.startsWith("Node.")
      ? rhs(s)?.getText() === "0"
      : s.owner === "graph.settleDeps"
        ? s.text === "e.gen = gen"
        : masked(s),
  );
  if (!known)
    throw new Error("Counter store lacks the declared range-transfer shape");
  const markers = Object.fromEntries(
    ["UNREAD", "SKIPPED"].map((name) => {
      const s = source.writes.find((s) => s.target === `graph.${name}`);
      return [name, Number(s?._node.initializer?.getText())];
    }),
  );
  if (
    !Number.isInteger(markers.UNREAD) ||
    !Number.isInteger(markers.SKIPPED) ||
    markers.UNREAD >= 0 ||
    markers.SKIPPED >= 0 ||
    markers.UNREAD === markers.SKIPPED
  )
    throw new Error("Temporary marker domains overlap versions or each other");
  for (const site of source.writes.filter((s) => s.target === "Edge.ver")) {
    const n = rhs(site);
    if (ts.isIdentifier(n) && Object.hasOwn(markers, n.text)) continue;
    if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === "ver" &&
      source.checker.getTypeAtLocation(n.expression).getSymbol()?.name ===
        "Node"
    )
      continue;
    throw new Error(`Unclassified edge-version producer ${site.id}`);
  }
  const factories = [];
  const factoryFlagValue = (n, auto) => {
    n = source.unwrap(n);
    if (ts.isNumericLiteral(n)) return Number(n.text);
    if (ts.isIdentifier(n) && n.text === "auto") return auto;
    if (ts.isPropertyAccessExpression(n)) {
      const c = source.checker.getConstantValue(n);
      if (c !== undefined) return c;
    }
    if (ts.isConditionalExpression(n))
      return factoryFlagValue(
        factoryFlagValue(n.condition, auto) ? n.whenTrue : n.whenFalse,
        auto,
      );
    if (ts.isBinaryExpression(n)) {
      const a = factoryFlagValue(n.left, auto),
        b = factoryFlagValue(n.right, auto);
      if (n.operatorToken.kind === ts.SyntaxKind.BarToken) return a | b;
    }
    throw new Error(`Uninterpreted factory flags ${n.getText()}`);
  };
  for (const [owner, fn] of Object.entries(source.functionNodes)) {
    const visit = (n) => {
      if (
        ts.isCallExpression(n) &&
        source.resolve(n.expression).id === "graph.createNode"
      ) {
        const role = {
          "index.signal": "signal",
          "index.computed": "computed",
          "host.watcher": "watcher",
        }[owner];
        if (!role) throw new Error(`Unreviewed node factory ${owner}`);
        const cases = (role === "watcher" ? [false, true] : [false]).map(
          (auto) => ({ auto, flags: factoryFlagValue(n.arguments[2], auto) }),
        );
        if (
          cases.some(
            (c) =>
              c.flags !==
              (role === "signal"
                ? 0
                : role === "computed"
                  ? 2
                  : 19 | (c.auto ? 64 : 0)),
          )
        )
          throw new Error(`Factory birth facts not established: ${owner}`);
        if (
          role === "signal"
            ? source.unwrap(n.arguments[0]).kind !== ts.SyntaxKind.NullKeyword
            : source.checker
                .getTypeAtLocation(n.arguments[0])
                .getCallSignatures().length === 0
        )
          throw new Error(`Factory callback role invalid: ${owner}`);
        factories.push({
          owner,
          role,
          flags: n.arguments[2].getText(),
          fn: n.arguments[0].getText(),
          cases,
        });
      }
      source.children(n, visit);
    };
    visit(fn.body);
  }
  if (factories.length !== 3) throw new Error("Unexpected factory call domain");
  return {
    immutableEndpoints: endpoints.map((s) => s.id),
    terminalOnlyNull: terminal[0].id,
    freshNodeDefaults: 6,
    forwardedNodeParameters: ["fn", "value", "flags"],
    factories,
    markers,
    counterRange: {
      mask,
      sites: counters.length,
      lemma:
        "zero initialization; top-level nonnegative all-ones mask keeps every masked store in range; SETTLE copies ranged node.gen",
      doesNotProve: "generation/observed-version ABA or SETTLE age invariant",
    },
  };
}

// These bindings connect the earlier ownership inventory to this model. The
// alias row is a kind invariant, not a fictitious computed -> watcher transfer.
export const handoffBindings = {
  queue: ["queue.consume", "queue.reflag", "queue.republish"],
  wake: ["attempt.enter", "attempt.invalidate", "attempt.failure-new"],
  debt: ["attempt.enter", "attempt.failure", "attempt.failure-new"],
  slots: ["slot.borrow", "slot.claim-inner", "slot.pop", "slot.restore"],
  relation: ["relation.commit-same", "relation.stable-commit"],
  cleanup: [
    "cleanup.consume",
    "cleanup.call",
    "cleanup.return",
    "cleanup.install",
  ],
  error: ["error.capture", "error.later-preserve", "error.rethrow"],
  alias: ["attempt.enter"],
};
function ownershipMap(ledger) {
  const events = new Set(protocols.flatMap((p) => p.edges.map((e) => e.event)));
  if (
    !isDeepStrictEqual(
      Object.keys(handoffBindings).sort(),
      handoffProtocols.map((p) => p.id).sort(),
    )
  )
    throw new Error("Handoff inventory lacks a protocol binding");
  const facts = temporalFacts.map((f) => {
    const rules = Object.entries(storeRules)
      .filter(([, r]) => r.facts.includes(f.fact))
      .map(([id]) => id);
    const sites = ledger.filter((s) => rules.includes(s.rule)).map((s) => s.id);
    if (!rules.length || !sites.length)
      throw new Error(`Unmapped ownership fact ${f.fact}`);
    return {
      ...f,
      production:
        f.fact === "Checking"
          ? "erased diagnostic role; no computed birth"
          : "parameterized local protocol",
      rules,
      sites,
    };
  });
  const handoffs = handoffProtocols.map((p) => {
    const bound = handoffBindings[p.id];
    if (bound.some((e) => !events.has(e)))
      throw new Error(`Unknown handoff edge ${p.id}`);
    return {
      ...p,
      kind:
        p.id === "alias" ? "immutable-kind invariant" : "ownership transfer",
      events: bound,
      rules: Object.entries(storeRules)
        .filter(([, r]) => r.events.some((e) => bound.includes(e)))
        .map(([id]) => id),
      refinement:
        p.id === "alias"
          ? "constructor and per-store role preservation checked; computed Checking absent in production"
          : "edge binding; enabledness requires cross-protocol simulation",
    };
  });
  return { facts, handoffs };
}

export function auditTransitions({ source = productionSource(), ledger } = {}) {
  if (source.unknownCalls.length || source.unknownWrites.length)
    throw new Error(
      `Unclassified source effects: ${JSON.stringify({ calls: source.unknownCalls, writes: source.unknownWrites.map(({ _node, ...s }) => s) })}`,
    );
  if (!ledger) throw new Error("Reviewed write ledger is required");
  const actual = makeLedger(source),
    pinned = new Map(ledger.map((s) => [s.id, s]));
  for (const site of actual) {
    const saved = pinned.get(site.id);
    if (!saved) throw new Error(`Unmapped store: ${site.id}`);
    if (
      saved.sourceSha256 !== site.sourceSha256 ||
      saved.sha256 !== site.sha256 ||
      saved.bodySha256 !== site.bodySha256 ||
      saved.constantEnvironmentSha256 !== site.constantEnvironmentSha256 ||
      saved.rule !== site.rule ||
      saved.target !== site.target
    )
      throw new Error(
        `Changed store/guard/function/configuration requires review: ${site.id}`,
      );
    if (!storeRules[site.rule])
      throw new Error(`Unknown transition ${site.rule}`);
  }
  if (actual.length !== ledger.length)
    throw new Error("Stale write ledger includes removed stores");
  const finite = checkProtocols(),
    flags = proveFlagStores(source),
    data = dataLemmas(source),
    closure = effectClosure(source, actual);
  const mapped = actual.map((s) => ({
    ...s,
    transfer: transferKinds[s.rule],
    transitions: protocols.flatMap((p) =>
      p.edges
        .filter((e) => storeRules[s.rule].events.includes(e.event))
        .map((e) => ({ protocol: p.id, ...e })),
    ),
    ...(s.rule === "flag.store" ? { flagAction: flagAction(s) } : {}),
  }));
  if (mapped.some((s) => !s.transfer || s.transitions.length === 0))
    throw new Error("Store lacks a transition edge/transfer classification");
  return {
    domain:
      "production source view __DEV__=false, __STATS__=false; public-API effect closure, finite local control protocols and guarded flag transfer checks",
    sourceSha256: source.sourceSha256,
    profile: { __DEV__: false, __STATS__: false },
    facts: temporalFacts.map((f) => f.fact),
    handoffs: handoffProtocols.map((p) => ({
      id: p.id,
      from: p.from,
      to: p.to,
    })),
    counts: {
      publicOperations: source.api.length,
      procedures: source.reachable.length,
      writeSites: actual.length,
      persistent: actual.filter((s) => s.kind === "persistent").length,
      scoped: actual.filter((s) => s.kind === "scoped-owner").length,
      protocolStates: finite.reduce((n, p) => n + p.states, 0),
      protocolEdges: finite.reduce((n, p) => n + p.edges, 0),
      flagStates: flags.states,
      flagSites: flags.stores.length,
      flagCases: flags.checkedCases,
    },
    protocols,
    protocolCheck: finite,
    flags,
    data,
    publicClosure: closure,
    ownershipMap: ownershipMap(actual),
    storeRules,
    ledger: mapped,
    localWrites: source.locals.length,
    unknownCalls: [],
    unknownWrites: [],
    claims: {
      allReachableSourceWritesMapped: true,
      publicEffectAlphabetClosed: true,
      localFlagTransfersClosedUnderListedPremises: true,
      finiteProtocolCarriersClosed: true,
      wholeHeapForwardSimulationProved: false,
      allConcretePublicOperationsStateClosureProved: false,
    },
    remainingObligations: [
      "Relational invariant for all intrusive deps/subscriber lists, retired runs and identity uniqueness.",
      "Parametric stack/slot frame lemma across arbitrarily many nested sources; top/cell transient ownership.",
      "Queue ring/hold/capacity arithmetic and logical/physical token relation over unbounded watcher sets.",
      "Numeric version/generation age and SETTLE simulation, including absolute counter wrap.",
      "Caller and callback entry establish each store phase/snapshot premise; cross-protocol forward simulation.",
    ],
    environment: [
      "typed opaque handles; no direct mutation/accessor/proxy replacement of runtime storage",
      "ordinary unmodified intrinsics and successful allocations; no OOM/engine corruption",
      "synchronous callback reentry uses public API and satisfies C1; external payload contents are opaque",
    ],
  };
}

export function writeTransitionArtifacts(report) {
  writeFileSync(
    path.join(root, "research", "TRANSITION-AUDIT.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  const rows = report.ledger.map(
    (s) =>
      `| ${s.id.replaceAll("|", "\\|")} | [${s.file}:${s.line}](../${s.file}#L${s.line}) | ${s.rule} |`,
  );
  writeFileSync(
    path.join(root, "research", "TRANSITION-WRITES.md"),
    "# Production source write map\n\nGenerated by `npm run research:transitions`. Each row is pinned to its normalized store, enclosing function body, constant environment and complete source fingerprint. Each schema expands to the allowed edges in [TRANSITION-AUDIT.json](./TRANSITION-AUDIT.json); selecting an enabled edge still needs its relational premise. This is source coverage, not a discharged heap refinement proof.\n\n| Site | Source | Transition schema |\n| --- | --- | --- |\n" +
      rows.join("\n") +
      "\n",
  );
  const graphs = protocols.map(
    (p, n) =>
      `  subgraph p${n}["${p.id}"]\n` +
      p.states.map((s, i) => `    p${n}s${i}["${s}"]`).join("\n") +
      "\n" +
      p.edges
        .map(
          (e) =>
            `    p${n}s${p.states.indexOf(e.from)} -->|"${e.event}"| p${n}s${p.states.indexOf(e.to)}`,
        )
        .join("\n") +
      "\n  end",
  );
  writeFileSync(
    path.join(root, "research", "TRANSITION-MAP.mmd"),
    "flowchart LR\n" + graphs.join("\n") + "\n",
  );
}
if (process.argv[1]?.endsWith("transition-audit.mjs")) {
  const source = productionSource(),
    ledgerFile = path.join(root, "research", "transition-write-ledger.json");
  if (process.argv.includes("--review-ledger")) {
    if (process.env.QUANT_REVIEW_WRITES !== "1")
      throw new Error(
        "Ledger review is an explicit maintenance operation; set QUANT_REVIEW_WRITES=1 after reviewing source effects",
      );
    writeFileSync(
      ledgerFile,
      JSON.stringify(makeLedger(source), null, 2) + "\n",
    );
  }
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
  const report = auditTransitions({ source, ledger });
  writeTransitionArtifacts(report);
  console.log(JSON.stringify({ counts: report.counts, claims: report.claims }));
}
