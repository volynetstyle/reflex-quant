import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

// Wire representation preserves undefined, NaN and negative zero in observations.
const wire = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, item) =>
      item === undefined
        ? { $scalar: "undefined" }
        : typeof item === "number" &&
            (!Number.isFinite(item) || Object.is(item, -0))
          ? { $scalar: String(item), negativeZero: Object.is(item, -0) }
          : item,
    ),
  );

function publicState(machine, model) {
  return [...machine.handles]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, { kind, node }]) => ({
      id,
      kind,
      disposed: model ? node.disposed : kind !== "signal" && node.fn === null,
      ...(kind === "effect"
        ? {
            cleanup: model
              ? node.cleanup !== undefined
              : typeof node.value === "function",
          }
        : { value: node.value }),
    }));
}
function state(machine, model, runtime) {
  const names = new Map(
    [...machine.handles].map(([id, handle]) => [handle.node, id]),
  );
  const relations = model
    ? [...runtime.births].flatMap(([s, subs]) =>
        [...subs.keys()].map((c) => `${names.get(s)}>${names.get(c)}`),
      )
    : [...machine.handles].flatMap(([id, handle]) => {
        const deps = [];
        for (let e = handle.node.firstDep; e !== null; e = e.nextDep)
          deps.push(`${names.get(e.from)}>${id}`);
        return deps;
      });
  return {
    public: publicState(machine, model),
    program: machine.programState(),
    relations: relations.sort(),
  };
}
function nativePort(runtime, auto) {
  let machine;
  const { api, kernel, host } = runtime;
  const port = {
    signal: api.signal,
    computed: api.computed,
    effect: (fn) => (auto ? api.effect(fn) : host.watcher(fn, false)),
    read: kernel.read,
    write: auto ? api.set : kernel.write,
    dispose: api.dispose,
    run: host.run,
    batch: host.batch,
    untracked: kernel.untracked,
    flush: () => {
      if (auto) return host.flush();
      let failed = false,
        first;
      for (const handle of machine.handles.values())
        if (handle.kind === "effect") {
          try {
            host.run(handle.node);
          } catch (error) {
            if (!failed) first = error;
            failed = true;
          }
        }
      if (failed) throw first;
    },
  };
  return {
    port,
    setMachine: (value) => {
      machine = value;
    },
  };
}
function audit(runtime, oracle) {
  const { Queued, Watch, Checking } = oracle.boundaryFlags;
  const k = runtime.kernel.__boundaryRoots(),
    h = runtime.host.__boundaryRoots();
  if (
    k.active !== null ||
    k.cursor !== null ||
    k.top !== 0 ||
    k.slots.some((s) => s !== null)
  )
    throw new Error("kernel scope/slot root survived operation");
  if (
    h.hold !== 0 ||
    h.size !== 0 ||
    h.head !== 0 ||
    h.slots.some((s) => s !== null)
  )
    throw new Error("queue token/cell or hold survived drain");
  for (const node of runtime.graph.__boundaryNodes) {
    if (
      runtime.graph.__handoffBirthRoles &&
      runtime.graph.__handoffBirthRoles.get(node) !==
        Boolean(node.flags & Watch)
    )
      throw new Error("node changed its immutable Watch/Checking role");
    if (node.flags & Queued)
      throw new Error("QUEUED flag without a queue cell");
    if (!(node.flags & Watch) && node.flags & Checking)
      throw new Error("CHECKING survived validation interval");
    if (
      node.flags & Watch &&
      node.fn === null &&
      (node.firstDep !== null ||
        node.slot !== null ||
        typeof node.value === "function")
    )
      throw new Error(
        "disposed/unpublished watcher retained dependencies, slot or cleanup",
      );
  }
  oracle.checkGraph(runtime.graph.__boundaryNodes, "temporal boundary");
}

