import { describe, expect, it } from "vitest";
import {
  ins as i,
  ix as x,
  type Instruction,
} from "./support/imperative-language";
import { compareImperative } from "./support/imperative-worlds";
import { loadResearchQuant } from "./support/research-quant";

function* words(
  alphabet: readonly Instruction[],
  depth: number,
  prefix: readonly Instruction[] = [],
): Generator<readonly Instruction[]> {
  if (prefix.length !== 0) yield prefix;
  if (prefix.length === depth) return;
  for (const op of alphabet) yield* words(alphabet, depth, [...prefix, op]);
}

describe("finite version and generation domains", () => {
  for (const counterMask of [3, 7, 15] as const) {
    it(`uses the actual kernel with ver/gen mask ${counterMask}`, async () => {
      const runtime = await loadResearchQuant({ counterMask });
      const s = runtime.api.signal(0),
        c = runtime.api.computed(() => runtime.api.get(s));
      runtime.api.get(c);
      for (let n = 1; n <= counterMask + 1; n++) {
        runtime.api.set(s, n);
        runtime.api.get(c);
      }
      expect((s as unknown as { ver: number }).ver).toBe(0);
      expect((c as unknown as { gen: number }).gen).toBe(1);
      runtime.audit();
    });
    it(`exhausts 120 suffixes after repeated failure/recovery and multiple wraps, mask ${counterMask}`, async () => {
      const toggle = i.when(
        x.equal(x.read("a"), x.value(0)),
        [i.set("a", x.value(1))],
        [i.set("a", x.value(0))],
      );
      const base: Instruction[] = [
        i.signal("a", 0),
        i.signal("failure", 0),
        i.computed("c", [
          i.when(x.read("failure"), [i.fail("c")]),
          i.ret(x.read("a")),
        ]),
        i.effect("w", [i.read("c")]),
      ];
      for (let n = 0; n < 4 * (counterMask + 1) + 2; n++) {
        base.push(toggle);
        if (n % 3 === 0)
          base.push(i.set("failure", x.value(1)), i.set("failure", x.value(0)));
      }
      let checked = 0;
      for (const suffix of words([toggle, i.read("c"), i.flush()], 4)) {
        const result = await compareImperative(
          {
            id: `mask-${counterMask}-suffix-${checked}`,
            auto: true,
            operations: [...base, ...suffix],
          },
          { counterMask },
        );
        expect(result.kind, JSON.stringify(result)).toBe("pass");
        if (result.kind === "pass")
          expect(result.fingerprint.work.runs).toBeGreaterThan(
            4 * (counterMask + 1),
          );
        checked++;
      }
      expect(checked).toBe(120);
    });
  }
});
