// Compile-only public API witnesses, not imported into executable tests/bundles.
import { createCollections } from "./index";
import type { View } from "./index";
const db = createCollections();
const users = db.table({
  key: (user) => user.id,
  rows: [{ id: 1, active: true, team: "a", amount: 1n, nested: { value: 2 } }],
});
const active = users.filter((user) => user.active);
const totals: View<string, bigint> = active
  .groupBy((user) => user.team)
  .sumBigInt((user) => user.amount);
const owned = users.get(1)!;
// @ts-expect-error Returned row fields are immutable.
owned.active = false;
// @ts-expect-error Ownership includes nested records.
owned.nested.value = 3;
// @ts-expect-error Bigint aggregation excludes Number projections.
active.groupBy((user) => user.team).sumBigInt((user) => user.id);
void totals;
