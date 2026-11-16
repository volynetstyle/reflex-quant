import { isDeepStrictEqual } from "node:util";
import {
  ins as i,
  ix as x,
  type IBody,
  type Instruction,
} from "./imperative-language";
import {
  compareImperative,
  compareImperativeHistories,
  specImperative,
  type ImperativeHistory,
  type ImperativeProgram,
} from "./imperative-worlds";
import type { ResearchOptions } from "./research-quant";

function features(
  value: unknown,
  path = "",
  out = new Map<string, number | string>(),
): Map<string, number | string> {
  if (typeof value === "number" || typeof value === "string")
    out.set(path, value);
  else if (typeof value === "boolean") out.set(path, Number(value));
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      features(item, `${path}/${key}`, out);
  return out;
}
export function scarDistance(a: unknown, b: unknown): number {
  const left = features(a),
    right = features(b);
  let distance = 0;
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const x = left.get(key),
      y = right.get(key);
    distance +=
      typeof x === "number" && typeof y === "number"
        ? Math.abs(
            Math.sign(x) * Math.log1p(Math.abs(x)) -
              Math.sign(y) * Math.log1p(Math.abs(y)),
          )
        : x === y
          ? 0
          : 1;
  }
  return distance;
}

export async function searchScars(
  candidates: Iterable<ImperativeProgram>,
  options: ResearchOptions & {
    maxCandidates: number;
    stagnation: number;
    onAdmitted?: (sample: {
      program: ImperativeProgram;
      fingerprint: unknown;
      novel: boolean;
    }) => void;
  },
) {
  if (
    !Number.isSafeInteger(options.maxCandidates) ||
    options.maxCandidates < 1 ||
    !Number.isSafeInteger(options.stagnation) ||
    options.stagnation < 1
  )
    throw new Error("invalid scar-search budget");
  const groups: {
    checkpoint: ReturnType<ReturnType<typeof specImperative>["checkpoint"]>;
    members: { program: ImperativeProgram; fingerprint: unknown }[];
  }[] = [];
  let evaluated = 0,
    admitted = 0,
    rejected = 0,
    novel = 0,
    quiet = 0;
  const fingerprints = new Set<string>();
  let best:
    | {
        distance: number;
        checkpoint: unknown;
        history: ImperativeHistory;
        fingerprints: readonly unknown[];
      }
    | undefined;
  let status: "exhausted" | "budget" | "saturated" = "exhausted";
  for (const program of candidates) {
    if (evaluated >= options.maxCandidates) {
      status = "budget";
      break;
    }
    evaluated++;
    const spec = specImperative(program.auto);
    try {
      for (const op of program.operations) spec.machine.execute(op);
    } catch {
      rejected++;
      continue;
    }
    const checkpoint = spec.checkpoint();
    if (
      !checkpoint.ready ||
      spec.runtime.invalid !== undefined ||
      spec.machine.domainViolation !== undefined
    ) {
      rejected++;
      continue;
    }
    const run = await compareImperative(program, options);
    if (run.kind !== "pass")
      return {
        status: "counterexample" as const,
        evaluated,
        admitted,
        rejected,
        novel,
        candidate: program,
        result: run,
      };
    admitted++;
    const key = JSON.stringify(run.fingerprint);
    const isNew = !fingerprints.has(key);
    if (!isNew) quiet++;
    else {
      fingerprints.add(key);
      novel++;
      quiet = 0;
    }
    options.onAdmitted?.({
      program,
      fingerprint: run.fingerprint,
      novel: isNew,
    });
    let group = groups.find((group) =>
      isDeepStrictEqual(group.checkpoint, checkpoint),
    );
    if (group === undefined) {
      group = { checkpoint, members: [] };
      groups.push(group);
    }
    for (const member of group.members) {
      const distance = scarDistance(member.fingerprint, run.fingerprint);
      if (best === undefined || distance > best.distance)
        best = {
          distance,
          checkpoint,
          history: {
            id: `scar:${member.program.id}/${program.id}`,
            auto: program.auto,
            prefixA: member.program.operations,
            prefixB: program.operations,
            suffix: [],
          },
          fingerprints: [member.fingerprint, run.fingerprint],
        };
    }
    group.members.push({ program, fingerprint: run.fingerprint });
    if (quiet >= options.stagnation) {
      status = "saturated";
      break;
    }
  }
  return {
    status,
    evaluated,
    admitted,
    rejected,
    novel,
    classes: groups.length,
    selected: best,
  };
}

