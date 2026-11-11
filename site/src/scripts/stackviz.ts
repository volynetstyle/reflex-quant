// UI for the stack visualization. Steps come from sim.ts, whose Quant recorder reproduces the
// real library's callback order and output on every scenario (checked by validate-sim).
import { SCENARIOS, naive, quant, type Scenario, type Step } from "./sim";

const TAG: Record<string, string> = { changed: "set", dirty: "DIRTY", stale: "STALE", walk: "checking", ran: "ran", running: "running", clean: "fresh" };
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function graph(sc: Scenario, s: Step, kinds: Record<string, string>): string {
  const r = 20, P = sc.layout;
  const saved = new Set(s.stack.map((x) => x.edge));
  const edges = s.edges.map(([f, t]) => {
    const [x1, y1] = P[f], [x2, y2] = P[t], dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    const k = `${f}→${t}`;
    const cls = k === s.hot ? "sv-e on" : saved.has(k) ? "sv-e saved" : "sv-e";
    return `<line class="${cls}" x1="${x1 + (dx / L) * r}" y1="${y1 + (dy / L) * r}" x2="${x2 - (dx / L) * (r + 4)}" y2="${y2 - (dy / L) * (r + 4)}" marker-end="url(#sv-arrow)"/>`;
  }).join("");
  const nodes = Object.entries(P).map(([id, [x, y]]) => {
    const st = s.marks[id] ?? "", k = kinds[id];
    const shape = k === "effect" ? `<rect x="${x - r}" y="${y - r + 4}" width="${2 * r}" height="${2 * r - 8}" rx="6"/>`
      : k === "signal" ? `<rect x="${x - r + 2}" y="${y - r + 2}" width="${2 * r - 4}" height="${2 * r - 4}" rx="3"/>` : `<circle cx="${x}" cy="${y}" r="${r}"/>`;
    const small = id.length > 4 ? ' class="sm"' : "";
    const tag = TAG[st] ? `<text class="sv-tag" x="${x}" y="${y + r + 12}" text-anchor="middle">${TAG[st]}</text>` : "";
    return `<g class="sv-n ${st}">${shape}<text${small} x="${x}" y="${y + 4}" text-anchor="middle">${id}</text>${tag}</g>`;
  }).join("");
  const ys = Object.values(P).map((p) => p[1]);
  const h = Math.max(...ys) + 40;
  return `<svg viewBox="0 ${Math.min(...ys) - 28} 570 ${h - Math.min(...ys) + 28}" role="img" aria-label="Dependency graph"><defs><marker id="sv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" class="sv-arrowhead"/></marker></defs>${edges}${nodes}</svg>`;
}

function tower(s: Step): string {
  const slots = s.stack.length
    ? [...s.stack].reverse().map((x, k) => `<div class="sv-slot${k === 0 ? " top" : ""}"><b>${x.edge}</b><span>${x.why}</span></div>`).join("")
    : `<div class="sv-empty">stack[] is empty</div>`;
  const run = s.running.length
    ? s.running.map((id, k) => `<span class="${k === s.running.length - 1 ? "now" : ""}">${id}</span>`).join(`<i>›</i>`)
    : `<span class="sv-empty">no callback running</span>`;
  return `<div class="sv-tower">${slots}</div><div class="sv-running"><em>running:</em> ${run}</div>`;
}

function frames(fs: Step["frames"]): string {
  if (!fs.length) return `<div class="idle">(no user closure running)</div>`;
  const out: string[] = [];
  const opens = fs.filter((f) => !f.get).length;
  let d = 0;
  for (const f of fs) {
    if (f.get) out.push(`<div class="get" style="padding-left:${d * 2}ch">${esc(f.t)}</div>`);
    else out.push(`<div class="${d === opens - 1 ? "top" : ""}" style="padding-left:${d++ * 2}ch">${esc(f.t)} {</div>`);
  }
  for (let k = d - 1; k >= 0; k--) out.push(`<div class="close" style="padding-left:${k * 2}ch">}</div>`);
  return out.join("");
}

