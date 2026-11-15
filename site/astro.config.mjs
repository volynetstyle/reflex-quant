import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { BASE, SITE, pageUpdated } from "./src/config.mjs";

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: "always",
  build: { format: "directory", inlineStylesheets: "always" },
  integrations: [sitemap({
    serialize(item) {
      const path = new URL(item.url).pathname.slice(BASE.length) || "/";
      const updated = pageUpdated(path);
      return updated ? { ...item, lastmod: new Date(updated) } : item;
    },
  })],
});
