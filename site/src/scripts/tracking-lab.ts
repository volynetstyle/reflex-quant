// UI of the tracking lab. Picking a scenario runs it on the real reflex-quant the site ships
// (tracking.ts records the runtime's own nodes after every read); the controls replay the
// recorded frames. Nothing on screen is a model: chips are edge objects, numbered by identity.
import * as quant from "reflex-quant";
import { record, type Api, type EdgeView, type Frame, type Kind, type ListView, type Step } from "./tracking";
import { SCENARIOS, type Scenario } from "./tracking-scenarios";
import { still, within } from "./util";

const TAGS: Record<string, string> = {
  T1: "T1 exact tracking", T2: "T2 one relation per pair", T3: "T3 nesting isolation", P5: "P5 in-pass invalidation",
  R: "R failure keeps the wake set", S1: "S1 no lookup per stable read", S2: "S2 no new relation when one exists",
  S3: "S3 no quadratic tracking", S5: "S5 failures do not accumulate", S6: "S6 nesting rebuilds nothing",
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);
const nth = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
const list = (xs: string[]) => xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** What one frame shows, in words. */
function say(f: Frame, sc: Scenario, indexed: boolean): string {
  if (f.type === "step") return f.step === 0 ? "Press Next to step through the program, one read at a time." : `Next: <code>${esc(f.label)}</code>`;
  if (f.type === "run") {
    const l = f.snap.lists.find((x) => x.name === f.consumer)!;
    return l.edges.length
      ? `<b>${f.consumer}</b> runs. Its list is what its last run left, in that run's read order; the cursor starts before the first edge.`
      : `<b>${f.consumer}</b> runs for the first time: its list is empty.`;
  }
  if (f.type === "end") {
    const c = f.consumer, removed = f.removed.length ? list(f.removed.map((s) => `<b>${s}</b>`)) : "";
    if (f.disposed) return `<b>${c}</b> is disposed: every edge is cut from its list and from its sources' subscriber lists.`;
    const others = f.snap.sources.filter((s) => s.slot && s.slot.owner !== c).map((s) => s.slot!.owner);
    const back = others.length ? ` The slots hold <b>${others[0]}</b>'s cells again: they come back from the work stack as ${c}'s run ends.` : "";
    if (!f.ok) {
      const kept = f.snap.lists.find((x) => x.name === c)!.edges.filter((e) => !e.tentative).map((e) => e.src);
      return `<b>${c}</b> throws: nothing is committed and it owes a run. Every edge stays: ${list(kept.map((s) => `<b>${s}</b>`))} from the last success, and the dashed one${f.born.length > 1 ? "s" : ""} it read in this attempt (tentative). All of them still wake it.`
        + (removed ? ` ${removed}, tentative from an earlier failed attempt and not reached this time, is dropped: failures do not pile up edges (S5).` : "") + back;
    }
    const slots = indexed && !others.length ? " The run was indexed: its slots are cleared." : "";
    // An edge older than its source: the source changed after the run read it (P5).
    const stale = f.snap.lists.find((x) => x.name === c)!.edges.filter((e) => e.ver >= 0 && e.ver !== e.srcVer).map((e) => e.src);
    const owes = stale.length ? ` But ${list(stale.map((s) => `<b>${s}</b>`))} changed after this run read ${stale.length > 1 ? "them" : "it"}: the edge keeps the version it saw, so ${c} owes another run.` : "";
    return `<b>${c}</b> commits.` + (removed ? ` ${removed} ${f.removed.length > 1 ? "were" : "was"} not read: cut from the list and from the source's subscribers.` : " Every edge was read: nothing to cut.")
      + owes + slots + back;
  }
  return sayRead(f.consumer, f.src, f.explain, f.over);
}

