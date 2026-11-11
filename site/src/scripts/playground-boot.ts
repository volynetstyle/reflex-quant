// The only script every page ships: one delegated click listener. The runner and the editor
// are separate chunks, imported on first use (Run → runner; Edit → CodeMirror).
import type { EditorView } from "codemirror";

const editors = new WeakMap<HTMLElement, EditorView>();

function source(pg: HTMLElement): string {
  return editors.get(pg)?.state.doc.toString() ?? pg.dataset.code ?? "";
}

async function runIn(pg: HTMLElement) {
  const out = pg.querySelector<HTMLElement>(".pg-out")!;
  const btn = pg.querySelector<HTMLButtonElement>("[data-run]")!;
  btn.disabled = true;
  out.hidden = false;
  out.replaceChildren();
  out.dataset.state = "running";
  try {
    const { run } = await import("./runner");
    let lines = 0;
    await run(source(pg), (l) => {
      lines++;
      const div = document.createElement("div");
      div.className = `pg-line pg-${l.kind}`;
      div.textContent = l.text;
      out.append(div);
    });
    if (!lines) out.append(Object.assign(document.createElement("div"), { className: "pg-line pg-info", textContent: "(no output)" }));
  } catch (e) {
    out.append(Object.assign(document.createElement("div"), { className: "pg-line pg-error", textContent: String(e) }));
  } finally {
    out.dataset.state = "done";
    btn.disabled = false;
  }
}

async function edit(pg: HTMLElement) {
  if (editors.has(pg)) return;
  const btn = pg.querySelector<HTMLButtonElement>("[data-edit]")!;
  btn.disabled = true;
  const { mount } = await import("./editor");
  const host = pg.querySelector<HTMLElement>(".pg-code")!;
  const original = pg.dataset.code ?? "";
  host.replaceChildren();
  const view = mount(host, original, () => runIn(pg));
  editors.set(pg, view);
  view.focus();
  btn.textContent = "Reset";
  btn.dataset.reset = "";
  btn.removeAttribute("data-edit");
  btn.disabled = false;
  btn.addEventListener("click", () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original } });
  });
}

document.addEventListener("click", (e) => {
  const t = (e.target as Element).closest<HTMLElement>("[data-run],[data-edit]");
  const pg = t?.closest<HTMLElement>("[data-pg]");
  if (!t || !pg) return;
  if (t.hasAttribute("data-run")) void runIn(pg);
  else if (t.hasAttribute("data-edit")) void edit(pg);
});

// Warm the runner chunk when a reader first approaches a playground; the editor stays cold.
let warm = false;
document.addEventListener(
  "pointerover",
  (e) => {
    if (warm || !(e.target as Element).closest?.("[data-pg]")) return;
    warm = true;
    void import("./runner");
  },
  { passive: true },
);
