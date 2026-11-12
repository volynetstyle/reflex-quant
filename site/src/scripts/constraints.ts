// Constraint propagation (a small Wave Function Collapse) solved by the reactive runtime.
//   choice[i] = signal(mask)   what the user (or the collapse step) allows here
//   inbox[i]  = signal(mask)   intersection of what the neighbours still support
//   cell[i]   = computed(prev) domain lives in prev: D = prev.D & choice & inbox;
//                              when D narrows, it writes support(D) into each neighbour's inbox
//   driver    = one effect reading every cell; P5 + W2 re-deliver it until nothing narrows
// Domains only shrink, so it ends: each cell can narrow at most T times.
// Checked in Node against a plain AC-3 worklist: identical domains after every collapse.
import { batch, computed, effect, get, signal, update, set } from "reflex-quant";

const W = 32, H = 20, N = W * H, T = 5, FULL = (1 << T) - 1, PX = 12;
const NAMES = ["water", "sand", "grass", "forest", "rock"];
const SHORT = ["W", "S", "G", "F", "R"];
// tile t may touch t-1, t and t+1: water-sand-grass-forest-rock
const SUP = Array.from({ length: 1 << T }, (_, m) => { let s = 0; for (let t = 0; t < T; t++) if ((m >> t) & 1) s |= (7 << t) >> 1; return s & FULL; });
const NB = Array.from({ length: N }, (_, i) => {
  const x = i % W, y = (i / W) | 0, r: number[] = [];
  if (x) r.push(i - 1); if (x < W - 1) r.push(i + 1); if (y) r.push(i - W); if (y < H - 1) r.push(i + W);
  return r;
});
const pop = (m: number) => { let c = 0; for (; m; m >>= 1) c += m & 1; return c; };
const set2s = (m: number) => (m ? `{${SHORT.filter((_, t) => (m >> t) & 1).join(",")}}` : "{}");

type Ev = { i: number; from: number; to: number; wrote: number[]; run: number };