function sayRead(c: string, s: string, ex: Step, over?: string): string {
  const S = `<b>${s}</b>`, C = `<b>${c}</b>`, k = `<span class="tl-k ${ex.kind}">${ex.kind}</span>`;
  const walk = ex.walk === "mark"
    ? ` ${C} marks its ${ex.walked} unread edges (u), once in this run: from now on every out-of-place read is one lookup through the source's subscribers.`
    : ex.walk === "index"
      ? ` ${C} indexes its ${ex.walked} edges into their sources' slots, once in this run${ex.displaced ? `; ${ex.displaced} cells an outer run held there go on the work stack` : ""}: from now on every out-of-place read is one load of the source's slot.`
      : "";
  switch (ex.proof) {
    case "cursor": return `${k} ${S} is the edge after the cursor: one comparison, the cursor moves on. No lookup, no allocation.`;
    case "own": return `${k} ${S} again, the cursor's own source: nothing moves, and the edge keeps the version of the first read.`;
    case "empty": return `${k} The list is empty: the first edge, appended to ${S}'s subscribers.`;
    case "nobody": return `${k} Nobody reads ${S}, so no edge to it can exist: a new one goes in at the cursor, without any search.`;
    case "others": return `${k} ${S} has one or two readers and ${C} is not one of them: its first and last subscribers are one load apart, so absence is proven from the source's side. A new edge at the cursor.`;
    case "tail": return `${k} Found among the last two edges, where skipped edges are sent: moved to the cursor.`;
    case "one-past":
    case "ahead": {
      const where = ex.proof === "one-past" ? `right behind <b>${over}</b>, the edge under the cursor` : `${ex.at} past <b>${over}</b>, the edge under the cursor`;
      return ex.kind === "skip"
        ? `${k} ${S} is ${where}: it moves to the cursor, and <b>${over}</b> is marked (s), as it is most likely read next.`
        : `${k} ${S} is ${where}, which was skipped once already: <b>${over}</b> goes to the end of the list, to be read later or never.`;
    }
    case "behind": return `${k} Found ${ex.at} behind the cursor: read earlier in this run. Nothing moves; the edge keeps the version of its first read.`;
    case "ends": return `${k} Both bounded scans reached the ends of ${C}'s list without ${S}: absent, however many readers ${S} has. A new edge at the cursor.`;
    case "subs": {
      if (ex.budget && ex.kind === "new") return `${k} The bounded scans gave up, and ${S} has more than 8 subscribers before any of ${C}'s.${walk} ${S}'s slot holds no edge of ${C}: absent. A new edge, claimed into the slot.`;
      if (ex.kind === "new") return `${k} The scans gave up; ${S}'s subscribers end without ${C}: absent. A new edge at the cursor.`;
      const where = ex.budget ? `${S}'s first 8 subscribers are others` : ex.walk === "mark" ? `${C}'s edge is ${S}'s first subscriber` : `${C}'s edge is ${S}'s ${nth(ex.at!)} subscriber`;
      return `${k} The bounded scans gave up. ${where}.${walk}${ex.kind === "move" ? ` ${S} moves to the cursor.` : " It was read already: a repeat."}`;
    }
    case "marked":
      if (ex.kind === "new") return `${k} This run is marked: ${S}'s subscribers end without ${C}. A new edge at the cursor.`;
      if (ex.budget) return `${k} This run is marked, but ${S}'s first 8 subscribers are others.${walk} ${ex.kind === "new" ? `${S}'s slot holds no edge of ${C}: a new edge, claimed into the slot.` : ex.kind === "move" ? `${S} moves to the cursor.` : "It was read already: a repeat."}`;
      return ex.kind === "move"
        ? `${k} This run is marked: ${C}'s edge is ${S}'s ${nth(ex.at!)} subscriber and unread, so it moves to the cursor. One lookup.`
        : `${k} This run is marked: ${S}'s subscribers hold ${C}'s edge, read already. A repeat.`;
    case "slot":
      if (ex.kind === "move") return `${k} This run is indexed: <code>${s}.slot</code> holds ${C}'s edge, unread, so it moves to the cursor. One load.`;
      if (ex.kind === "repeat") return `${k} This run is indexed: <code>${s}.slot</code> holds ${C}'s edge, read already. A repeat.`;
      return `${k} This run is indexed: <code>${s}.slot</code> holds no edge of ${C}, so the edge is absent. A new one, claimed into the slot${ex.displaced ? "; the cell there goes on the work stack" : ""}.`;
  }
}

