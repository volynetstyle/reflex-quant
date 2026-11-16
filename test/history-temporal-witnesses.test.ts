import { describe, expect, it } from "vitest";
import { ins as i, ix as x } from "./support/imperative-language";
import { compareImperative } from "./support/imperative-worlds";

describe("temporal mutation witnesses", () => {
  it("branching propagation releases completed work-stack slots", async () => {
    const result = await compareImperative({
      id: "branching-stack",
      auto: true,
      operations: [
        i.signal("s", 0),
        i.computed("trunk", [i.ret(x.read("s"))]),
        i.computed("branch", [i.ret(x.read("trunk"))]),
        i.computed("sibling", [i.ret(x.read("trunk"))]),
        i.effect("w", [i.read("branch"), i.read("sibling")]),
        i.set("s", x.value(1)),
        i.dispose("w"),
      ],
    });
    expect(result.kind, JSON.stringify(result)).toBe("pass");
  });
  it("retired early subscriber severs younger neighbour", async () => {
    const result = await compareImperative({
      id: "retired-subscriber",
      auto: true,
      operations: [
        i.signal("s", 0),
        i.effect("old", [i.read("s")]),
        i.effect("young", [i.read("s")]),
        i.dispose("old"),
        i.set("s", x.value(1)),
      ],
    });
    expect(result.kind, JSON.stringify(result)).toBe("pass");
  });
  it("cut suffix severs its retained prefix", async () => {
    const result = await compareImperative({
      id: "cut-prefix",
      auto: false,
      operations: [
        i.signal("a", 1),
        i.signal("b", 2),
        i.signal("mode", 0),
        i.computed("c", [
          i.read("mode"),
          i.read("a"),
          i.when(x.equal(x.read("mode"), x.value(0)), [i.read("b")]),
          i.ret(x.read("a")),
        ]),
        i.read("c"),
        i.set("mode", x.value(1)),
        i.read("c"),
      ],
    });
    expect(result.kind, JSON.stringify(result)).toBe("pass");
  });
  it("failed execution debt survives an unchanged computed wake", async () => {
    const result = await compareImperative({
      id: "failure-debt-cutoff",
      auto: true,
      operations: [
        i.signal("d", 0),
        i.signal("u", 0),
        i.assign("fail", x.value(false)),
        i.computed("c", [i.ret(x.less(x.read("u"), x.value(5)))]),
        i.effect("w", [
          i.read("c"),
          i.read("d"),
          i.when(x.register("fail"), [i.fail("w")]),
        ]),
        i.assign("fail", x.value(true)),
        i.set("d", x.value(1)),
        i.assign("fail", x.value(false)),
        i.set("u", x.value(1)),
        i.dispose("w"),
      ],
    });
    expect(result.kind, JSON.stringify(result)).toBe("pass");
  });
});