function start(root: HTMLElement) {
  const cv = root.querySelector<HTMLCanvasElement>("canvas")!;
  const ctx = cv.getContext("2d")!;
  const $ = (q: string) => root.querySelector<HTMLElement>(q)!;
  cv.width = W * PX; cv.height = H * PX;

  let runs = 0, passes = 0, msgs = 0;
  let events: Ev[] = [];
  const epoch = signal(0);
  const choice = Array.from({ length: N }, () => signal(FULL));
  const inbox = Array.from({ length: N }, () => signal(FULL));

  const cell = choice.map((c, i) => computed<{ e: number; D: number }>((prev) => {
    runs++;
    const e = get(epoch);
    const before = prev.e === e ? prev.D : FULL;
    const D = before & get(c) & get(inbox[i]);
    if (prev.e === e && D === prev.D) return prev;            // nothing new: cutoff
    const s = SUP[D], wrote: number[] = [];
    for (const j of NB[i]) {
      update(inbox[j], (m) => { const n = m & s; if (n !== m) { msgs++; wrote.push(j); } return n; });
    }
    if (D !== before) events.push({ i, from: before, to: D, wrote, run: Math.max(1, passes) });
    return { e, D };
  }, { e: -1, D: FULL }));

  const marks: number[] = [];
  effect(() => { passes++; marks.push(runs); for (const x of cell) get(x); });

  // ---- drawing: collapsed cells as pixel tiles, open cells as their remaining options
  const COL = [[38, 92, 168], [214, 190, 120], [96, 160, 72], [40, 104, 56], [128, 124, 132]];
  const noise = (i: number, k: number) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
  const shown = new Int32Array(N).fill(FULL), flash = new Float32Array(N);
  const tile = (i: number, D: number) => {
    const x = (i % W) * PX, y = ((i / W) | 0) * PX;
    if (D === 0) {                                     // contradiction
      ctx.fillStyle = "#3a0d12"; ctx.fillRect(x, y, PX, PX);
      ctx.fillStyle = "#e34948";
      for (let k = 2; k < PX - 2; k++) { ctx.fillRect(x + k, y + k, 1, 1); ctx.fillRect(x + PX - 1 - k, y + k, 1, 1); }
      return;
    }
    if (pop(D) === 1) {
      const t = Math.log2(D), [r, g, b] = COL[t];
      ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x, y, PX, PX);
      for (let k = 0; k < 7; k++) {                     // pixel texture
        const n = noise(i, k), px = (n * PX) | 0, py = (noise(i, k + 9) * PX) | 0, d = n > 0.5 ? 1.18 : 0.8;
        ctx.fillStyle = `rgb(${Math.min(255, r * d) | 0},${Math.min(255, g * d) | 0},${Math.min(255, b * d) | 0})`;
        if (t === 0) ctx.fillRect(x + px, y + py, 3, 1);          // water ripples
        else if (t === 3 && k < 3) { ctx.fillStyle = "rgb(24,70,36)"; ctx.fillRect(x + (px % 9) + 1, y + (py % 8) + 2, 3, 3); ctx.fillStyle = "rgb(70,40,20)"; ctx.fillRect(x + (px % 9) + 2, y + (py % 8) + 5, 1, 2); }
        else if (t === 4 && k < 2) { ctx.fillStyle = "rgb(170,168,176)"; ctx.fillRect(x + (px % 8) + 2, y + 3, 1, 1); ctx.fillRect(x + (px % 8) + 1, y + 4, 3, 1); ctx.fillRect(x + (px % 8), y + 5, 5, 1); }
        else ctx.fillRect(x + px, y + py, 1, 1);
      }
      return;
    }
    ctx.fillStyle = "#0b0c0d"; ctx.fillRect(x, y, PX, PX);      // still open: one dot per option left
    for (let t = 0; t < T; t++) {
      if (!((D >> t) & 1)) continue;
      const [r, g, b] = COL[t];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x + 1 + (t % 3) * 4, y + 2 + ((t / 3) | 0) * 5, 2, 2);
    }
  };
  const paint = () => {
    for (let i = 0; i < N; i++) {
      tile(i, shown[i]);
      if (flash[i] > 0.02) {
        ctx.strokeStyle = `rgba(255,255,255,${flash[i].toFixed(2)})`;
        ctx.strokeRect((i % W) * PX + 0.5, ((i / W) | 0) * PX + 0.5, PX - 1, PX - 1);
        flash[i] *= 0.82;
      }
    }
  };

  // ---- replay: the solver finished synchronously; replay its changes in order so the eye can follow
  let queue: Ev[] = [], raf = 0;
  const replay = () => {
    const per = Math.max(1, Math.ceil(queue.length / 40));     // about 40 frames per wave
    for (let k = 0; k < per && queue.length; k++) { const ev = queue.shift()!; shown[ev.i] = ev.to; flash[ev.i] = 1; }
    paint();
    raf = queue.length || flash.some((f) => f > 0.02) ? requestAnimationFrame(replay) : 0;
  };

  const report = (what: string) => {
    const b = marks.map((m, k) => (marks[k + 1] ?? runs) - m);
    if (marks[0]) b[0] += marks[0];
    const changedBy = marks.map((_, k) => events.filter((ev) => ev.run === k + 1).length);
    $("[data-cp-what]").textContent = what;
    $("[data-cp-runs]").textContent = String(runs);
    $("[data-cp-changed]").textContent = String(events.length);
    $("[data-cp-msgs]").textContent = String(msgs);
    $("[data-cp-passes]").textContent = String(passes);
    let open = 0, empty = 0; for (const x of cell) { const p = pop(get(x).D); if (p > 1) open++; if (p === 0) empty++; }
    $("[data-cp-open]").textContent = empty ? `${empty} empty` : `${open} open`;
    $("[data-cp-open]").classList.toggle("bad", empty > 0);
    const max = Math.max(1, ...changedBy);
    $("[data-cp-front]").innerHTML = changedBy.map((n, k) =>
      `<div><span>run ${k + 1}</span><i style="width:${Math.max(0.4, (n / max) * 100)}%"></i><b>${n}</b></div>`).join("")
      || `<div class="more">no driver run</div>`;
    $("[data-cp-log]").innerHTML = events.slice(0, 7).map((ev) =>
      `<div><b>cell ${ev.i}</b>(prev) <span>${set2s(ev.from)} → ${set2s(ev.to)}</span>${ev.wrote.length ? ` writes → ${ev.wrote.join(", ")}` : ""}</div>`).join("")
      + (events.length > 7 ? `<div class="more">… ${events.length - 7} more cells narrowed</div>` : "");
  };
  const act = (what: string, fn: () => void) => {
    runs = passes = msgs = 0; marks.length = 0; events = [];
    fn();
    queue.push(...events);
    report(what);
    if (!raf) raf = requestAnimationFrame(replay);
  };

  // ---- actions
  const collapse = (i: number, rnd = Math.random) => {
    const D = get(cell[i]).D, opts = SHORT.map((_, t) => 1 << t).filter((b) => D & b);
    if (opts.length < 2) return false;
    const v = opts[(rnd() * opts.length) | 0];
    act(`cell ${i} := ${NAMES[Math.log2(v)]}`, () => set(choice[i], v));
    return true;
  };
  const lowestEntropy = () => {
    let best = -1, bp = 99;
    for (let i = 0; i < N; i++) { const p = pop(get(cell[i]).D); if (p === 0) return -1; if (p > 1 && (p < bp || (p === bp && Math.random() < 0.15))) { bp = p; best = i; } }
    return best;
  };
  const stepWFC = () => { const i = lowestEntropy(); return i >= 0 && collapse(i); };
  const reset = () => {
    stop();
    act("reset", () => batch(() => { update(epoch, (e) => e + 1); for (let i = 0; i < N; i++) { set(choice[i], FULL); set(inbox[i], FULL); } }));
  };
  const contradiction = () => {
    // forbid the only tile left in a decided cell (or water and rock two apart if none decided)
    const decided = cell.map((x, i) => [i, get(x).D] as const).filter(([, d]) => pop(d) === 1);
    if (decided.length) {
      const [i, d] = decided[(Math.random() * decided.length) | 0];
      act(`cell ${i}: forbid ${NAMES[Math.log2(d)]}, its last option`, () => update(choice[i], (m) => m & ~d));
    } else {
      const i = 10 * W + 14;
      act(`water at ${i}, rock at ${i + 2}`, () => batch(() => { set(choice[i], 1); set(choice[i + 2], 16); }));
    }
  };

  let timer = 0;
  const playBtn = $("[data-cp=play]");
  const stop = () => { clearInterval(timer); timer = 0; playBtn.textContent = "▶ Auto"; };
  const play = () => { stop(); playBtn.textContent = "⏸ Pause"; timer = window.setInterval(() => { if (!stepWFC()) stop(); }, 120); };
  root.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLElement>("[data-cp]")?.dataset.cp;
    if (a === "play") timer ? stop() : play();
    else if (a === "step") { stop(); stepWFC(); }
    else if (a === "contra") { stop(); contradiction(); }
    else if (a === "reset") reset();
  });
  cv.addEventListener("pointerdown", (e) => {
    const r = cv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * W), y = Math.floor(((e.clientY - r.top) / r.height) * H);
    if (x >= 0 && y >= 0 && x < W && y < H) { stop(); collapse(y * W + x); }
  });

  paint();
  report("start: every cell can still be anything");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let auto = !still;
  new IntersectionObserver((es) => { if (!es[0].isIntersecting) stop(); else if (auto) { auto = false; play(); } }, { threshold: 0.3 }).observe(cv);
}

document.querySelectorAll<HTMLElement>("[data-constraints]").forEach(start);
