import {
  Changed,
  Computing,
  Both,
  Unknown,
  type ReactiveEdge,
  type ReactiveNode,
} from "@runtime/kernel/shape";
import { devAssertRefreshEdge } from "@runtime/kernel/dev";
import {
  observeRuntimeProjection,
  observeRuntimeProjectionAmount,
} from "@runtime/kernel/projection";
import {
  noteShouldRecomputeStackUsage,
  readRuntimeWalkerStackStats,
  STACK_TRIM_MIN_CAPACITY,
  trimWalkerStackToFloorIfSparse,
} from "../stackStats";
import { advance } from "./advance";
import { profilePullNode } from "../profile";

const stack: ReactiveEdge[] = [];
let high = 0;

/** Walk an Unknown dependency that is known to have committed inputs. */
export function pull_iterator(
  parentEdge: ReactiveEdge,
  node: ReactiveNode,
  edge: ReactiveEdge,
): boolean {
  // JIT: keep the captured stack base Int32 for index and range analysis.
  // `| 0` is type feedback, not a correctness guard; see pushIteratorCore.
  const base = high | 0;
  // @jit int32-provenance(base)
  let top = base;
  let changed = false;

  stack[top++] = parentEdge;

  {
    if (__DEV__) {
      noteShouldRecomputeStackUsage(top);
    }
  }

  try {
    // Invariant: top > base whenever `descend` runs. The parent edge is
    // pushed before the first iteration, descend only pushes, and unwind
    // resumes a sibling only while frames remain. `node` is therefore always
    // an intermediate dependency, never the policy root (parentEdge.to).
    traverse: while (true) {
      // Reentrant evidence: user code under an earlier sibling may have marked
      // a resumed parent Changed through another path. Inside the scan below
      // node.state can change only through advance(), so it is read again
      // only after advance(): a clean dependency runs no code, and a descent
      // enters a dependency whose state was just read without Changed.
      if ((node.state & Changed) !== 0) {
        {
          if (__PROFILE__) {
            profilePullNode("node.changed", node, top - base, top - base);
          }
        }
        changed = true;
      } else {
        // Scan dependencies forward until the current branch either proves a
        // change or exhausts its stable frontier.
        descend: while (true) {
          {
            if (__PROFILE__) {
              observeRuntimeProjection?.("projection.semantic.pull.edge.visit");
            }
          }

          const dep = edge.from;
          const state = dep.state;

          {
            if (__DEV__ && (state & Computing) !== 0) {
              throw new Error("Cycle detected while refreshing reactive graph");
            }
          }

          const dirty = state & Both;

          if (dirty !== 0) {
            const depChanged = (dirty & Changed) !== 0;

            if (!depChanged) {
              {
                if (__PROFILE__) {
                  observeRuntimeProjection?.(
                    "projection.semantic.pull.dependency.invalid",
                  );
                }
              }

              const firstIn = dep.firstIn;

              if (firstIn !== null) {
                {
                  if (__PROFILE__) {
                    observeRuntimeProjection?.(
                      "projection.semantic.pull.descend",
                    );
                    profilePullNode(
                      "dep.unknown.descend",
                      dep,
                      top - base + 1,
                      top - base,
                    );
                  }
                }

                stack[top++] = edge;

                {
                  if (__DEV__) {
                    noteShouldRecomputeStackUsage(top);
                  }
                }

                node = dep;
                edge = firstIn;
                continue descend;
              }
            }

            {
              if (__PROFILE__) {
                if (depChanged) {
                  observeRuntimeProjection?.(
                    "projection.semantic.pull.dependency.changed",
                  );
                }
                observeRuntimeProjection?.(
                  "projection.semantic.pull.advance.invoke",
                );
                profilePullNode(
                  depChanged
                    ? "dep.changed.advance"
                    : "dep.unknown.leaf.advance",
                  dep,
                  top - base + 1,
                  top - base,
                );
              }
            }

            /**
             * advance() may re-enter pull walking, so publish this
             * invocation's live continuation frontier before user code runs.
             */
            high = top;

            {
              if (__DEV__) {
                devAssertRefreshEdge(dep, edge);
              }
            }
            // @jit canonical-boolean
            if (advance(dep, edge) === true) {
              changed = true;
              break descend;
            }

            // A stable advance() may still have exposed reentrant evidence.
            if ((node.state & Changed) !== 0) {
              changed = true;
              break descend;
            }
          } else if (__PROFILE__) {
            {
              observeRuntimeProjection?.(
                "projection.semantic.pull.dependency.clean",
              );
              profilePullNode("dep.clean", dep, top - base + 1, top - base);
            }
          }

          // Read only after advance(): user code may have changed the topology.
          const sibling = edge.nextIn;
          if (sibling === null) {
            changed = false;
            break descend;
          }

          {
            if (__PROFILE__) {
              observeRuntimeProjection?.(
                "projection.semantic.pull.sibling.stable-scan",
              );
              profilePullNode(
                "sibling.stable",
                sibling.from,
                top - base + 1,
                top - base,
              );
            }
          }

          edge = sibling;
        }
      }

      /** Bubble / stable-resume phase. */
      // Propagate the branch result toward the outer edge. Stable parents may
      // resume scanning at their next sibling.
      unwind: while (top !== base) {
        const parentEdge = stack[--top]!;
        stack[top] = null!;
        high = top;

        if (changed) {
          {
            if (__PROFILE__) {
              observeRuntimeProjection?.(
                "projection.semantic.pull.changed.bubble",
              );
              observeRuntimeProjection?.(
                "projection.semantic.pull.advance.invoke",
              );
              profilePullNode(
                "bubble.changed.advance",
                node,
                top - base + 1,
                top - base,
              );
            }
          }
          changed = advance(node, parentEdge);
        } else {
          node.state &= ~Unknown;
        }

        node = parentEdge.to;

        if (!changed && top !== base) {
          const sibling = parentEdge.nextIn;

          if (sibling !== null) {
            {
              if (__PROFILE__) {
                observeRuntimeProjection?.(
                  "projection.semantic.pull.sibling.stable-scan",
                );
                profilePullNode(
                  "sibling.after-stable-pop",
                  sibling.from,
                  top - base + 1,
                  top - base,
                );
              }
            }
            edge = sibling;
            continue traverse;
          }
        }
      }

      return changed;
    }
  } finally {
    while (top !== base) {
      stack[--top] = null!;
    }

    high = base;

    if (base === 0 && stack.length > STACK_TRIM_MIN_CAPACITY) {
      {
        if (__PROFILE__) {
          if (__PROFILE__)
            observeRuntimeProjection?.("projection.semantic.pull.stack.trim");
          if (__PROFILE__)
            observeRuntimeProjectionAmount?.(
              "projection.semantic.pull.stack.trim.excess",
              stack.length - STACK_TRIM_MIN_CAPACITY,
            );
        }
      }
      trimWalkerStackToFloorIfSparse(stack);
    }
  }
}

export function readShouldRecomputeStackStats(): {
  shouldRecompute: { current: number; peak: number; capacity: number };
  propagate: { current: number; peak: number; capacity: number };
} {
  return readRuntimeWalkerStackStats(high, stack.length, 0, 0);
}
