// UI of the reorder stand. Each change of the read order runs one pass through both models and
// replays it read by read: the list re-renders after every read, chips slide to their new place.
import { alienPass, quantPass, type Pass } from "./reorder";
import { still, within } from "./util";

const START = ["A", "B", "C", "D", "E", "F", "G", "H"];
const SPARE = ["J", "K", "M", "N", "P"];

function mount(root: HTMLElement) {
  const $ = within(root);
  const readsEl = $("[data-rs-reads]");
  const lanes = {
    quant: { el: $("[data-lane=quant]"), pass: quantPass, list: [...START], total: { created: 0, removed: 0 } },
    alien: { el: $("[data-lane=alien]"), pass: alienPass, list: [...START], total: { created: 0, removed: 0 } },
  };
  let reads = [...START], passes = 0, timer = 0;

  // ---- read order row: buttons, draggable, arrow keys
  const drawReads = (focus = -1) => {
    readsEl.innerHTML = reads.map((s, k) => `<button type="button" role="option" aria-selected="false" class="rs-src" data-k="${k}">${s}</button>`).join("");
    if (focus >= 0) readsEl.querySelectorAll<HTMLElement>(".rs-src")[focus]?.focus();
  };
  readsEl.addEventListener("keydown", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".rs-src");
    if (!b || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const k = +b.dataset.k!, j = k + (e.key === "ArrowLeft" ? -1 : 1);
    if (j < 0 || j >= reads.length) return;
    [reads[k], reads[j]] = [reads[j], reads[k]];
    drawReads(j); run();
  });
  let drag: { k: number; x0: number; el: HTMLElement } | null = null;
  readsEl.addEventListener("pointerdown", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".rs-src");
    if (!b) return;
    drag = { k: +b.dataset.k!, x0: e.clientX, el: b };
    b.setPointerCapture(e.pointerId); b.classList.add("drag");
  });
  readsEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.el.style.transform = `translateX(${e.clientX - drag.x0}px)`;
    const tiles = [...readsEl.querySelectorAll<HTMLElement>(".rs-src")];
    const centres = tiles.map((t) => { const r = t.getBoundingClientRect(); return r.left + r.width / 2; });
    let j = centres.findIndex((c) => e.clientX < c); if (j < 0) j = tiles.length - 1;
    if (j !== drag.k) {
      const [s] = reads.splice(drag.k, 1); reads.splice(j, 0, s);
      drawReads(); drag = { k: j, x0: e.clientX, el: readsEl.querySelectorAll<HTMLElement>(".rs-src")[j] };
      drag.el.classList.add("drag");
    }
  });
  const endDrag = () => { if (!drag) return; drag = null; drawReads(); run(); };
  readsEl.addEventListener("pointerup", endDrag);
  readsEl.addEventListener("pointercancel", endDrag);

  // ---- lanes: render a list with FLIP so chips slide instead of jumping
  const keyed = (list: string[]) => { const seen: Record<string, number> = {}; return list.map((s) => `${s}${(seen[s] = (seen[s] ?? 0) + 1)}`); };
  const drawLane = (el: HTMLElement, list: string[], cursor: number, mark: { src?: string; kind?: string; dropped?: string[] } = {}) => {
    const box = el.querySelector<HTMLElement>("[data-rs-list]")!;
    for (const a of box.getAnimations({ subtree: true })) a.finish();   // measure settled positions
    const before = new Map([...box.children].map((c) => [(c as HTMLElement).dataset.key!, c.getBoundingClientRect()]));
    const keys = keyed(list);
    box.innerHTML = list.map((s, k) => {
      const cls = ["rs-edge", k < cursor ? "read" : "", mark.src === s && k === cursor - 1 ? `now ${mark.kind}` : "", mark.dropped && k >= cursor ? "gone" : ""].join(" ");
      return `${k === cursor ? '<i class="rs-cur" aria-hidden="true">▸</i>' : ""}<span class="${cls}" data-key="${keys[k]}">${s}</span>`;
    }).join("") + (cursor >= list.length ? '<i class="rs-cur" aria-hidden="true">▸</i>' : "");
    if (still) return;
    for (const c of box.querySelectorAll<HTMLElement>(".rs-edge")) {
      const r0 = before.get(c.dataset.key!);
      if (!r0) { c.classList.add("born"); continue; }
      const r1 = c.getBoundingClientRect(), dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (dx || dy) c.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.7,.2,1)" });
    }
  };
  const count = (el: HTMLElement, p: Pass) => {
    for (const k of ["created", "removed", "hits", "moved"] as const) {
      const dd = el.querySelector<HTMLElement>(`[data-c=${k}]`);
      if (dd) { dd.textContent = String(p[k]); dd.classList.toggle("hot", (k === "created" || k === "removed") && p[k] > 0); }
    }
  };

  const run = () => {
    clearTimeout(timer);
    passes++;
    const results = Object.values(lanes).map((L) => ({ L, p: L.pass(L.list, reads) }));
    for (const { L, p } of results) { L.total.created += p.created; L.total.removed += p.removed; count(L.el, p); }
    const q = results[0], a = results[1];
    $("[data-rs-total]").textContent = `Pass ${passes}: Quant created ${q.p.created} and removed ${q.p.removed}; alien-signals created ${a.p.created} and removed ${a.p.removed}. Since reset: ${q.L.total.created + q.L.total.removed} against ${a.L.total.created + a.L.total.removed} relations allocated or freed.`;
    const done = () => { for (const { L, p } of results) { L.list = p.list; drawLane(L.el, p.list, p.list.length); } };
    if (still) return done();
    let i = 0;
    const n = Math.max(...results.map((r) => r.p.events.length));
    const tick = () => {
      if (i < n) {
        for (const { L, p } of results) {
          const ev = p.events[Math.min(i, p.events.length - 1)];
          const cursor = p.events.slice(0, i + 1).reduce((c, e) => c + (e.kind === "repeat" ? 0 : 1), 0);
          drawLane(L.el, ev.list, cursor, i < p.events.length ? { src: ev.src, kind: ev.kind } : {});
        }
        i++; timer = window.setTimeout(tick, 230);
      } else if (i === n) {
        for (const { L, p } of results) { const last = p.events.at(-1); const cursor = p.list.length; drawLane(L.el, last ? last.list : L.list, cursor, { dropped: p.dropped }); }
        i++; timer = window.setTimeout(tick, 420);
      } else done();
    };
    tick();
  };

  // ---- presets
  const rnd = () => Math.random();
  root.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLElement>("[data-rs]")?.dataset.rs;
    if (!a) return;
    if (a === "rotate") reads.push(reads.shift()!);
    else if (a === "reverse") reads.reverse();
    else if (a === "swap") { const i = Math.floor(rnd() * reads.length); let j = Math.floor(rnd() * (reads.length - 1)); if (j >= i) j++; [reads[i], reads[j]] = [reads[j], reads[i]]; }
    else if (a === "shuffle") for (let i = reads.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [reads[i], reads[j]] = [reads[j], reads[i]]; }
    else if (a === "replace") { const free = [...START, ...SPARE].filter((s) => !reads.includes(s)); reads[Math.floor(rnd() * reads.length)] = free[Math.floor(rnd() * free.length)]; }
    else if (a === "reset") {
      clearTimeout(timer); reads = [...START]; passes = 0;
      for (const L of Object.values(lanes)) { L.list = [...START]; L.total = { created: 0, removed: 0 }; drawLane(L.el, L.list, L.list.length); count(L.el, { created: 0, removed: 0, hits: 0, moved: 0 } as Pass); }
      $("[data-rs-total]").textContent = "Both lists hold A to H from the previous pass. Change the read order to run the next one.";
      drawReads(); return;
    }
    drawReads(); run();
  });

  drawReads();
  for (const L of Object.values(lanes)) drawLane(L.el, L.list, L.list.length);
  $("[data-rs-total]").textContent = "Both lists hold A to H from the previous pass. Change the read order to run the next one.";
}

document.querySelectorAll<HTMLElement>("[data-reorder]").forEach(mount);
