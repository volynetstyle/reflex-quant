// Exhaustive finite-alphabet continuation search. Replay branches instead of
// restoring runtime fields, and never merge paths on the spec state alone.
import { isDeepStrictEqual } from "node:util";
import {
  expr as e,
  op,
  type Op,
  type Value,
} from "../../reference/reflex/test/differential/api";
import {
  createHistoryQuantWorld,
  historyContinuationIsValid,
  runHistoryCase,
  type HistoryCase,
  type HistoryResult,
  type QuantWorld,
} from "./history-erasure";

export const continuationClasses = [
  "read",
  "write",
  "flush",
  "dispose",
  "new-node",
  "failure",
] as const;
export type ContinuationClass = (typeof continuationClasses)[number];
export type ContinuationCoverage = Record<
  string,
  Record<ContinuationClass, number>
>;

export interface SearchOptions {
  readonly maxDepth: number;
  /** The exact finite operation alphabet; inadmissible words are excluded. */
  readonly alphabet: readonly Op[];
  /** A cut-off produces an incomplete result, never a bounded-equivalence claim. */
  readonly maxTransitions?: number;
  /** Original suffix envelopes do not apply to newly generated continuations. */
  readonly envelopes?: (suffix: readonly Op[]) => HistoryCase["bounds"];
}

export interface SearchResult {
  readonly status:
    | "equivalent"
    | "counterexample"
    | "incomplete"
    | "ineligible";
  readonly requestedDepth: number;
  readonly completedDepth: number;
  readonly transitions: number;
  readonly rejected: number;
  readonly alphabet: readonly Op[];
  readonly levels: readonly {
    readonly depth: number;
    readonly transitions: number;
  }[];
  readonly coverage: ContinuationCoverage;
  /** Diagnostic only: none of these collisions prune implementation paths. */
  readonly distinctSpecStates: number;
  readonly repeatedSpecStates: number;
  readonly witness?: {
    readonly depth: number;
    readonly test: HistoryCase;
    readonly result: HistoryResult;
  };
}

/** Reads/writes cover every public node; caller supplies the finite declaration templates. */
export function continuationAlphabet(
  test: HistoryCase,
  values: readonly Value[] = [0, 1],
  declarations: readonly Op[] = [],
): Op[] {
  const definitions = new Map(
    test.prefixA.flatMap((operation) =>
      operation.type === "signal" ||
      operation.type === "computed" ||
      operation.type === "effect"
        ? [[operation.id, operation] as const]
        : [],
    ),
  );
  const alphabet: Op[] = [op.flush()];
  const add = (id: string, kind: "signal" | "computed" | "effect") => {
    if (kind === "signal")
      alphabet.push(...values.map((value) => op.set(id, value)));
    if (kind === "effect") alphabet.push(op.dispose(id));
    else alphabet.push(op.read(id));
  };
  for (const id of test.handles) {
    const declaration = definitions.get(id);
    if (declaration === undefined)
      throw new Error(`missing alphabet handle ${id}`);
    add(id, declaration.type);
  }
  for (const declaration of declarations) {
    if (
      declaration.type !== "signal" &&
      declaration.type !== "computed" &&
      declaration.type !== "effect"
    )
      throw new Error("declaration template is not a declaration");
    alphabet.push(declaration);
    add(declaration.id, declaration.type);
  }
  return alphabet.filter(
    (operation, index) =>
      !alphabet
        .slice(0, index)
        .some((other) => isDeepStrictEqual(operation, other)),
  );
}

/** Small optional templates, named explicitly so the searched language is replayable. */
export function continuationDeclarations(
  readable: string,
  computed = "nextComputed",
  watcher = "nextWatcher",
): Op[] {
  return [
    op.computed(computed, e.read(readable)),
    op.watcher(watcher, e.read(readable), { cleanup: e.read(readable) }),
  ];
}

function operationClass(operation: Op): ContinuationClass {
  switch (operation.type) {
    case "read":
      return "read";
    case "set":
      return "write";
    case "flush":
      return "flush";
    case "dispose":
      return "dispose";
    case "signal":
    case "computed":
    case "effect":
      return "new-node";
    default:
      throw new Error("batch operations are outside continuation search");
  }
}

