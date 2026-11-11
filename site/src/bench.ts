// Scenario medians from CI benchmark run 42794143933 (reflex-quant 1.1.2, 2026-11-10).
// Copied from the run's "scenarios *" job logs; aggregates below are computed, not typed.
export const RUN = {
  id: "42794143933",
  url: "https://github.com/volynetstyle/reflex-quant/actions/runs/42794143933",
  version: "1.1.2",
  date: "2026-11-10",
  machine: "Node 22.23.4 (V8 12.4), Intel Xeon Platinum 8573C, 9 rounds",
  rivals: "Reflex bf71877, alien-signals 3.2.1",
};

/** [scenario, quant/best, quant/reflex, quant/alien] */
export const ROWS: [string, number, number, number][] = [
  ["batch.writes-32", 0.55, 0.55, 0.45],
  ["shared-chaotic.64x32", 0.78, 0.78, 0.22],
  ["branch.switch-100", 0.87, 0.87, 0.47],
  ["fan-out.effects-1000", 0.88, 0.84, 0.88],
  ["replace-half.256", 0.91, 0.91, 0.77],
  ["diamond.8x8", 0.93, 0.93, 0.75],
  ["fan-in.1024", 0.99, 0.99, 0.38],
  ["lifecycle.mount-100", 1.04, 0.66, 1.04],
  ["edit.insert-one-256", 1.06, 1.06, 0.21],
  ["static.chain-100", 1.09, 1.09, 0.93],
  ["stable.wide-256", 1.17, 1.17, 0.47],
  ["stable.wide-8", 1.17, 1.17, 0.58],
  ["fan-out.computeds-1000", 1.18, 1.18, 0.86],
  ["reorder.rotate-256", 1.2, 1.2, 0.15],
  ["reorder.reverse-8", 1.2, 1.2, 0.17],
  ["long-reorder.256", 1.21, 1.21, 0.17],
  ["static.read-clean", 1.22, 1.1, 1.22],
  ["value-sort.256x32", 1.43, 1.43, 0.3],
];

const geo = (i: number) => Math.exp(ROWS.reduce((s, r) => s + Math.log(r[i] as number), 0) / ROWS.length);
const fmt = (x: number) => x.toFixed(2);
export const AGG = {
  n: ROWS.length,
  best: fmt(geo(1)),
  reflex: fmt(geo(2)),
  alien: fmt(geo(3)),
  faster: ROWS.filter((r) => r[1] < 1).length,
  within25: ROWS.filter((r) => r[1] <= 1.25).length,
};
