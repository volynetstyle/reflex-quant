// Shared deployment address and per-page content dates for the sitemap and metadata.
export const SITE = "https://volynetstyle.github.io";
export const BASE = "/reflex-quant";

// Update a page's date when its substantive content changes, not on every build.
const PAGE_UPDATED = {
  "/": "2026-11-15",
  "/alien-signals-comparison/": "2026-11-15",
  "/benchmarks/": "2026-11-15",
  "/constraints/": "2026-11-12",
  "/dynamic-dependency-tracking/": "2026-11-14",
  "/fireflies/": "2026-11-12",
  "/game-of-life/": "2026-11-12",
  "/javascript-signals-runtime/": "2026-11-12",
  "/reactive-runtime-anatomy/": "2026-11-15",
  "/vue-reactivity-comparison/": "2026-11-15",
};
export const pageUpdated = (path) => PAGE_UPDATED[path];
