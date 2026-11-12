// Check generated internal page/asset URLs against disk, including the Pages
// base path. URL paths are POSIX on every host; filesystem paths are native.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { BASE, SITE } from "../src/config.mjs";

const dist = path.resolve(import.meta.dirname, "../dist");
assert.ok(existsSync(path.join(dist, "index.html")), "missing site index");
assert.ok(existsSync(path.join(dist, "sitemap-index.xml")), "missing sitemap");
let pages = 0;
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { visit(file); continue; }
    if (!entry.name.endsWith(".html")) continue;
    pages++;
    const route = path.relative(dist, file).split(path.sep).join("/").replace(/index\.html$/, "");
    const origin = new URL(`${BASE}/${route}`, SITE);
    for (const [, value] of readFileSync(file, "utf8").matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
      if (value.startsWith("#")) continue;
      const url = new URL(value.replaceAll("&amp;", "&"), origin);
      if (url.origin !== origin.origin || !["http:", "https:"].includes(url.protocol)) continue;
      assert.ok(url.pathname.startsWith(`${BASE}/`) || url.pathname === BASE, `${route}: URL outside base: ${value}`);
      const target = path.join(dist, decodeURIComponent(url.pathname.slice(BASE.length)));
      assert.ok(existsSync(target), `${route}: missing target: ${value}`);
      if (statSync(target).isDirectory()) assert.ok(existsSync(path.join(target, "index.html")), `${route}: missing page: ${value}`);
    }
  }
}
visit(dist);
console.log(`checked internal links and assets in ${pages} generated pages`);
