import { defineConfig } from "vitest/config";
export default defineConfig(({ mode }) => ({
  define: { __DEV__: mode !== "production", __STATS__: true },
  test: {
    include: ["research/collections/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 1,
    testTimeout: 30000,
  },
}));
