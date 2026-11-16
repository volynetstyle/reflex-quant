import { describe, expect, it } from "vitest";
import { handoffPrograms } from "./support/temporal-handoffs";
import {
  compareImperative,
  quantImperative,
} from "./support/imperative-worlds";

describe("coupled temporal ownership", () => {
  for (const program of handoffPrograms())
    it(program.id, async () => {
      const result = await compareImperative(program);
      expect(result.kind, JSON.stringify(result)).toBe("pass");
      if (result.kind === "pass" && program.workBound)
        expect(result.fingerprint.work.indexed).toBeLessThanOrEqual(
          program.workBound.indexed,
        );
      if (result.kind === "pass" && program.family === "handoff-cleanup") {
        const events = result.observations.flatMap((o) => o.events) as {
          id: string;
          phase: string;
          epoch: number;
        }[];
        expect(
          events.filter((e) => e.phase === "cleanup").map((e) => e.epoch),
        ).toEqual(program.phase === "body" ? [1, 3] : [1, 2]);
      }
      if (program.relationIdentity) {
        const world = await quantImperative(program.auto),
          witness = program.relationIdentity;
        let identity: unknown;
        for (let n = 0; n < program.operations.length; n++) {
          world.execute(program.operations[n]!);
          if (n === witness.before || n === witness.after) {
            const from = world.machine.handles.get(witness.source)!.node;
            let edge = world.machine.handles.get(witness.consumer)!.node
              .firstDep;
            while (edge && edge.from !== from) edge = edge.nextDep;
            expect(edge).not.toBeNull();
            if (n === witness.before) identity = edge;
            else expect(edge === identity).toBe(true);
          }
        }
      }
    });
});
