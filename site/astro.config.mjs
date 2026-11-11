import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { BASE, SITE, UPDATED } from "./src/config.mjs";

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: "always",
  build: { format: "directory", inlineStylesheets: "always" },
  integrations: [sitemap({ lastmod: new Date(UPDATED) })],
});
