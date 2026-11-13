// Runs a snippet in a module Web Worker: isolated from the page, no DOM, killed on timeout.
// `import ... from "reflex-quant"` is rewritten to the published development build on jsDelivr
// (it has no imports of its own, and its development build reports cycles as "Cycle detected").

export const QUANT_URL = "https://cdn.jsdelivr.net/npm/reflex-quant@1.2.0/dist/index.development.js";
const TIMEOUT_MS = 3000;

export type Line = { kind: "log" | "warn" | "error" | "info"; text: string };

const HARNESS = `
const fmt = (v, depth = 0) => {
  if (typeof v === "string") return depth ? JSON.stringify(v) : v;
  if (typeof v === "function") return "[Function " + (v.name || "anonymous") + "]";
  if (v instanceof Error) return v.name + ": " + v.message;
  if (v === null || typeof v !== "object") return String(v);
  if (depth > 2) return Array.isArray(v) ? "[…]" : "{…}";
  if (Array.isArray(v)) return "[ " + v.map((x) => fmt(x, depth + 1)).join(", ") + " ]";
  const keys = Object.keys(v);
  return "{ " + keys.map((k) => k + ": " + fmt(v[k], depth + 1)).join(", ") + " }";
};
const send = (kind, args) => postMessage({ kind, text: args.map((a) => fmt(a)).join(" ") });
for (const kind of ["log", "info", "warn", "error"]) console[kind] = (...a) => send(kind, a);
addEventListener("unhandledrejection", (e) => send("error", ["Uncaught (in promise)", e.reason]));
addEventListener("error", (e) => send("error", [e.message]));
onmessage = async ({ data }) => {
  if (data.preload) {
    // Load reflex-quant before the clock starts, so a slow network is not taken for a hang.
    try { await import(data.preload); postMessage({ ready: true }); }
    catch (e) { send("error", ["Could not load reflex-quant:", e]); postMessage({ done: true }); }
    return;
  }
  try { await import(data.code); } catch (e) { send("error", [e]); }
  setTimeout(() => postMessage({ done: true }), 0);
};`;

const harnessUrl = URL.createObjectURL(new Blob([HARNESS], { type: "text/javascript" }));

export function prepare(source: string): string {
  return source.replace(/(from\s*|import\s*\(\s*)(["'])reflex-quant\2/g, `$1"${QUANT_URL}"`);
}

/** Runs `source`; calls `onLine` per console line; resolves when done or stopped. */
export function run(source: string, onLine: (l: Line) => void): Promise<void> {
  return new Promise((resolve) => {
    const worker = new Worker(harnessUrl, { type: "module" });
    const code = URL.createObjectURL(new Blob([prepare(source)], { type: "text/javascript" }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(code);
      resolve();
    };
    worker.onmessage = ({ data }) => {
      if (data.ready) {
        timer = setTimeout(() => {
          onLine({ kind: "error", text: `Stopped after ${TIMEOUT_MS / 1000} s (infinite loop?)` });
          finish();
        }, TIMEOUT_MS);
        worker.postMessage({ code });
      } else if (data.done) finish();
      else onLine(data);
    };
    worker.onerror = (e) => {
      onLine({ kind: "error", text: e.message || "Worker failed to start" });
      finish();
    };
    worker.postMessage({ preload: QUANT_URL });
  });
}
