// Correctness preflight only: execute cost cells without collecting timings.
// Node subprocesses and argument arrays work on Windows, macOS and Linux.
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const run = (file, args = []) => execFileSync(process.execPath, [path.join(root, file), ...args], { cwd: root, stdio: "inherit" });
const args = process.argv.slice(2);
const main = args.indexOf("--main");
run("bench/build.mjs", main < 0 ? [] : args.slice(main, main + 2));
run("bench/cost/build.mjs");
const probes = process.argv.includes("--smoke")
  ? ["leaf", "decompose"]
  : ["regime", "layout", "decompose", "leaf", "lower-bound", "surface", "reorder"];
for (const probe of probes) run("bench/cost/run.mjs", [probe, "--verify-only"]);
