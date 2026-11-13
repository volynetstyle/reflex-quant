// Scenario medians from CI benchmark run 43479214912 (reflex-quant 1.2.0, commit 85049b4, 2026-11-13).
// Copied from the run's "scenarios *" job logs; aggregates below are computed, not typed.
// The logs round to two decimals, so fan-out.effects-1000 (0.998 of the better rival) counts as
// a tie here; research/HISTORY.md uses unrounded ratios and counts it among the wins.
export const RUN = {
  id: "43479214912",
  url: "https://github.com/volynetstyle/reflex-quant/actions/runs/43479214912",
  version: "1.2.0",
  date: "2026-11-13",
  // Five scenario jobs on four runner CPUs (EPYC 9V45, EPYC 9V74, Xeon 8573C, EPYC 7763);
  // every ratio compares the three libraries inside one job, never across runners.
  machine: "Node 22.23.4, 9 rounds; each ratio measured within one runner",
  rivals: "Reflex bf71877, alien-signals 3.2.1",
};

/** [scenario, quant/best, quant/reflex, quant/alien] */
export const ROWS: [string, number, number, number][] = [
  ["reorder.rotate-256", 0.53, 0.53, 0.07],
  ["batch.writes-32", 0.61, 0.61, 0.56],
  ["edit.insert-one-256", 0.7, 0.7, 0.14],
  ["shared-chaotic.64x32", 0.73, 0.73, 0.24],
  ["replace-half.256", 0.74, 0.74, 0.63],
  ["branch.switch-100", 0.82, 0.82, 0.46],
  ["diamond.8x8", 0.99, 0.99, 0.72],
  ["fan-out.effects-1000", 1.0, 0.97, 1.0],
  ["fan-in.1024", 1.06, 1.06, 0.45],
  ["fan-out.computeds-1000", 1.07, 1.07, 0.73],
  ["lifecycle.mount-100", 1.1, 0.73, 1.1],
  ["static.chain-100", 1.11, 1.11, 0.96],
  ["reorder.reverse-8", 1.13, 1.13, 0.16],
  ["stable.wide-256", 1.13, 1.13, 0.45],
  ["stable.wide-8", 1.17, 1.17, 0.58],
  ["value-sort.256x32", 1.19, 1.19, 0.3],
  ["long-reorder.256", 1.2, 1.2, 0.19],
  ["static.read-clean", 1.22, 1.1, 1.22],
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