/** Coverage-guided generation: only independently admitted novel scars become parents. */
export async function evolveScars(
  options: ResearchOptions & {
    seed: number;
    maxCandidates: number;
    stagnation: number;
    maxBlocks?: number;
  },
) {
  const maxBlocks = options.maxBlocks ?? 8;
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1)
    throw new Error("invalid scar block bound");
  const base = scarCandidates(1)[0]!;
  const blocks: IBody[] = [
    [
      i.set("branch", x.value(1)),
      i.set("failure", x.value(1)),
      i.set("failure", x.value(0)),
      i.set("branch", x.value(0)),
      i.set("a", x.value(1)),
      i.set("a", x.value(0)),
    ],
    [
      i.set("a", x.value(1)),
      i.set("a", x.value(0)),
      i.set("failure", x.value(1)),
      i.set("branch", x.value(1)),
      i.set("failure", x.value(0)),
      i.set("branch", x.value(0)),
    ],
    [
      i.set("branch", x.value(1)),
      i.set("branch", x.value(0)),
      i.set("a", x.value(1)),
      i.set("failure", x.value(1)),
      i.set("a", x.value(0)),
      i.set("failure", x.value(0)),
    ],
  ];
  let randomState = options.seed >>> 0 || 1;
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) / 0x100000000;
  };
  const genomes = new Map<string, number[]>();
  const corpus: { genome: number[]; weight: number }[] = [];
  let firstFingerprint: unknown;
  function* generate(): Generator<ImperativeProgram> {
    let serial = 0;
    for (;;) {
      let genome: number[];
      if (serial === 0) genome = [];
      else if (serial <= blocks.length) genome = [serial - 1];
      else {
        const total = corpus.reduce((sum, parent) => sum + parent.weight, 0);
        let pick = random() * total;
        const parent =
          corpus.find((entry) => (pick -= entry.weight) <= 0) ?? corpus[0]!;
        genome = [...parent.genome];
        const action = Math.floor(random() * 4);
        if (action === 0 && genome.length)
          genome.splice(Math.floor(random() * genome.length), 1);
        else if (action === 1 && genome.length > 1) genome.reverse();
        else if (action === 2 && genome.length)
          genome[Math.floor(random() * genome.length)] = Math.floor(
            random() * blocks.length,
          );
        else if (genome.length < maxBlocks)
          genome.splice(
            Math.floor(random() * (genome.length + 1)),
            0,
            Math.floor(random() * blocks.length),
          );
      }
      const id = `evolved-${serial++}:${genome.join(".")}`;
      genomes.set(id, genome);
      yield {
        ...base,
        id,
        operations: [
          ...base.operations,
          ...genome.flatMap((index) => blocks[index]!),
        ],
      };
    }
  }
  const search = await searchScars(generate(), {
    ...options,
    onAdmitted: ({ program, fingerprint, novel }) => {
      if (!novel) return;
      firstFingerprint ??= fingerprint;
      corpus.push({
        genome: [...genomes.get(program.id)!],
        weight: 1 + scarDistance(firstFingerprint, fingerprint),
      });
    },
  });
  return { seed: options.seed, maxBlocks, corpusSize: corpus.length, search };
}

export async function searchImperativeContinuations(
  history: ImperativeHistory,
  alphabet: readonly Instruction[],
  depth: number,
  options: ResearchOptions = {},
) {
  if (!Number.isInteger(depth) || depth < 0)
    throw new Error("invalid continuation depth");
  const root = await compareImperativeHistories(
    { ...history, suffix: [] },
    options,
  );
  if (root.kind !== "pass")
    return {
      status: "counterexample" as const,
      completedDepth: -1,
      checked: 0,
      result: root,
      suffix: [],
    };
  let frontier: IBody[] = [[]],
    checked = 0,
    rejected = 0,
    completedDepth = 0;
  for (let d = 1; d <= depth; d++) {
    const next: IBody[] = [];
    for (const prefix of frontier)
      for (const operation of alphabet) {
        const suffix = [...prefix, operation];
        const result = await compareImperativeHistories(
          { ...history, suffix },
          options,
        );
        if (result.kind === "ineligible") {
          rejected++;
          continue;
        }
        checked++;
        if (result.kind !== "pass")
          return {
            status: "counterexample" as const,
            completedDepth,
            checked,
            rejected,
            suffix,
            result,
          };
        next.push(suffix);
      }
    frontier = next;
    completedDepth = d;
  }
  return { status: "equivalent" as const, completedDepth, checked, rejected };
}

export function scarCandidates(count = 12): ImperativeProgram[] {
  return Array.from({ length: count }, (_, cycles) => {
    const prefix: Instruction[] = [
      i.signal("a", 0),
      i.signal("b", 0),
      i.signal("branch", 0),
      i.signal("failure", 0),
      i.computed("c", [
        i.when(x.read("failure"), [i.fail("c")]),
        i.when(x.read("branch"), [i.ret(x.read("b"))]),
        i.ret(x.read("a")),
      ]),
      i.effect("w", [i.read("c")], [i.log("cleanup", x.read("a"))]),
    ];
    for (let n = 0; n < cycles; n++)
      prefix.push(
        i.set("branch", x.value(1)),
        i.set("failure", x.value(1)),
        i.set("failure", x.value(0)),
        i.set("branch", x.value(0)),
        i.set("a", x.value(1)),
        i.set("a", x.value(0)),
      );
    return { id: `scar-cycles-${cycles}`, auto: true, operations: prefix };
  });
}