function mount(root: HTMLElement) {
  const $ = within(root);
  const tabs = $("[data-tl-tabs]"), lanes = $("[data-tl-lists]"), srcs = $("[data-tl-sources]");
  const sayEl = $("[data-tl-say]"), steps = $("[data-tl-steps]"), tally = $("[data-tl-tally]"), pos = $("[data-tl-pos]");
  const scrub = $<HTMLInputElement>("[data-tl-scrub]"), play = $("[data-tl=play]");
  let sc = SCENARIOS[0], frames: Frame[] = [], labels: string[] = [], at = 0, timer = 0;

  tabs.innerHTML = SCENARIOS.map((s, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-sc="${s.id}">${s.title}</button>`).join("");

  const chip = (e: EdgeView, l: ListView, f: Frame, idx: number) => {
    const now = (f.type === "read" && f.consumer === l.name && f.src === e.src) ? ` now ${f.explain.kind}` : "";
    const over = f.type === "read" && f.consumer === l.name && f.over === e.src ? " over" : "";
    const born = f.type === "end" && f.consumer === l.name && f.born.includes(e.src) ? " born" : "";
    const ahead = l.cursor !== null && idx >= l.cursor ? " ahead" : "";
    const cls = `tl-e${e.read ? " read" : ""}${ahead}${e.unread ? " u" : ""}${e.skipped ? " sk" : ""}${e.tentative ? " tent" : ""}${e.slot ? " slot" : ""}${now}${over}${born}`;
    const ver = sc.versions ? `<i class="tl-v">v${e.ver < 0 ? "?" : e.ver}</i>` : "";
    const marks = `${e.unread ? '<i class="tl-m">u</i>' : ""}${e.skipped ? '<i class="tl-m">s</i>' : ""}`;
    const title = `edge #${e.id}: ${e.src} → ${l.name}; ${e.unread ? "unread (marked)" : e.skipped ? "skipped once" : `saw ${e.src} at v${e.ver}`}${e.tentative ? "; not committed" : ""}${e.slot ? `; in ${e.src}.slot` : ""}`;
    return `<span class="${cls}" data-key="${e.id}" title="${esc(title)}"><b>${esc(e.src)}</b><sub>#${e.id}</sub>${marks}${ver}</span>`;
  };

  const draw = () => {
    const f = frames[at];
    const flip = new Map<string, DOMRect>();
    for (const a of lanes.getAnimations({ subtree: true })) a.finish();
    lanes.querySelectorAll<HTMLElement>(".tl-e[data-key]").forEach((el) => flip.set(`${el.closest<HTMLElement>("[data-lane]")!.dataset.lane}:${el.dataset.key}`, el.getBoundingClientRect()));

    lanes.innerHTML = f.snap.lists.map((l, li) => {
      const cur = `<i class="tl-cur" aria-hidden="true">▸</i>`;
      const body = l.edges.map((e, i) => (l.cursor === i ? cur : "") + chip(e, l, f, i)).join("") + (l.cursor === l.edges.length ? cur : "");
      const gone = f.type === "end" && f.consumer === l.name ? f.removed.map((s) => `<span class="tl-e gone"><b>${esc(s)}</b></span>`).join("") : "";
      const state = l.cursor !== null ? `running · cursor after ${l.cursor} of ${l.edges.length}` : l.edges.length ? `idle · ${l.edges.length} edge${l.edges.length > 1 ? "s" : ""}` : "no edges";
      return `<section class="tl-lane o${li}" data-lane="${l.name}"><div class="tl-lh"><b>${esc(l.name)}</b><span>dependency list, read order</span><em>${state}</em></div><div class="tl-list">${body || '<span class="tl-empty">empty</span>'}${gone}</div></section>`;
    }).join("");

    if (!still) lanes.querySelectorAll<HTMLElement>(".tl-e[data-key]").forEach((el) => {
      const r0 = flip.get(`${el.closest<HTMLElement>("[data-lane]")!.dataset.lane}:${el.dataset.key}`);
      if (!r0) { el.classList.add("fresh"); return; }
      const r1 = el.getBoundingClientRect(), dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (dx || dy) el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(.2,.7,.2,1)" });
    });

    srcs.hidden = !f.snap.sources.length;
    srcs.innerHTML = f.snap.sources.length ? `<div class="tl-sh">sources: subscribers in birth order, and the slot</div><div class="tl-srcs">` + f.snap.sources.map((s) => {
      const li = s.slot ? f.snap.lists.findIndex((l) => l.name === s.slot!.owner) : -1;
      const subs = s.subs.length > 3 ? `${s.subs.length} readers: ${s.subs.slice(0, 1).join("")} … ${s.subs.slice(-2).join(", ")}` : s.subs.length ? s.subs.join(", ") : "no readers";
      return `<div class="tl-s${f.type === "read" && f.src === s.name ? " now" : ""}"><b>${esc(s.name)}</b>${sc.versions ? `<i class="tl-v">v${s.ver}</i>` : ""}<span>${esc(subs)}</span><em class="${s.slot ? `on o${li}` : ""}">${s.slot ? `slot → ${esc(s.slot.owner)} #${s.slot.id}` : "slot —"}</em></div>`;
    }).join("") + "</div>" : "";

    // Whether the consumer of an end frame indexed during this run.
    const indexed = f.type === "end" && frames.slice(0, at).some((x) => x.step === f.step && x.type === "read" && x.consumer === f.consumer && x.explain.walk === "index");
    sayEl.innerHTML = say(f, sc, indexed);
    const step = f.step;
    steps.querySelectorAll("li").forEach((li, i) => { li.classList.toggle("cur", i === step); li.classList.toggle("done", i < step); });
    // The step's reads so far, by kind, and its edges created and removed.
    const upto = frames.slice(0, at + 1).filter((x) => x.step === step);
    const count: Partial<Record<Kind, number>> = {};
    for (const x of upto) if (x.type === "read") count[x.explain.kind] = (count[x.explain.kind] ?? 0) + 1;
    const removed = upto.reduce((n, x) => n + (x.type === "end" ? x.removed.length : 0), 0);
    const parts = (["hit", "repeat", "skip", "defer", "tail", "move", "new"] as Kind[]).filter((k) => count[k]).map((k) => `<span class="tl-k ${k}">${k}</span> ${count[k]}`);
    tally.innerHTML = `this step: ${parts.length ? parts.join(" · ") : "no reads yet"}${removed ? ` · <span class="tl-k gone">removed</span> ${removed}` : ""}`;
    pos.textContent = `${at + 1} / ${frames.length}`;
    scrub.value = String(at);
  };

  const go = (i: number) => { at = Math.max(0, Math.min(frames.length - 1, i)); draw(); };
  const stop = () => { clearInterval(timer); timer = 0; play.textContent = "Play"; play.setAttribute("aria-pressed", "false"); };
  const load = (id: string) => {
    stop();
    sc = SCENARIOS.find((s) => s.id === id)!;
    const r = record(quant as unknown as Api, { lists: sc.lists, sources: sc.sources }, sc.build);
    frames = r.frames; labels = r.steps.map((s) => s.label);
    tabs.querySelectorAll<HTMLElement>("[data-sc]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.sc === id)));
    $("[data-tl-blurb]").textContent = sc.blurb;
    $("[data-tl-tags]").innerHTML = sc.tags.map((t) => `<span class="tl-tag" title="${esc(TAGS[t] ?? t)}">${t}</span>`).join("");
    $("[data-tl-code]").textContent = sc.code;
    steps.innerHTML = labels.map((l, i) => `<li><button type="button" data-step="${i}"><code>${esc(l)}</code></button></li>`).join("");
    scrub.max = String(frames.length - 1);
    go(0);
  };

  tabs.addEventListener("click", (e) => { const id = (e.target as Element).closest<HTMLElement>("[data-sc]")?.dataset.sc; if (id) load(id); });
  steps.addEventListener("click", (e) => {
    const s = (e.target as Element).closest<HTMLElement>("[data-step]")?.dataset.step;
    if (s !== undefined) { stop(); go(frames.findIndex((f) => f.step === +s)); }
  });
  scrub.addEventListener("input", () => { stop(); go(+scrub.value); });
  root.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLElement>("[data-tl]")?.dataset.tl;
    if (!a) return;
    if (a === "first") { stop(); go(0); }
    else if (a === "prev") { stop(); go(at - 1); }
    else if (a === "next") { stop(); go(at + 1); }
    else if (a === "play") {
      if (timer) return stop();
      if (at >= frames.length - 1) go(0);
      play.textContent = "Pause"; play.setAttribute("aria-pressed", "true");
      timer = window.setInterval(() => (at >= frames.length - 1 ? stop() : go(at + 1)), still ? 1400 : 900);
    }
  });
  root.addEventListener("keydown", (e) => {
    if ((e.target as Element).closest("input,[role=tab]")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); stop(); go(at + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); stop(); go(at - 1); }
  });
  load(root.dataset.start ?? SCENARIOS[0].id);
}

document.querySelectorAll<HTMLElement>("[data-tracking-lab]").forEach(mount);
// Links on the page can open a scenario: <a href="#lab" data-lab="reorder">.
document.addEventListener("click", (e) => {
  const a = (e.target as Element).closest<HTMLElement>("[data-lab]");
  const lab = document.querySelector<HTMLElement>("[data-tracking-lab]");
  if (!a || !lab) return;
  lab.querySelector<HTMLElement>(`[data-sc="${a.dataset.lab}"]`)?.click();
});
