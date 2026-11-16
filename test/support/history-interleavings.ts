import { isDeepStrictEqual } from "node:util";
import type { Op } from "../../reference/reflex/test/differential/api";
import {
  certifyHistoryPrefix,
  type Checkpoint,
  type HistoryCase,
} from "./history-erasure";
import type { HistoryScenario } from "./history-erasure-generator";

export interface ScenarioStep {
  readonly side: "A" | "B";
  readonly index: number;
  readonly phase: string;
  readonly operation: Op;
}

export interface ScenarioShuffle {
  readonly word: string;
  readonly steps: readonly ScenarioStep[];
  readonly switches: number;
  readonly interleaved: boolean;
}

function steps(scenario: HistoryScenario, side: "A" | "B"): ScenarioStep[] {
  return scenario.phases
    .flatMap((phase) =>
      phase.operations.map((operation) => ({
        side,
        phase: phase.name,
        operation,
      })),
    )
    .map((step, index) => ({ ...step, index }));
}

/** Operation-granularity shuffles; no cut inside one callback or public operation. */
export function* scenarioShuffles(
  a: HistoryScenario,
  b: HistoryScenario,
): Generator<ScenarioShuffle> {
  const left = steps(a, "A"),
    right = steps(b, "B");
  const path: ScenarioStep[] = [];
  function* walk(i: number, j: number): Generator<ScenarioShuffle> {
    if (i === left.length && j === right.length) {
      const word = path.map((step) => step.side).join("");
      const serialA = "A".repeat(left.length) + "B".repeat(right.length);
      const serialB = "B".repeat(right.length) + "A".repeat(left.length);
      const switches = path.reduce(
        (sum, step, index) =>
          sum + (index > 0 && path[index - 1]!.side !== step.side ? 1 : 0),
        0,
      );
      yield {
        word,
        steps: [...path],
        switches,
        interleaved: word !== serialA && word !== serialB,
      };
      return;
    }
    if (i < left.length) {
      path.push(left[i]!);
      yield* walk(i + 1, j);
      path.pop();
    }
    if (j < right.length) {
      path.push(right[j]!);
      yield* walk(i, j + 1);
      path.pop();
    }
  }
  yield* walk(0, 0);
}

export interface ShuffleClass {
  readonly checkpoint: Checkpoint;
  readonly members: readonly ScenarioShuffle[];
  /** Maximum label alternation, selected without consulting Quant internals. */
  readonly representative: ScenarioShuffle;
}

export interface ShufflePartition {
  readonly base: HistoryCase;
  readonly scenarios: readonly [HistoryScenario, HistoryScenario];
  readonly complete: boolean;
  /** Exact labelled combinatorial bound, even for a budgeted prefix. */
  readonly totalPossible: string;
  readonly generated: number;
  readonly certified: number;
  readonly interleaved: number;
  readonly classes: readonly ShuffleClass[];
  readonly rejections: readonly {
    readonly word: string;
    readonly kind: "open" | "invalid";
    readonly message: string;
  }[];
}

function choose(n: number, k: number): string {
  let count = 1n;
  for (let i = 1; i <= Math.min(k, n - k); i++)
    count = (count * BigInt(n - i + 1)) / BigInt(i);
  return String(count);
}

/** Group only by independently certified checkpoints; retain every implementation path. */
export function partitionHistoryShuffles(
  base: HistoryCase,
  a: HistoryScenario,
  b: HistoryScenario,
  maxHistories?: number,
): ShufflePartition {
  if (!isDeepStrictEqual(base.prefixA, base.prefixB))
    throw new Error("shuffle enumeration requires a common base prefix");
  if (
    maxHistories !== undefined &&
    (!Number.isSafeInteger(maxHistories) || maxHistories < 0)
  )
    throw new Error("maxHistories must be a nonnegative safe integer");
  const root = certifyHistoryPrefix(base, base.prefixA);
  if (root.kind !== "certified")
    throw new Error(`base checkpoint is not certified: ${root.message}`);
  const groups: { checkpoint: Checkpoint; members: ScenarioShuffle[] }[] = [];
  const rejections: {
    word: string;
    kind: "open" | "invalid";
    message: string;
  }[] = [];
  let generated = 0,
    certified = 0,
    interleaved = 0,
    complete = true;
  for (const shuffle of scenarioShuffles(a, b)) {
    if (generated >= (maxHistories ?? Infinity)) {
      complete = false;
      break;
    }
    generated++;
    if (shuffle.interleaved) interleaved++;
    const prefix = [
      ...base.prefixA,
      ...shuffle.steps.map((step) => step.operation),
    ];
    const certificate = certifyHistoryPrefix(base, prefix);
    if (certificate.kind !== "certified") {
      rejections.push({
        word: shuffle.word,
        kind: certificate.kind,
        message: certificate.message,
      });
      continue;
    }
    certified++;
    const group = groups.find((group) =>
      isDeepStrictEqual(group.checkpoint, certificate.checkpoint),
    );
    if (group === undefined)
      groups.push({ checkpoint: certificate.checkpoint, members: [shuffle] });
    else group.members.push(shuffle);
  }
  const classes = groups.map(
    (group): ShuffleClass => ({
      ...group,
      representative: group.members.reduce((best, member) =>
        member.switches > best.switches ? member : best,
      ),
    }),
  );
  const na = steps(a, "A").length,
    nb = steps(b, "B").length;
  return {
    base,
    scenarios: [a, b],
    complete,
    totalPossible: choose(na + nb, na),
    generated,
    certified,
    interleaved,
    classes,
    rejections,
  };
}

/** Star comparisons are transitive for a fixed suffix, but every member is tested. */
export function interleavingCase(
  partition: ShufflePartition,
  group: ShuffleClass,
  member: ScenarioShuffle,
): HistoryCase {
  if (!partition.classes.includes(group) || !group.members.includes(member))
    throw new Error("shuffle is outside its certified class");
  const [a, b] = partition.scenarios;
  const reference = group.representative;
  return {
    ...partition.base,
    id: `${partition.base.id}:open(${a.rule},${b.rule}):${reference.word}/${member.word}`,
    rule: `open(${a.rule},${b.rule})`,
    histories: {
      a: [`open:${a.rule}`, `open:${b.rule}`],
      b: [`open:${a.rule}`, `open:${b.rule}`],
    },
    prefixA: [
      ...partition.base.prefixA,
      ...reference.steps.map((step) => step.operation),
    ],
    prefixB: [
      ...partition.base.prefixA,
      ...member.steps.map((step) => step.operation),
    ],
  };
}
