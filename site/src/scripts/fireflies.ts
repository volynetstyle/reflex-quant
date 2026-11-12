// Flying fireflies, synchronized by the reactive runtime itself.
//   firefly[i] = computed(prev => ...)  phase lives in prev; reads tick and its inbox pulse[i]
//   pulse[i]   = signal                 inbox; the firefly consumes it and writes to whoever it can see
//   driver     = one effect reading every firefly
// Flight (flight.ts) is plain kinematics; it only decides who is close enough to see a flash.
// Those writes are untracked, so the reactive graph does not change when the fireflies move.
// A flash writing into a firefly the driver already read is an owed execution (contract P5),
// and a watcher invalidated during its own run is delivered again (W2): the avalanche is a fixpoint.
// Termination: a flash loses 1 and hands out at most K * EPS = 0.88 < 1.
import { computed, effect, get, signal, update } from "reflex-quant";
import { SW, SH, loadScene, FIELD_TOP } from "./nightfield";
import { fly, makeFlies, neighbours } from "./flight";
import { bars, onScreen, perRun, player, pointAt, still, within } from "./util";

const N = 600, K = 8, REACH = 0.16;
const DT = 0.01, EPS = 0.11, REFRACTORY = 30, TICK_MS = 33;
type State = { epoch: number; tick: number; phase: number; lit: number };

function start(root: HTMLElement) {
  const cv = root.querySelector<HTMLCanvasElement>("canvas")!;
  const ctx = cv.getContext("2d")!;
  const $ = within(root);
  cv.width = SW; cv.height = SH;
  let bg: CanvasImageSource | null = null;
  loadScene(`${import.meta.env.BASE_URL}field.jpg`.replace("//", "/")).then((s) => { bg = s; draw(); });

  const flies = makeFlies(N);
  let near = neighbours(flies, REACH, K);

  let runs = 0, pulses = 0, passes = 0;
  const tick = signal(0), epoch = signal(0);
  const pulse = flies.map(() => signal(0));

  const firefly = pulse.map((inbox, i) => computed<State>((prev) => {
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
      for (const j of near[i]) { update(pulse[j], (x) => x + EPS); pulses++; }   // whoever sees it now
    }
    if (e === prev.epoch && t === prev.tick && phase === prev.phase && lit === prev.lit) return prev;
    return { epoch: e, tick: t, phase, lit };
  }, { epoch: -1, tick: 0, phase: 0, lit: -1e9 }));

  // The solver. `marks` records how many fireflies had run when each driver run began.
  const marks: number[] = [];
  effect(() => { passes++; marks.push(runs); for (const f of firefly) get(f); });

  const frontier = () => bars($("[data-frontier]"), perRun(marks, runs), `no driver run: ${runs} fireflies validated and cut off`);

  // Projection: ground (x, z) onto the field in the picture, height lifts off the grass.
  const top = SH * FIELD_TOP + 4;
  const screen = (i: number) => {
    const f = flies[i], k = 0.5 + f.z;
    return { x: f.x * SW, y: top + Math.pow(f.z, 1.25) * (SH - top - 6) - f.h * (10 + 34 * f.z), k };
  };
  // Flash pattern: the model decides when a burst starts; the burst itself (three quick
  // flashes, like synchronous Photinus carolinus) is drawn from the age of that start.
  const glow = (age: number) => {
    const n = Math.floor(age / 9), a = age - n * 9;
    return n < 3 && a < 5 ? (1 - a / 5) ** 1.5 : 0;
  };

  let lastTick = performance.now(), lastFrame = performance.now();
  const draw = (now = performance.now()) => {
    const t = get(tick), frac = run.running ? Math.min(1, (now - lastTick) / TICK_MS) : 0;
    const dt = Math.min(64, now - lastFrame); lastFrame = now;
    if (run.running || !still) fly(flies, dt, (i) => (t - get(firefly[i]).lit + frac < 8 ? 1 : 0));
    ctx.globalCompositeOperation = "source-over";
    if (bg) ctx.drawImage(bg, 0, 0, SW, SH); else { ctx.fillStyle = "#0a0e1c"; ctx.fillRect(0, 0, SW, SH); }
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < N; i++) {
      const f = get(firefly[i]), p = screen(i), b = flies[i].b;
      const x = Math.round(p.x), y = Math.round(p.y), v = glow(t - f.lit + frac) * b;
      if (v > 0.02) {
        const g = Math.round(1 + p.k * 2);
        ctx.fillStyle = `rgba(190,230,80,${(0.04 * v).toFixed(3)})`;     // firefly light: yellow-green
        ctx.fillRect(x - g * 2, y - g * 2, g * 4 + 1, g * 4 + 1);
        ctx.fillStyle = `rgba(220,240,110,${(0.14 * v).toFixed(3)})`;
        ctx.fillRect(x - g, y - g, g * 2 + 1, g * 2 + 1);
        ctx.fillStyle = `rgba(250,255,190,${v.toFixed(3)})`;
        ctx.fillRect(x, y, p.k > 1.1 ? 2 : 1, p.k > 1.1 ? 2 : 1);
      } else {
        // dark between bursts: just a dim body you can barely see
        ctx.fillStyle = `rgba(70,80,60,${(0.35 * b).toFixed(2)})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  };
  let raf = 0, visible = false;
  const frame = (now: number) => { draw(now); raf = visible ? requestAnimationFrame(frame) : 0; };

  const measure = (fn: () => void) => {
    runs = pulses = passes = 0; marks.length = 0;
    const t0 = performance.now(); fn();
    const ms = performance.now() - t0;
    const t = get(tick);
    let lit = 0;
    for (const f of firefly) if (get(f).lit === t) lit++;
    lastTick = performance.now();
    if (!raf) draw();
    $("[data-tick]").textContent = String(t);
    $("[data-runs]").textContent = String(runs);
    $("[data-pulses]").textContent = String(pulses);
    $("[data-passes]").textContent = String(passes);
    $("[data-lit]").textContent = `${lit} / ${N}`;
    $("[data-ms]").textContent = ms.toFixed(1);
    frontier();
  };
  // A tick: first see who is near whom (they have moved), then advance the model.
  const step = () => { near = neighbours(flies, REACH, K); measure(() => update(tick, (t) => t + 1)); };

  const run = player($("[data-act=play]"), step, TICK_MS);
  const stop = run.stop;
  root.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (a === "play") run.toggle();
    else if (a === "step") { stop(); step(); }
    else if (a === "scramble") measure(() => update(epoch, (n) => n + 1));
  });
  // A poke is one write into one inbox: whatever avalanche follows is the runtime's doing.
  cv.addEventListener("pointerdown", (e) => {
    const { x, y } = pointAt(cv, e);
    let best = 0, d = Infinity;
    for (let i = 0; i < N; i++) { const p = screen(i), q = (p.x - x) ** 2 + (p.y - y) ** 2; if (q < d) { d = q; best = i; } }
    if (d < 100) measure(() => update(pulse[best], (v) => v + 1));
  });

  measure(() => update(epoch, (n) => n + 1));
  onScreen(cv, (v) => {
    visible = v && !still;
    if (visible && !raf) { lastFrame = performance.now(); raf = requestAnimationFrame(frame); }
    if (!v) stop();
  }, run.play);
}

document.querySelectorAll<HTMLElement>("[data-fireflies]").forEach(start);
