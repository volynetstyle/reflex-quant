# Graph operations

This directory implements the adjacency lists shared by tracking, propagation,
and disposal. A `ReactiveEdge` connects a producer (`from`) to a consumer
(`to`): the same edge is in the producer's outgoing list and the consumer's
incoming list. See [graph invariants](../../../../docs/INVARIANTS.md) for the
contract and [read tracking](../../stages/tracking/README.md) for the decisions
that select these operations during a pass.

## Code map

| File             | Responsibility                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `findEdge.ts`    | Exact pair lookup: hint, outgoing head start, finger race and lockstep.                   |
| `hint.ts`        | Recognize an outgoing hint in the node's shared `tailIn` slot.                            |
| `tape.ts`        | Prepare one consumer's incoming list for direct lookup and, when covered, certify misses. |
| `linkEdge.ts`    | Link or unlink one pair; provide specialized links for tracking.                          |
| `reuseEdge.ts`   | The default read-tracking strategy; the resolver never calls it.                          |
| `cursorMoves.ts` | The two tracking moves: a suffix edge to the head or right after the cursor.              |
| `edgeList.ts`    | General incoming-list moves used by tests, benchmarks and graph tools.                    |
| `sweepEdges.ts`  | Unlink detached incoming sequences or all edges on one side of a node.                    |
| `disposeNode.ts` | Dispose a node by clearing its graph connections.                                         |
| `index.ts`       | The graph's internal exports.                                                             |

## Reading the names

`cursorEdge` is the last incoming edge accepted in the current tracking pass;
`null` means the pass has not accepted an edge yet. The edges after it form
the unvisited suffix. `expectedNextEdge` is the first edge in that suffix,
while `insertAfterEdge` is the position after which a reused or new edge is
placed. An `insertAfterEdge` of `null` means the head of the incoming list.

When moving an incoming edge, `previousIncomingEdge` and `nextIncomingEdge`
are its neighbors before the move; `nextEdgeAtInsertion` is the edge following
the insertion point. The outgoing list is not reordered by incoming moves.
Functions ending in `Unchecked` require the preconditions in their comments;
the caller is responsible for satisfying them.

The node's `tailIn` slot has different meanings depending on its state: a
tracking frontier while computing, otherwise a residual incoming edge or an
outgoing hint. `hint.ts` and the prepared tape both rely on this distinction.
The rules for retaining, replacing and clearing that slot are owned by
[INV-H and INV-P](../../../../docs/INVARIANTS.md#4-cursor-and-tracking-stamp).

In `tape.ts`, `lastStrikeConsumer` and `lastStrikePassStamp` identify the
last pass to strike; `preparedOwner` and `preparedPassStamp` identify the
recorded lease, which may have expired. `recordStrikeAndMaybePrepareTape`
records a first strike and attempts preparation from the second. A live lease
and `hasFullTapeCoverage` enable the absence certificate; a producer's lost
cell still requires an exact search.
