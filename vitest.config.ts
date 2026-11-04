// Tests of the quant experiment. The differential suites import the Reflex
// runtime from source through its own test harness, so this config carries
// the same compile-time flags and alias as the runtime's `source` profile.
import { defineConfig } from "vitest/config";
import { runtimeFlags } from "../../tooling/configs/runtime-flags.ts";
import { configRoot, sourceAliases } from "../../tooling/configs/source-aliases.ts";

const root = configRoot(import.meta.url);

export default defineConfig({
  root,
  resolve: { alias: sourceAliases("runtime") },
  define: { ...runtimeFlags("source-test") },
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
