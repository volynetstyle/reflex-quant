import type ReactiveNode from "./node";

export interface ReactiveEdge {
  stamp: number;
  from: ReactiveNode;
  to: ReactiveNode;
  prevOut: ReactiveEdge | null;
  nextOut: ReactiveEdge | null;
  prevIn: ReactiveEdge | null;
  nextIn: ReactiveEdge | null;
}

export const createReactiveEdge = (
  stamp: number,
  from: ReactiveNode,
  to: ReactiveNode,
): ReactiveEdge => ({
  stamp,
  from,
  to,
  prevOut: null,
  nextOut: null,
  prevIn: null,
  nextIn: null,
}); // Order matters!
