// Scenario suites shared by run.mjs, worker.mjs and structure.mjs.
//
//   scenarios   graph shapes: mixed workloads (scenarios.mjs)
//   mechanisms  one mechanism per scenario: read, write, track, push, pull,
//               effect, batch, lifecycle (mechanisms.mjs)
import { scenarios as graph } from "./scenarios.mjs";
import { scenarios as mechanisms } from "./mechanisms.mjs";

export const suites = { scenarios: graph, mechanisms };

export function suiteOf(argv) {
  const i = argv.indexOf("--suite");
  const name = i < 0 ? "scenarios" : argv[i + 1];
  const list = suites[name];
  if (list === undefined) throw new Error(`unknown suite ${name}; expected one of ${Object.keys(suites).join(", ")}`);
  return { name, scenarios: list };
}
