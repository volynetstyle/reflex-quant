// Test-owned strong references exist only between operation entry and audit.
import type { Edge } from "../../src/graph";

export type RetirementRecord =
  | { kind: "cut"; edges: Edge[] }
  | { kind: "unlink"; edge: Edge };

export interface RetirementCounts {
  edges: number;
  cutRuns: number;
  cutEdges: number;
  singleEdges: number;
}

export interface RetirementPort {
  __historyBeginRetirement(): void;
  __historyTakeRetirements(): RetirementRecord[];
  __historyRetirementState(): { active: boolean; records: number };
}

function requireRetirement(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) throw new Error(`retirement integrity: ${message}`);
}

/** Drain even on failure; no retired identity escapes in the result/error. */
export function auditRetiredEdges(
  records: RetirementRecord[],
): RetirementCounts {
  try {
    const groups = new Map<Edge, number>();
    const retired = new Set<Edge>();
    let cutRuns = 0;
    let cutEdges = 0;
    for (const record of records) {
      if (record.kind === "unlink") {
        requireRetirement(
          !retired.has(record.edge),
          "identity unlinked twice in one operation",
        );
        retired.add(record.edge);
      } else {
        const group = cutRuns++;
        for (const edge of record.edges) {
          requireRetirement(
            !groups.has(edge),
            "identity belongs to multiple cut runs",
          );
          groups.set(edge, group);
          cutEdges++;
        }
      }
    }
    for (const edge of groups.keys())
      requireRetirement(
        retired.has(edge),
        "cut run contains an identity which was not unlinked",
      );
    for (const edge of retired) {
      requireRetirement(
        edge.prevSub === null && edge.nextSub === null,
        "retired subscriber retains a neighbour",
      );
      const group = groups.get(edge);
      if (group === undefined) {
        // The current kernel's non-cut removal path is failed tentative pruning.
        requireRetirement(
          edge.prevDep === null && edge.nextDep === null,
          "individually retired dependency retains a neighbour",
        );
      } else {
        for (const neighbour of [edge.prevDep, edge.nextDep])
          requireRetirement(
            neighbour === null || groups.get(neighbour) === group,
            "cut dependency points outside its own retired run",
          );
      }
    }
    return {
      edges: retired.size,
      cutRuns,
      cutEdges,
      singleEdges: retired.size - cutEdges,
    };
  } finally {
    for (const record of records)
      if (record.kind === "cut") record.edges.length = 0;
    records.length = 0;
  }
}

/** Appended to graph.ts only by Vitest, never to source or release bundles. */
export const retirementInstrumentation = `
type __HistoryRetirement = { kind: "cut"; edges: Edge[] } | { kind: "unlink"; edge: Edge };
let __historyRetirements: __HistoryRetirement[] | null = null;
export function __historyBeginRetirement(): void {
  if (__historyRetirements !== null) throw new Error("retirement collection already active");
  __historyRetirements = [];
}
export function __historyTakeRetirements(): __HistoryRetirement[] {
  const records = __historyRetirements ?? [];
  __historyRetirements = null;
  return records;
}
export function __historyRetirementState() {
  return { active: __historyRetirements !== null, records: __historyRetirements?.length ?? 0 };
}
function __historyRecordCut(edge: Edge | null): void {
  if (__historyRetirements === null || edge === null) return;
  const edges: Edge[] = [];
  const seen = new Set<Edge>();
  for (; edge !== null; edge = edge.nextDep) {
    if (seen.has(edge)) throw new Error("cyclic retirement candidate run");
    seen.add(edge);
    edges.push(edge);
  }
  __historyRetirements.push({ kind: "cut", edges });
}
function __historyRecordUnlink(edge: Edge): void {
  if (__historyRetirements !== null) __historyRetirements.push({ kind: "unlink", edge });
}
`;

/** Capture identities before either unlink operation modifies its neighbours. */
export function instrumentRetirement(code: string): string {
  const hooks = [
    [
      "cutDeps",
      "__historyRecordCut(last === null ? c.firstDep : last.nextDep);",
    ],
    ["unlinkSub", "__historyRecordUnlink(e);"],
  ] as const;
  for (const [name, statement] of hooks) {
    const declaration = new RegExp(
      `export function ${name}\\([^)]*\\): void \\{`,
    );
    if (!declaration.test(code))
      throw new Error(`missing retirement instrumentation boundary: ${name}`);
    code = code.replace(declaration, (match) => `${match}\n  ${statement}`);
  }
  return code + retirementInstrumentation;
}
