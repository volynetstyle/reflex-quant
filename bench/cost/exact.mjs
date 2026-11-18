// The target's position is established independently for each source.
// Before/after holders are evaluated exactly once, outside the measured step.
import { permutation, range } from "../scaling.mjs";

export const rankCases = [
  [4, [1, 2, 4]],
  [8, [1, 4, 8]],
  [9, [8, 9]],
  [16, [1, 8, 9, 12, 16]],
  [32, [1, 8, 9, 16, 32]],
  [64, [33, "random", 63, 64, "ends"]],
];

export function prepareRank(api, width, fanout, position) {
  const sources = range(width).map((id) => api.signal(id));
  const distribution = permutation(width, 0x4e157b24);
  const ranks = distribution.map((v) => {
    if (position === "random") return 1 + v % fanout;
    if (position === "ends") return v % 2 === 0 ? 1 : fanout;
    return position;
  });
  function mount(count) {
    for (let j = 0; j < fanout - 1; j++) {
      const input = sources.filter((_, i) => j < count(ranks[i]));
      if (input.length === 0) break;
      api.computed(() => {
        let sum = 0;
        for (const s of input) sum += s.get();
        return sum;
      }).get();
    }
  }

  mount((rank) => rank - 1);
  const tick = api.signal(0);
  const orders = range(4).map((i) => permutation(width, 0x3865efaf + i));
  const reader = api.computed(() => {
    const order = orders[tick.get() & 3];
    let hash = 0;
    for (const id of order) hash = (Math.imul(hash, 31) + sources[id].get()) | 0;
    return hash;
  });
  reader.get();
  mount((rank) => fanout - rank);
  return {
    sources, ranks, orders, reader, tick,
    step(i) { tick.set(i); return reader.get(); },
  };
}

export const scenarios = [1024, 4096].flatMap((n) => rankCases.flatMap(([fanout, ranks]) =>
  ranks.map((rank) => ({
    id: `rank.${fanout}.${rank}@${n}`,
    n, setup: (api) => prepareRank(api, n, fanout, rank).step,
  })),
));
