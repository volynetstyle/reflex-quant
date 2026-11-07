// Tests of the quant experiment. The differential suites import the Reflex
// runtime from source through its own test harness, so this config carries
// the same compile-time flags and alias as the runtime's `source` profile.
// QUANT_SRC=<dir> redirects every import of src/ to a mutant copy
// (research/mutants.mjs).
//
// Quant's own __DEV__ (development diagnostics, the C1 precondition) is set
// per file, because the Reflex runtime reads a global __DEV__ of its own:
// true by default, false with `--mode production` (npm run test:production),
// which runs the suite against the machine the release ships.
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const slashes = (p: string) => p.split("\\").join("/");
const srcDir = slashes(resolve(root, "src"));
const mutantSrc = process.env.QUANT_SRC;
const quantDirs = [srcDir, ...(mutantSrc ? [slashes(resolve(mutantSrc))] : [])].map((dir) => dir + "/");

const redirect: Plugin = {
  name: "quant-mutant-src",
  enforce: "pre",
  async resolveId(source, importer, options) {
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (resolved === null) return null;
    const id = slashes(resolved.id);
    return id.startsWith(srcDir + "/") ? resolve(mutantSrc!, id.slice(srcDir.length + 1)) : null;
  },
};

const quantDev = (dev: boolean): Plugin => ({
  name: "quant-dev",
  enforce: "pre",
  transform(code, id) {
    const file = slashes(id.split("?")[0]!);
    if (!quantDirs.some((dir) => file.startsWith(dir))) return null;
    return { code: code.replace(/\b__DEV__\b/g, String(dev)), map: null };
  },
});

export default defineConfig(({ mode }) => ({
  root,
  plugins: [quantDev(mode !== "production"), ...(mutantSrc ? [redirect] : [])],
  resolve: { alias: { "@runtime": resolve(root, "reference/reflex/src") } },
  define: { __DEV__: false, __PROFILE__: false, __TRACKING_ONE_HOP__: true, __TRACKING_TWO_HOP__: true, __TRACKING_LAST_EDGE__: true, __TEST__: true, __PROD__: false, __STATS__: "true" },
  esbuild: { platform: "node", format: "esm", target: "es2022" } as never,
  test: {
    name: "runtime-quant",
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: process.env.QUANT_TOOLS ? [] : ["test/tools/**"],
    pool: "forks",
    testTimeout: 300_000,
    env: { QUANT_DEV: mode !== "production" ? "1" : "0" },
  },
}));
