// Shared helpers for the interactive pieces (hero, demos, depth layer).

/** True when the reader asked for less motion: demos then draw still frames and never autoplay. */
export const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Seeded generator (Park-Miller), so a scene or a layout is the same on every load. */
export function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

/** Number of set bits. */
export function pop(m: number) { let c = 0; for (; m; m >>= 1) c += m & 1; return c; }

/** Scoped query that throws early if the markup and the script drift apart. */
export function within(root: ParentNode) {
  return <T extends Element = HTMLElement>(q: string) => {
    const el = root.querySelector<T>(q);
    if (!el) throw new Error(`missing ${q}`);
    return el;
  };
}

/** Which cell of a cols x rows grid a pointer event hit on a (possibly scaled) canvas; -1 outside. */
export function cellAt(cv: HTMLCanvasElement, e: PointerEvent, cols: number, rows: number) {
  const r = cv.getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * cols), y = Math.floor(((e.clientY - r.top) / r.height) * rows);
  return x >= 0 && y >= 0 && x < cols && y < rows ? y * cols + x : -1;
}

/** Pointer position in the canvas's own pixel space. */
export function pointAt(cv: HTMLCanvasElement, e: PointerEvent) {
  const r = cv.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * cv.width, y: ((e.clientY - r.top) / r.height) * cv.height };
}

/** A play/pause button driving `step` every `ms`; `step` may return false to stop. */
export function player(btn: HTMLElement, step: () => unknown, ms: number, label = "Play") {
  let timer = 0;
  const p = {
    get running() { return timer !== 0; },
    stop() { clearInterval(timer); timer = 0; btn.textContent = `▶ ${label}`; },
    play() { p.stop(); btn.textContent = "⏸ Pause"; timer = window.setInterval(() => { if (step() === false) p.stop(); }, ms); },
    toggle() { p.running ? p.stop() : p.play(); },
  };
  return p;
}

/**
 * Visibility for a demo: `show(true/false)` as it enters and leaves the viewport, and `first()`
 * once, the first time it is seen (autoplay), unless the reader asked for less motion.
 */
export function onScreen(el: Element, show: (visible: boolean) => void, first?: () => void, threshold = 0.3) {
  let pending = !still && !!first;
  new IntersectionObserver((es) => {
    const v = es[0].isIntersecting;
    show(v);
    if (v && pending) { pending = false; first!(); }
  }, { threshold }).observe(el);
}

/** Horizontal bars, one row per driver run: `run k ████ n`. Shared by the fixpoint demos. */
export function bars(el: HTMLElement, counts: number[], empty = "no driver run", limit = 10) {
  const max = Math.max(1, ...counts);
  el.innerHTML = counts.slice(0, limit).map((n, k) =>
    `<div><span>run ${k + 1}</span><i style="width:${Math.max(0.4, (n / max) * 100)}%"></i><b>${n}</b></div>`).join("")
    + (counts.length > limit ? `<div class="more">+ ${counts.length - limit} more runs, ${counts.slice(limit).reduce((a, x) => a + x, 0)} in them</div>` : "")
    + (counts.length === 0 ? `<div class="more">${empty}</div>` : "");
}

/** Executions per driver run, from the run counter sampled at the start of each driver run. */
export function perRun(marks: number[], total: number) {
  const b = marks.map((m, k) => (marks[k + 1] ?? total) - m);
  if (marks[0]) b[0] += marks[0];
  return b;
}
