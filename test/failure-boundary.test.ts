import { expect, it } from "vitest";
import { computed, get, set, signal } from "../src/index";
import { ContractSpecRuntime } from "./support/contract-spec";

it.each([0, 1])(
  "the model revalidates interrupted ancestors on demand (D8, recovered value %i)",
  (recovered) => {
    const model = new ContractSpecRuntime();
    const broken = model.createProducer(false);
    const input = model.createProducer(0);
    const failure = new Error("leaf");
    let leafRuns = 0;
    let middleRuns = 0;
    let rootRuns = 0;
    const leaf = model.createComputed(() => {
      leafRuns++;
      if (model.readProducer(broken)) throw failure;
      return model.readProducer(input);
    });
    const middle = model.createComputed(() => {
      middleRuns++;
      return model.readComputed(leaf);
    });
    const root = model.createComputed(() => {
      rootRuns++;
      return model.readComputed(middle);
    });

    expect(model.readComputed(root)).toBe(0);
    model.writeProducer(broken, true);
    expect(() => model.readComputed(root)).toThrow(failure);
    expect([leafRuns, middleRuns, rootRuns]).toEqual([2, 1, 1]);
    model.writeProducer(input, recovered);
    model.writeProducer(broken, false);
    expect(model.readComputed(root)).toBe(recovered);
    const ancestorRuns = recovered === 0 ? 1 : 2;
    expect([leafRuns, middleRuns, rootRuns]).toEqual([3, ancestorRuns, ancestorRuns]);
  },
);

it("resumes tracking in the enclosing callback after a caught failure (F6)", () => {
  const broken = signal(true);
  const tail = signal(10);
  const failure = new RangeError("inner");
  const inner = computed(() => {
    if (get(broken)) throw failure;
    return 3;
  });
  const outer = computed(() => {
    let value = 0;
    try {
      value = get(inner);
    } catch (error) {
      if (error !== failure) throw error;
    }
    return value + get(tail);
  });

  expect(get(outer)).toBe(10);
  set(tail, 11);
  expect(get(outer)).toBe(11);
  set(broken, false);
  expect(get(inner)).toBe(3);
  set(tail, 12);
  expect(get(outer)).toBe(15);
});
