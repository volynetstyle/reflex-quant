// Same-set permutations whose next source is given only by the user body.
import { permutation, range } from "../scaling.mjs";

function workload(api, n, shape) {
  const tick = api.signal(0);
  const sources = range(n).map((id) => api.signal(id));
  if (shape === "deep") {
    for (let i = 0; i < 8; i++) {
      api.computed(() => {
        let sum = 0;
        for (const s of sources) sum += s.get();
        return sum;
      }).get();
    }
  }
  const orders = range(4).map((i) => permutation(n, 0x3865efaf + i));
  const reader = api.computed(() => {
    const step = tick.get();
    const order = orders[shape === "phases" && step % 24 >= 8 && step % 24 < 16 ? 0 : step & 3];
    let hash = 0;
    for (const id of order) hash = (Math.imul(hash, 31) + sources[id].get()) | 0;
    return hash;
  });
  reader.get();
  const narrow = shape === "mixed"
    ? range(32).map((id) => api.computed(() => (tick.get() + id) & 255))
    : [];
  for (const c of narrow) c.get();
  return (step) => {
    tick.set(step);
    let sum = reader.get();
    for (const c of narrow) sum += c.get();
    return sum | 0;
  };
}

export const scenarios = [
  ...[1024, 4096].map((n) => ({
    id: `deep-shuffle@${n}`, n, setup: (api) => workload(api, n, "deep"),
  })),
  { id: "phases@512", n: 512, setup: (api) => workload(api, 512, "phases") },
  { id: "mixed@512", n: 512, setup: (api) => workload(api, 512, "mixed") },
];
