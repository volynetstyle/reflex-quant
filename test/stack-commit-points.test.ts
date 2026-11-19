import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

// RQ6 commit points. Vitest's module wrappers turn a stack overflow inside a
// cross-module call into a TypeError, so these witnesses run against an
// esbuild bundle of the source under test, each in a fresh process
// (research/stack-commit-points.mjs). QUANT_SRC redirects them to a mutant.
const root = path.resolve(import.meta.dirname, "..");
const mode = process.env.QUANT_DEV === "0" ? "production" : "development";
const src = process.env.QUANT_SRC ?? path.join(root, "src");

function witness(name: string): void {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "research/stack-commit-points.mjs"), "--mode", mode, "--src", src, "--only", name],
    { encoding: "utf8", timeout: 300_000 },
  );
  expect(result.stdout.trim()).toMatch(/^held /);
  expect(result.status).toBe(0);
}

it("an abandoned computed activation does not stay BUSY (RQ6)", () => {
  witness("activation");
});

it("creating a watcher at the stack limit leaves the host open (RQ6)", () => {
  witness("create");
});

it("a drain at the stack limit leaves the host open and its watchers wakeable (RQ6)", () => {
  witness("drain");
});

it("a watcher whose enqueue grows the ring at the stack limit stays wakeable (RQ6)", () => {
  witness("enqueue");
});