function mount(root: HTMLElement) {
  const $ = <T extends Element = HTMLElement>(q: string) => root.querySelector<T>(q)!;
  const playBtn = $<HTMLButtonElement>("[data-sv=play]");
  let sc = SCENARIOS[0], mode: "quant" | "naive" = "quant";
  let steps: Step[] = [], i = 0, timer: ReturnType<typeof setInterval> | null = null;
  const cache = new Map<string, Step[]>();
  const kindsOf = (s: Scenario) => {
    const k: Record<string, string> = {};
    s.build({
      signal: (id) => ((k[id] = "signal"), id), computed: (id) => ((k[id] = "computed"), id),
      effect: (id) => ((k[id] = "effect"), id), get: () => undefined as never, set: () => {}, log: () => {},
    });
    return k;
  };
  let kinds = kindsOf(sc);

  const load = () => {
    const key = `${sc.id}:${mode}`;
    if (!cache.has(key)) cache.set(key, mode === "quant" ? quant(sc) : naive(sc));
    steps = cache.get(key)!;
    i = 0;
    kinds = kindsOf(sc);
    $(".sv-app").innerHTML = sc.code.map(([id, t]) => `<span data-l="${id}">${esc(t) || " "}</span>`).join("");
    $(".sv-blurb").textContent = sc.blurb;
    $(".sv-left-h").textContent = mode === "quant" ? "Quant's stack[]: saved edges, newest on top" : "JS call stack: your closures, nested";
    root.querySelectorAll<HTMLElement>("[data-sc]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sc === sc.id)));
    root.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  };

  const render = () => {
    const s = steps[i];
    $(".sv-graph").innerHTML = graph(sc, s, kinds);
    $(".sv-left").innerHTML = mode === "quant" ? tower(s) : `<pre class="sv-frames">${frames(s.frames)}</pre>`;
    const seen = steps.slice(0, i + 1);
    const peakStack = Math.max(0, ...seen.map((x) => x.stack.length));
    const peakNest = Math.max(0, ...seen.map((x) => x.running.length));
    $(".sv-meter").textContent = mode === "quant"
      ? `stack[]: ${s.stack.length} (peak ${peakStack}) · callbacks nested: ${s.running.length} (peak ${peakNest})`
      : `user closures on the JS stack: ${s.running.length} (peak ${peakNest})`;
    root.querySelectorAll<HTMLElement>(".sv-app [data-l]").forEach((el) => el.classList.toggle("hl", el.dataset.l === s.line));
    $(".sv-log").innerHTML = s.log.length ? s.log.map((l) => `<div>› ${esc(l)}</div>`).join("") : `<div class="sv-empty">console</div>`;
    $(".sv-note").textContent = s.note;
    $(".sv-count").textContent = `${i + 1} / ${steps.length}`;
  };
  const stop = () => { if (timer) clearInterval(timer); timer = null; playBtn.textContent = "▶ Play"; };
  const play = () => {
    if (i >= steps.length - 1) { i = 0; render(); }
    stop();
    playBtn.textContent = "⏸ Pause";
    timer = setInterval(() => (i < steps.length - 1 ? (i++, render()) : stop()), 1500);
  };
  root.addEventListener("click", (ev) => {
    const b = (ev.target as Element).closest<HTMLElement>("[data-sv],[data-sc],[data-mode]");
    if (!b) return;
    if (b.dataset.sc || b.dataset.mode) {
      stop();
      if (b.dataset.sc) sc = SCENARIOS.find((x) => x.id === b.dataset.sc)!;
      if (b.dataset.mode) mode = b.dataset.mode as typeof mode;
      load(); render(); play();
      return;
    }
    const a = b.dataset.sv;
    if (a === "play") return timer ? stop() : play();
    stop();
    if (a === "prev") i = Math.max(0, i - 1);
    else if (a === "next") i = Math.min(steps.length - 1, i + 1);
    else if (a === "reset") i = 0;
    render();
  });
  load(); render();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { play(); io.disconnect(); } }, { threshold: 0.4 });
    io.observe(root);
  }
}

document.querySelectorAll<HTMLElement>("[data-stackviz]").forEach(mount);
