import { describe, expect, it } from "vitest";
import { boundaryPrograms } from "./support/temporal-boundaries";
import { compareImperative } from "./support/imperative-worlds";

describe("temporal ownership boundaries", () => {
  for (const program of boundaryPrograms())
    it(program.id, async () => {
      const result = await compareImperative(program);
      expect(result.kind, JSON.stringify(result)).toBe("pass");
      if (result.kind === "pass" && program.indexed)
        expect(result.fingerprint.work.indexes).toBeGreaterThanOrEqual(2);
      if (result.kind === "pass" && program.family === "first-error") {
        const constructor = program.operations.findIndex(op => op.type === "effect" && op.id === "rollback");
        const observation = result.observations[constructor]!;
        expect(observation.error?.message).toBe("body-A");
        expect(observation.events).toEqual([
          {id: "rollback", phase: "run"},
          {id: "bodyError", phase: "run"},
          {id: "cleanupOwner", phase: "cleanup"},
          {id: "siblingError", phase: "run"},
          {id: "rollback", phase: "cleanup"},
        ]);
      }
    });
  for (const counterMask of [3, 7] as const)
    it(`replays epoch boundaries at counter mask ${counterMask}`, async () => {
      const program = boundaryPrograms().find(
        (program) => program.family === "epochs",
      )!;
      const result = await compareImperative(program, { counterMask });
      expect(result.kind, JSON.stringify(result)).toBe("pass");
    });
});
