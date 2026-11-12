// Conway's Game of Life where the state is a computed:
//   generation = signal(n)                       the only thing step() writes
//   world      = computed(prev => evolve(prev))  prev is the last committed world, S(t+1) = F(S(t))
//   cell[i]    = computed(() => world.cells[i])  projection; same 0/1 is a cutoff
//   paint[i]   = effect(cell[i])                 runs only when that cell flipped
// Drawing replaces `board`; world restarts from it when it sees a new board.
import { batch, computed, effect, get, set, signal, update } from "reflex-quant";

const COLS = 96, ROWS = 56, N = COLS * ROWS;
type Board = { generation: number; cells: Uint8Array };
type World = Board & { from: Board | null };

const NB = new Int32Array(N * 8);
for (let i = 0, k = 0; i < N; i++) {
  const x = i % COLS, y = (i / COLS) | 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dx || dy) NB[k++] = ((y + dy + ROWS) % ROWS) * COLS + ((x + dx + COLS) % COLS);
  }
}
function evolve(cells: Uint8Array): Uint8Array {
  const next = new Uint8Array(N);
  for (let i = 0, k = 0; i < N; i++, k += 8) {
    const n = cells[NB[k]] + cells[NB[k + 1]] + cells[NB[k + 2]] + cells[NB[k + 3]]
      + cells[NB[k + 4]] + cells[NB[k + 5]] + cells[NB[k + 6]] + cells[NB[k + 7]];
    next[i] = n === 3 || (n === 2 && cells[i]) ? 1 : 0;
  }
  return next;
}

function start(root: HTMLElement) {
  const cv = root.querySelector<HTMLCanvasElement>("canvas")!;
  const ctx = cv.getContext("2d")!;
  const $ = (q: string) => root.querySelector<HTMLElement>(q)!;
  const S = 8;
  cv.width = COLS * S; cv.height = ROWS * S;

  let worldRuns = 0, projRuns = 0, paints = 0, stepped = 0;
  const board = signal<Board>({ generation: 0, cells: new Uint8Array(N) });
  const generation = signal(0);

  const world = computed<World>((prev) => {
    worldRuns++;
    const base = get(board), target = get(generation);
    let w: World = prev.from === base ? prev : { ...base, from: base };
    // Coalesced requests still mean every generation: 100 -> 101 -> 102 -> 103.
    while (w.generation < target) { w = { from: base, generation: w.generation + 1, cells: evolve(w.cells) }; stepped++; }
    return w;
  }, { from: null, generation: 0, cells: new Uint8Array(N) });

  const cells = Array.from({ length: N }, (_, i) => computed(() => (projRuns++, get(world).cells[i])));
  cells.forEach((cell, i) => effect(() => {
    paints++;
    const x = (i % COLS) * S, y = ((i / COLS) | 0) * S;
    ctx.fillStyle = "#000"; ctx.fillRect(x, y, S, S);
    if (get(cell)) {
      ctx.fillStyle = "#eee";
      for (let j = 1; j < S; j += 3) for (let k = 1; k < S; k += 3) ctx.fillRect(x + k, y + j, 2, 2);
    }
  }));

  let last = 0;
  const measure = (fn: () => void) => {
    worldRuns = projRuns = paints = stepped = 0;
    const t = performance.now(); fn(); last = performance.now() - t;
    $("[data-gen]").textContent = String(get(world).generation);
    $("[data-world]").textContent = `${worldRuns} · +${stepped}`;
    $("[data-proj]").textContent = `${projRuns} / ${N}`;
    $("[data-paint]").textContent = `${paints} / ${N}`;
    $("[data-ms]").textContent = last.toFixed(1);
  };
  const step = () => measure(() => update(generation, (n) => n + 1));
  const jump = () => measure(() => batch(() => { for (let k = 0; k < 10; k++) update(generation, (n) => n + 1); }));
  const load = (fill: (x: number, y: number) => number) => measure(() => batch(() => {
    const c = new Uint8Array(N);
    for (let i = 0; i < N; i++) c[i] = fill(i % COLS, (i / COLS) | 0);
    set(generation, 0); set(board, { generation: 0, cells: c });
  }));
  const GUN = ["........................O", "......................O.O", "............OO......OO............OO", "...........O...O....OO............OO",
    "OO........O.....O...OO", "OO........O...O.OO....O.O", "..........O.....O.......O", "...........O...O", "............OO"];

  let timer = 0;
  const playBtn = $("[data-act=play]");
  const stop = () => { clearInterval(timer); timer = 0; playBtn.textContent = "▶ Play"; };
  const play = () => { stop(); timer = window.setInterval(step, 70); playBtn.textContent = "⏸ Pause"; };
  root.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (a === "play") timer ? stop() : play();
    else if (a === "step") { stop(); step(); }
    else if (a === "jump") { stop(); jump(); }
    else if (a === "gun") load((x, y) => (GUN[y - 4]?.[x - 4] === "O" ? 1 : 0));
    else if (a === "random") load(() => (Math.random() < 0.22 ? 1 : 0));
    else if (a === "clear") { stop(); load(() => 0); }
  });

  // Drawing: a new board = the current world with one cell changed.
  let pen = -1;
  const cellAt = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * COLS), y = Math.floor(((e.clientY - r.top) / r.height) * ROWS);
    return x >= 0 && y >= 0 && x < COLS && y < ROWS ? y * COLS + x : -1;
  };
  const draw = (i: number) => {
    const w = get(world);
    if (w.cells[i] === pen) return;
    const c = w.cells.slice(); c[i] = pen;
    measure(() => set(board, { generation: w.generation, cells: c }));
  };
  cv.addEventListener("pointerdown", (e) => {
    const i = cellAt(e); if (i < 0) return;
    pen = 1 - get(cells[i]); cv.setPointerCapture(e.pointerId); draw(i);
  });
  cv.addEventListener("pointermove", (e) => { const i = cellAt(e); if (pen >= 0 && i >= 0) draw(i); });
  cv.addEventListener("pointerup", () => (pen = -1));

  load((x, y) => (GUN[y - 4]?.[x - 4] === "O" ? 1 : 0));
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let auto = !still;
  new IntersectionObserver((es) => {
    if (!es[0].isIntersecting) stop();
    else if (auto) { auto = false; play(); }
  }, { threshold: 0.3 }).observe(cv);
}

document.querySelectorAll<HTMLElement>("[data-life]").forEach(start);
