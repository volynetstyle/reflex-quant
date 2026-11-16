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
    });
});
