// Pulse-coupled oscillators (fireflies) on a torus, solved by the reactive runtime itself.
//   firefly[i] = computed(prev => ...)  phase lives in prev; reads tick and its inbox pulse[i]
//   pulse[i]   = signal                 inbox; the firefly consumes it and writes to neighbours
//   driver     = one effect reading every firefly
// A flash writes into fireflies the driver already read this pass. That is an owed
// execution (contract P5), and a watcher invalidated during its own run is delivered
// again (W2), so the driver re-runs until nothing changes: the avalanche is a fixpoint.
// Termination: a flash loses 1 and hands out 4 * EPS < 1, so every avalanche ends.
import { computed, effect, get, signal, update } from "reflex-quant";

const COLS = 64, ROWS = 40, N = COLS * ROWS;
const DT = 0.01, EPS = 0.2, REFRACTORY = 30;
type Fly = { epoch: number; tick: number; phase: number; lit: number };

const NB = Array.from({ length: N }, (_, i) => {
  const x = i % COLS, y = (i / COLS) | 0;
  return [((y + ROWS - 1) % ROWS) * COLS + x, ((y + 1) % ROWS) * COLS + x, y * COLS + (x + COLS - 1) % COLS, y * COLS + (x + 1) % COLS];
});
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

function start(root: HTMLElement) {
  const cv = root.querySelector<HTMLCanvasElement>("canvas")!;
  const ctx = cv.getContext("2d")!;
  const $ = (q: string) => root.querySelector<HTMLElement>(q)!;
  const S = 10;
  cv.width = COLS * S; cv.height = ROWS * S;

  let runs = 0, pulses = 0, passes = 0;
  const tick = signal(0), epoch = signal(0);
  const pulse = Array.from({ length: N }, () => signal(0));

  const firefly = pulse.map((inbox, i) => computed<Fly>((prev) => {
    runs++;
    const t = get(tick), e = get(epoch);
    // Domain time advances once per tick, however many times this runs within it.
    let phase = prev.epoch === e ? prev.phase + (t - prev.tick) * DT : Math.random();
    let lit = prev.epoch === e ? prev.lit : -1e9;
    const incoming = get(inbox);
    if (incoming) {
      update(inbox, () => 0);                                   // consume the inbox
      if (t - lit > REFRACTORY) phase += incoming;              // just flashed: ignore
    }
    if (phase >= 1) {
      phase = 0; lit = t;
      for (const j of NB[i]) { update(pulse[j], (x) => x + EPS); pulses++; }
    }
    if (e === prev.epoch && t === prev.tick && phase === prev.phase && lit === prev.lit) return prev;
    return { epoch: e, tick: t, phase, lit };
  }, { epoch: -1, tick: 0, phase: 0, lit: -1e9 }));

  // The solver.
  // `marks` records how many fireflies had run when each driver run began: the frontier.
  const marks: number[] = [];
  effect(() => { passes++; marks.push(runs); for (const f of firefly) get(f); });

  // Frontier strip: fireflies executed per driver run in the last measured operation.
  // A run's bar counts executions until the next run begins; the first absorbs the one
  // execution validation makes before the body starts, the last any validation-only tail.
  const frontier = () => {
    const b = marks.map((m, k) => (marks[k + 1] ?? runs) - m);
    if (marks[0]) b[0] += marks[0];
    const shown = b.slice(0, 10), max = Math.max(1, ...b);
    $("[data-frontier]").innerHTML = shown.map((n, k) =>
      `<div><span>run ${k + 1}</span><i style="width:${Math.max(0.4, (n / max) * 100)}%"></i><b>${n}</b></div>`).join("")
      + (b.length > 10 ? `<div class="more">+ ${b.length - 10} more runs, ${b.slice(10).reduce((a, x) => a + x, 0)} executions</div>` : "")
      + (b.length === 0 ? `<div class="more">no driver run: ${runs} fireflies validated and cut off</div>` : "");
  };

  const draw = () => {
    const t = get(tick);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
    let lit = 0;
    for (let i = 0; i < N; i++) {
      const f = get(firefly[i]), age = t - f.lit;
      if (age === 0) lit++;
      const x = (i % COLS) * S, y = ((i / COLS) | 0) * S;
      if (age < 10) {
        // flash: a 3x3 dot block that dithers away over ten ticks
        const v = 1 - age / 10;
        ctx.fillStyle = "#eee";
        for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) if (v > BAYER[j * 4 + k]) ctx.fillRect(x + 1 + k * 3, y + 1 + j * 3, 2, 2);
      } else {
        // charging: one dim dot, brighter as the phase approaches 1
        const g = 28 + ((f.phase * f.phase * 90) | 0);
        ctx.fillStyle = `rgb(${g},${g},${g})`;
        ctx.fillRect(x + 4, y + 4, 2, 2);
      }
    }
    return lit;
  };
  const measure = (fn: () => void) => {
    runs = pulses = passes = 0; marks.length = 0;
    const t0 = performance.now(); fn();
    const ms = performance.now() - t0;
    const lit = draw();
    $("[data-tick]").textContent = String(get(tick));
    $("[data-runs]").textContent = String(runs);
    $("[data-pulses]").textContent = String(pulses);
    $("[data-passes]").textContent = String(passes);
    $("[data-lit]").textContent = `${lit} / ${N}`;
    $("[data-ms]").textContent = ms.toFixed(1);
    frontier();
  };
  const step = () => measure(() => update(tick, (t) => t + 1));

  let timer = 0;
  const playBtn = $("[data-act=play]");
  const stop = () => { clearInterval(timer); timer = 0; playBtn.textContent = "▶ Play"; };
  const play = () => { stop(); timer = window.setInterval(step, 33); playBtn.textContent = "⏸ Pause"; };
  root.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (a === "play") timer ? stop() : play();
    else if (a === "step") { stop(); step(); }
    else if (a === "scramble") measure(() => update(epoch, (n) => n + 1));
  });
  // A poke is one write into one inbox: whatever avalanche follows is the runtime's doing.
  cv.addEventListener("pointerdown", (e) => {
    const r = cv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * COLS), y = Math.floor(((e.clientY - r.top) / r.height) * ROWS);
    if (x >= 0 && y >= 0 && x < COLS && y < ROWS) measure(() => update(pulse[y * COLS + x], (v) => v + 1));
  });

  measure(() => update(epoch, (n) => n + 1));
  let auto = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  new IntersectionObserver((es) => {
    if (!es[0].isIntersecting) stop();
    else if (auto) { auto = false; play(); }
  }, { threshold: 0.3 }).observe(cv);
}

document.querySelectorAll<HTMLElement>("[data-fireflies]").forEach(start);