function stateKey(state: unknown): string {
  // Preserve Object.is distinctions and undefined; JSON's NaN/-0/null collapse
  // is unsuitable even for a diagnostic count of spec-state collisions.
  if (state === undefined) return "u";
  if (state === null) return "null";
  if (typeof state === "number")
    return `n:${Object.is(state, -0) ? "-0" : String(state)}`;
  if (typeof state !== "object")
    return `${typeof state}:${JSON.stringify(state)}`;
  if (Array.isArray(state)) return `[${state.map(stateKey).join(",")}]`;
  return `{${Object.entries(state)
    .map(([key, value]) => `${JSON.stringify(key)}:${stateKey(value)}`)
    .join(",")}}`;
}

/** Breadth first: a failure depth is minimal within the reported finite alphabet. */
export async function searchHistoryContinuations(
  test: HistoryCase,
  options: SearchOptions,
  factory: () => Promise<QuantWorld> = createHistoryQuantWorld,
): Promise<SearchResult> {
  if (!Number.isInteger(options.maxDepth) || options.maxDepth < 0)
    throw new Error("maxDepth must be a nonnegative integer");
  if (
    options.maxTransitions !== undefined &&
    (!Number.isInteger(options.maxTransitions) || options.maxTransitions < 0)
  )
    throw new Error("maxTransitions must be a nonnegative integer");
  const alphabet = options.alphabet.filter(
    (operation, index) =>
      !options.alphabet
        .slice(0, index)
        .some((other) => isDeepStrictEqual(operation, other)),
  );
  alphabet.forEach(operationClass);
  const residues = [
    ...new Set(
      test.histories === undefined
        ? [test.rule]
        : [...test.histories.a, ...test.histories.b],
    ),
  ];
  const coverage: ContinuationCoverage = Object.fromEntries(
    residues.map((rule) => [
      rule,
      Object.fromEntries(
        continuationClasses.map((kind) => [kind, 0]),
      ) as Record<ContinuationClass, number>,
    ]),
  );
  let completedDepth = -1;
  let transitions = 0;
  let rejected = 0;
  let repeatedSpecStates = 0;
  const states = new Set<string>();
  const levels: { depth: number; transitions: number }[] = [];
  const finish = (
    status: SearchResult["status"],
    witness?: SearchResult["witness"],
  ): SearchResult => ({
    status,
    requestedDepth: options.maxDepth,
    completedDepth,
    transitions,
    rejected,
    alphabet,
    levels,
    coverage,
    distinctSpecStates: states.size,
    repeatedSpecStates,
    ...(witness === undefined ? {} : { witness }),
  });
  const base: HistoryCase = { ...test, suffix: [], bounds: [] };
  const initial = await runHistoryCase(base, factory, { endpoint: "open" });
  if (initial.kind !== "pass")
    return finish(
      initial.kind === "ineligible" ? "ineligible" : "counterexample",
      { depth: 0, test: base, result: initial },
    );
  states.add(stateKey(initial.continuation));
  completedDepth = 0;
  let frontier: (readonly Op[])[] = [[]];
  for (let depth = 1; depth <= options.maxDepth; depth++) {
    const next: (readonly Op[])[] = [];
    const level = { depth, transitions: 0 };
    levels.push(level);
    for (const prefix of frontier)
      for (const operation of alphabet) {
        const suffix = [...prefix, operation];
        const candidate: HistoryCase = {
          ...base,
          suffix,
          bounds: options.envelopes?.(suffix) ?? [],
        };
        if (!historyContinuationIsValid(candidate)) {
          rejected++;
          continue;
        }
        if (transitions >= (options.maxTransitions ?? Infinity))
          return finish("incomplete");
        const result = await runHistoryCase(candidate, factory, {
          endpoint: "open",
        });
        transitions++;
        level.transitions++;
        for (const rule of residues) {
          coverage[rule]![operationClass(operation)]++;
          if (result.lastObservation?.error !== undefined)
            coverage[rule]!.failure++;
        }
        if (result.kind !== "pass")
          return finish(
            result.kind === "ineligible" ? "ineligible" : "counterexample",
            { depth, test: candidate, result },
          );
        const key = stateKey(result.continuation);
        if (states.has(key)) repeatedSpecStates++;
        else states.add(key);
        next.push(suffix);
      }
    completedDepth = depth;
    frontier = next;
  }
  return finish("equivalent");
}
