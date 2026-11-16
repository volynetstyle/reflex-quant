import { describe, expect, it } from "vitest";
import {
  composedCallbackCases,
  imperativeCases,
  queueBurst,
} from "./support/imperative-cases";
import {
  compareImperative,
  compareImperativeHistories,
} from "./support/imperative-worlds";
import { ins as i, ix as x } from "./support/imperative-language";

describe("imperative callbacks and automatic host", () => {
  for (const program of imperativeCases())
    it(program.id, async () => {
      const result = await compareImperative(program);
      expect(result.kind, JSON.stringify(result)).toBe(
        program.id.startsWith("C1-") ? "ineligible" : "pass",
      );
    });
  it("certifies P5 histories with different initial source/program states after obligations discharge", async () => {
    const body = [
      i.read("a"),
      i.when(x.equal(x.register("once"), x.value(0)), [
        i.assign("once", x.value(1)),
        i.set("a", x.value(2)),
      ]),
      i.ret(x.read("a")),
    ];
    const prefix = (a: number, once: number) => [
      i.signal("a", a),
      i.assign("once", x.value(once)),
      i.computed("c", body),
      i.read("c"),
      i.read("c"),
    ];
    const result = await compareImperativeHistories({
      id: "reentrant-P5-erasure",
      auto: false,
      prefixA: prefix(2, 1),
      prefixB: prefix(1, 0),
      suffix: [
        i.set("a", x.value(3)),
        i.read("c"),
        i.dispose("c"),
        i.read("c"),
      ],
    });
    expect(result.kind, JSON.stringify(result)).toBe("pass");
  });
  it("returns the ring after a burst while model outputs remain equivalent", async () => {
    const result = await compareImperative(queueBurst(1024));
    expect(result.kind, JSON.stringify(result)).toBe("pass");
    if (result.kind === "pass") {
      expect(result.fingerprint.host.peakQueued).toBeGreaterThanOrEqual(1024);
      expect(result.fingerprint.host.mask).toBe(255);
      expect(result.fingerprint.host.hold).toBe(0);
    }
  });
  it("composes callback writes, disposal, failure and nested reads in all three lifecycle positions", async () => {
    let admitted = 0;
    for (const program of composedCallbackCases()) {
      const result = await compareImperative(program);
      expect(result.kind, JSON.stringify(result)).toBe("pass");
      admitted++;
    }
    expect(admitted).toBe(60);
  });
  it("compares batch partitions after cleanup and first-error histories", async () => {
    const base = [
      i.signal("a", 0),
      i.effect(
        "w",
        [i.read("a"), i.when(x.equal(x.read("a"), x.value(3)), [i.fail("w")])],
        [i.log("cleanup", x.read("a"))],
      ),
    ];
    const result = await compareImperativeHistories({
      id: "batch-partitions",
      auto: true,
      prefixA: [
        ...base,
        i.batch([i.set("a", x.value(1)), i.set("a", x.value(2))]),
      ],
      prefixB: [
        ...base,
        i.batch([i.set("a", x.value(1))]),
        i.batch([i.set("a", x.value(2))]),
      ],
      suffix: [
        i.set("a", x.value(3)),
        i.batch([i.set("a", x.value(4))]),
        i.dispose("w"),
      ],
    });
    expect(result.kind, JSON.stringify(result)).toBe("pass");
  });
  it("certifies high-water versus steady host histories while retaining allowed ring hysteresis", async () => {
    const width = 1024;
    const base = [
      i.signal("a", 0),
      i.signal("small", 0),
      i.effect("steady", [i.read("small")]),
    ];
    const create = Array.from({ length: width }, (_, n) =>
      i.effect(`temp${n}`, [i.read("a")]),
    );
    const dispose = Array.from({ length: width }, (_, n) =>
      i.dispose(`temp${n}`),
    );
    const result = await compareImperativeHistories({
      id: "host-high-water",
      auto: true,
      prefixA: [...base, ...create.flatMap((op, n) => [op, dispose[n]!])],
      prefixB: [...base, i.batch(create), i.batch(dispose)],
      suffix: Array.from({ length: 2 * width }, (_, n) =>
        i.set("small", x.value(n + 1)),
      ),
    });
    expect(result.kind, JSON.stringify(result)).toBe("pass");
    if (result.kind === "pass" && "runs" in result)
      expect(result.runs.map((run) => run.fingerprint.host.mask)).toEqual([
        255, 255,
      ]);
  });
});