export async function observeBoundaryCorpus(
  bundle,
  oracle,
  { only, suite } = {},
) {
  const all =
    suite === "handoffs"
      ? oracle.handoffPrograms()
      : [
          ...(suite === "transitions" ? oracle.handoffPrograms() : []),
          ...oracle.boundaryPrograms(),
          ...oracle.imperativeCases(),
          ...oracle.composedCallbackCases(),
        ];
  const traces = [],
    coverage = [],
    excluded = [];
  for (const program of all) {
    if (only && !program.id.includes(only)) continue;
    // Admission depends only on the independent model, before either engine runs.
    const preflight = new oracle.ImperativeSpec(program.auto),
      preMachine = new oracle.ImperativeMachine(preflight);
    for (const op of program.operations) {
      try {
        preMachine.execute(op);
      } catch {
        /* classified by model domain flags below */
      }
    }
    if (preflight.invalid || preMachine.domainViolation) {
      excluded.push(program.id);
      continue;
    }
    const runtime = await import(
      pathToFileURL(bundle).href + "?world=" + traces.length
    );
    const spec = new oracle.ImperativeSpec(program.auto),
      expectedMachine = new oracle.ImperativeMachine(spec);
    const port = nativePort(runtime, program.auto),
      actualMachine = new oracle.ImperativeMachine(port.port);
    port.setMachine(actualMachine);
    const observations = [];
    let relationIdentity;
    for (let at = 0; at < program.operations.length; at++) {
      const expected = {
        observation: expectedMachine.execute(program.operations[at]),
        ...state(expectedMachine, true, spec),
      };
      let actual;
      runtime.graph.__historyBeginRetirement();
      try {
        actual = {
          observation: actualMachine.execute(program.operations[at]),
          ...state(actualMachine, false),
        };
      } catch (error) {
        return {
          kind: "killed",
          oracle: "implementation",
          program: program.id,
          at,
          message: String(error),
          indexed: runtime.kernel.stats.indexed,
          retainedSourceSlots: runtime.graph.__boundaryNodes.filter(
            (n) => n.slot !== null,
          ).length,
        };
      } finally {
        // Registry is always drained, including errors. It is not a physical GC oracle.
        oracle.auditRetiredEdges(runtime.graph.__historyTakeRetirements());
      }
      try {
        audit(runtime, oracle);
      } catch (error) {
        return {
          kind: "killed",
          oracle: "structure",
          program: program.id,
          at,
          message: String(error),
          indexed: runtime.kernel.stats.indexed,
          retainedSourceSlots: runtime.graph.__boundaryNodes.filter(
            (n) => n.slot !== null,
          ).length,
        };
      }
      if (!isDeepStrictEqual(expected, actual))
        return {
          kind: "killed",
          oracle: "implementation",
          program: program.id,
          at,
          expected: wire(expected.observation),
          actual: wire(actual.observation),
        };
      observations.push(wire(actual.observation));
      const relation = program.relationIdentity;
      if (relation && (at === relation.before || at === relation.after)) {
        const source = actualMachine.handles.get(relation.source).node;
        let edge = actualMachine.handles.get(relation.consumer).node.firstDep;
        while (edge && edge.from !== source) edge = edge.nextDep;
        if (!edge)
          return {
            kind: "coverage-gap",
            program: program.id,
            at,
            message: "relation identity witness absent",
          };
        if (at === relation.before) relationIdentity = edge;
        else if (relationIdentity !== edge)
          return {
            kind: "killed",
            oracle: "structure",
            program: program.id,
            at,
            message:
              "tentative-to-committed handoff replaced existing relation identity",
          };
      }
    }
    const scopes = runtime.kernel.__boundaryScopes;
    if (program.workBound && (scopes.peak < 2 || scopes.displaced === 0))
      return {
        kind: "coverage-gap",
        program: program.id,
        message: "work witness never displaced an outer slot owner",
      };
    if (
      program.workBound &&
      runtime.kernel.stats.indexed > program.workBound.indexed
    )
      return {
        kind: "killed",
        oracle: "structure-work",
        program: program.id,
        message: "nested slot handoff rebuilds parent's full index",
        indexed: runtime.kernel.stats.indexed,
        bound: program.workBound.indexed,
      };
    const roles = runtime.kernel.__handoffRoles;
    if (
      program.family === "handoff-alias" &&
      roles?.dev &&
      roles.simultaneous === 0
    )
      return {
        kind: "coverage-gap",
        program: program.id,
        message: "alias roles never coexist",
      };
    if (
      program.indexed &&
      (scopes.peak < Number(program.phase[0]) || scopes.displaced === 0)
    )
      return {
        kind: "coverage-gap",
        program: program.id,
        scopes: { peak: scopes.peak, displaced: scopes.displaced },
      };
    coverage.push({
      id: program.id,
      family: program.family ?? "existing",
      phase: program.phase,
      facts: program.facts ?? [],
      operations: program.operations.length,
      indexes: runtime.kernel.stats.indexes,
      ...(program.workBound
        ? {
            indexedWork: runtime.kernel.stats.indexed,
            workBound: program.workBound,
          }
        : {}),
      peakIndexOwners: scopes.peak,
      displacedSlots: scopes.displaced,
      ...(roles
        ? {
            aliasRoles: roles,
            relationIdentityPreserved: program.relationIdentity
              ? true
              : undefined,
          }
        : {}),
    });
    if (runtime.transfer)
      coverage.at(-1).flagTransfers = { ...runtime.transfer.counts };
    traces.push({ id: program.id, observations });
  }
  return {
    kind: "pass",
    checked: traces.length,
    excluded,
    coverage,
    traceSha256: createHash("sha256")
      .update(JSON.stringify(traces))
      .digest("hex"),
    traces,
  };
}

if (process.argv[2] === "--child") {
  const oracle = await import(pathToFileURL(process.argv[4]).href);
  let result;
  try {
    result = await observeBoundaryCorpus(process.argv[3], oracle, {
      only: process.env.QUANT_BOUNDARY_ONLY,
      suite: process.env.QUANT_TEMPORAL_SUITE,
    });
  } catch (error) {
    result = { kind: "killed", oracle: "structure", message: String(error) };
  }
  writeFileSync(process.argv[5], JSON.stringify(result));
}
