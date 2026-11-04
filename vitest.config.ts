// Tests of the quant experiment. The differential suites import the Reflex
// runtime from source through its own test harness, so this config carries
// the same compile-time flags and alias as the runtime's `source` profile.
// QUANT_SRC=<dir> redirects every import of src/ to a mutant copy
// (research/mutants.mjs).
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";
import { runtimeFlags } from "../../tooling/configs/runtime-flags.ts";
import { configRoot, sourceAliases } from "../../tooling/configs/source-aliases.ts";

const root = configRoot(import.meta.url);
const slashes = (p: string) => p.split("\\").join("/");
const srcDir = slashes(resolve(root, "src"));
const mutantSrc = process.env.QUANT_SRC;

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

export default defineConfig({
  root,
  plugins: mutantSrc ? [redirect] : [],
  resolve: { alias: sourceAliases("runtime") },
  define: { ...runtimeFlags("source-test"), __STATS__: "true" },
  esbuild: { platform: "node", format: "esm", target: "es2022" } as never,
  test: {
    name: "runtime-quant",
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: process.env.QUANT_TOOLS ? [] : ["test/tools/**"],
    pool: "forks",
    testTimeout: 300_000,
  },
});
