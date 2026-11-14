import assert from "node:assert/strict";
import * as graph from "../../src/graph";
import { effect, dispose, get } from "../../src/index";
import { createCollections } from "./index";
import type { Stats } from "./index";

// Added only by build-witness.mjs, never to production sources or bundles.
const physicalNodes = (): number =>
  (graph as unknown as { collectionWitnessNodes: number })
    .collectionWitnessNodes;
interface User {
  id: number;
  team: string;
  active: boolean;
  amount: bigint;
}
function* rows(n: number): Generator<User> {
  for (let i = 0; i < n; i++)
    yield { id: i, team: "a", active: true, amount: BigInt(i) };
}
function witness(n: number) {
  const initialNodes = physicalNodes();
  const engine = createCollections();
  const users = engine.table<number, User>({ key: (u) => u.id, rows: rows(n) });
  const active = users.filter((u) => u.active);
  const teams = active.groupBy((u) => u.team);
  const counts = teams.count(),
    sums = teams.sumBigInt((u) => u.amount);
  let consumer1 = 0,
    consumer2 = 0,
    effectRuns = 0;
  teams.observeChanges(() => consumer1++);
  teams.observeChanges(() => consumer2++);
  const observer = effect(() => {
    get(users.revision);
    if (users.get(3)!.team === "b") {
      assert.equal(counts.get("a"), n - 1);
      assert.equal(counts.get("b"), 1);
      assert.equal(sums.get("a"), (BigInt(n) * BigInt(n - 1)) / 2n - 3n);
      assert.equal(sums.get("b"), 50n);
    }
    effectRuns++;
  });
  const before = engine.stats,
    created = physicalNodes() - initialNodes;
  users.patch(3, { team: "b", amount: 50n });
  const after = engine.stats;
  assert.equal(physicalNodes() - initialNodes, created);
  assert.equal(created, 11); // Ten collection scalar signals and one explicit effect.
  assert.equal(after.quantNodes, 10);
  assert.equal(after.predicateCalls - before.predicateCalls, 1);
  assert.equal(after.sumCalls - before.sumCalls, 2);
  assert.equal(teams.stats.builds, 1);
  assert.equal(consumer1, 1);
  assert.equal(consumer2, 1);
  assert.equal(effectRuns, 2);
  assert.equal(get(users.size), n);
  const work = Object.fromEntries(
    (Object.keys(after) as (keyof Stats)[])
      .filter((k) => !["quantNodes", "operators", "indexesBuilt"].includes(k))
      .map((k) => [k, after[k] - before[k]]),
  );
  const result = {
    n,
    physicalQuantNodeCreations: created,
    collectionQuantNodes: after.quantNodes,
    indexBuilds: teams.stats.builds,
    work,
  };
  dispose(observer);
  engine.dispose();
  return result;
}
const sizes = (process.argv[2] ?? "1000").split(",").map(Number);
if (sizes.some((n) => !Number.isSafeInteger(n) || n < 4 || n > 1_000_000))
  throw new Error("sizes must be integers in [4, 1000000]");
const results = sizes.map((n) => {
  const result = witness(n);
  globalThis.gc?.();
  return result;
});
for (const row of results) assert.deepEqual(row.work, results[0]!.work);
console.log(JSON.stringify({ node: process.version, results }, null, 2));
