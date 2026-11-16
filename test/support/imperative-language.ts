export type Scalar = number | boolean | string | null | undefined;
export type IExpr =
  | { type: "value"; value: Scalar }
  | { type: "read" | "register" | "exists"; id: string }
  | { type: "add" | "equal" | "less"; left: IExpr; right: IExpr };
export type IBody = readonly Instruction[];
export type Instruction =
  | { type: "signal"; id: string; value: IExpr }
  | { type: "computed" | "effect"; id: string; body: IBody; cleanup?: IBody }
  | { type: "set" | "assign" | "log"; id: string; value: IExpr }
  | { type: "read" | "dispose" | "run"; id: string; into?: string }
  | { type: "if"; condition: IExpr; then: IBody; else: IBody }
  | { type: "batch" | "untracked"; body: IBody }
  | { type: "try"; body: IBody; error: string; catch: IBody }
  | { type: "return"; value: IExpr }
  | { type: "fail"; message: string }
  | { type: "flush" };

export const ix = {
  value: (value: Scalar): IExpr => ({ type: "value", value }),
  read: (id: string): IExpr => ({ type: "read", id }),
  register: (id: string): IExpr => ({ type: "register", id }),
  exists: (id: string): IExpr => ({ type: "exists", id }),
  add: (left: IExpr, right: IExpr): IExpr => ({ type: "add", left, right }),
  equal: (left: IExpr, right: IExpr): IExpr => ({ type: "equal", left, right }),
  less: (left: IExpr, right: IExpr): IExpr => ({ type: "less", left, right }),
};
export const ins = {
  signal: (id: string, value: Scalar): Instruction => ({
    type: "signal",
    id,
    value: ix.value(value),
  }),
  computed: (id: string, body: IBody): Instruction => ({
    type: "computed",
    id,
    body,
  }),
  effect: (id: string, body: IBody, cleanup?: IBody): Instruction => ({
    type: "effect",
    id,
    body,
    ...(cleanup === undefined ? {} : { cleanup }),
  }),
  set: (id: string, value: IExpr): Instruction => ({ type: "set", id, value }),
  assign: (id: string, value: IExpr): Instruction => ({
    type: "assign",
    id,
    value,
  }),
  log: (id: string, value: IExpr): Instruction => ({ type: "log", id, value }),
  read: (id: string, into?: string): Instruction => ({
    type: "read",
    id,
    ...(into === undefined ? {} : { into }),
  }),
  dispose: (id: string): Instruction => ({ type: "dispose", id }),
  run: (id: string): Instruction => ({ type: "run", id }),
  when: (
    condition: IExpr,
    then: IBody,
    otherwise: IBody = [],
  ): Instruction => ({ type: "if", condition, then, else: otherwise }),
  batch: (body: IBody): Instruction => ({ type: "batch", body }),
  untracked: (body: IBody): Instruction => ({ type: "untracked", body }),
  attempt: (body: IBody, error: string, handler: IBody = []): Instruction => ({
    type: "try",
    body,
    error,
    catch: handler,
  }),
  ret: (value: IExpr): Instruction => ({ type: "return", value }),
  fail: (message: string): Instruction => ({ type: "fail", message }),
  flush: (): Instruction => ({ type: "flush" }),
};

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}
class Returned {
  constructor(readonly value: Scalar) {}
}
export interface ImperativePort<N> {
  signal(value: Scalar): N;
  computed(fn: () => Scalar): N;
  effect(fn: () => void | (() => void)): N;
  read(node: N): Scalar;
  write(node: N, value: Scalar): void;
  dispose(node: N): void;
  run(node: N): void;
  flush(): void;
  batch<T>(fn: () => T): T;
  untracked<T>(fn: () => T): T;
}
export interface IObservation {
  value?: Scalar;
  error?: { name: string; message: string };
  events: readonly unknown[];
}

/** Shared only for language semantics; the two reactive/host machines are separate. */
export class ImperativeMachine<N> {
  domainViolation: string | undefined;
  readonly handles = new Map<
    string,
    {
      kind: "signal" | "computed" | "effect";
      node: N;
      body?: IBody;
      cleanup?: IBody;
    }
  >();
  readonly registers = new Map<string, Scalar>();
  private events: unknown[] = [];
  private fuel = 0;
  constructor(
    readonly port: ImperativePort<N>,
    readonly maxSteps = 200_000,
  ) {}
  private handle(id: string) {
    const handle = this.handles.get(id);
    if (handle === undefined) throw new DomainError(`unknown handle ${id}`);
    return handle;
  }
  private expression(expr: IExpr): Scalar {
    if (--this.fuel < 0) throw new DomainError("execution fuel exhausted");
    switch (expr.type) {
      case "value":
        return expr.value;
      case "read":
        return this.port.read(this.handle(expr.id).node);
      case "register":
        return this.registers.get(expr.id);
      case "exists":
        return this.handles.has(expr.id);
      case "add":
        return (
          Number(this.expression(expr.left)) +
          Number(this.expression(expr.right))
        );
      case "equal":
        return Object.is(
          this.expression(expr.left),
          this.expression(expr.right),
        );
      case "less":
        return (
          Number(this.expression(expr.left)) <
          Number(this.expression(expr.right))
        );
    }
  }
  private callback(id: string, body: IBody, phase: string): Scalar {
    this.events.push({ id, phase });
    try {
      this.block(body);
      return undefined;
    } catch (error) {
      if (error instanceof Returned) return error.value;
      if (error instanceof DomainError) this.domainViolation = error.message;
      throw error;
    }
  }
  private block(body: IBody): void {
    for (const instruction of body) this.step(instruction);
  }
  private step(op: Instruction): Scalar {
    if (--this.fuel < 0) throw new DomainError("execution fuel exhausted");
    switch (op.type) {
      case "signal": {
        if (this.handles.has(op.id))
          throw new DomainError(`duplicate ${op.id}`);
        const node = this.port.signal(this.expression(op.value));
        this.handles.set(op.id, { kind: "signal", node });
        return;
      }
      case "computed":
      case "effect": {
        if (this.handles.has(op.id))
          throw new DomainError(`duplicate ${op.id}`);
        const body = () => this.callback(op.id, op.body, "run");
        const node =
          op.type === "computed"
            ? this.port.computed(body)
            : this.port.effect(() => {
                body();
                return op.cleanup === undefined
                  ? undefined
                  : () => {
                      this.callback(op.id, op.cleanup!, "cleanup");
                    };
              });
        this.handles.set(op.id, {
          kind: op.type,
          node,
          body: op.body,
          ...(op.cleanup === undefined ? {} : { cleanup: op.cleanup }),
        });
        return;
      }
      case "set":
        this.port.write(this.handle(op.id).node, this.expression(op.value));
        return;
      case "assign":
        this.registers.set(op.id, this.expression(op.value));
        return;
      case "log":
        this.events.push({ log: op.id, value: this.expression(op.value) });
        return;
      case "read": {
        const value = this.port.read(this.handle(op.id).node);
        if (op.into !== undefined) this.registers.set(op.into, value);
        return value;
      }
      case "dispose":
        this.port.dispose(this.handle(op.id).node);
        return;
      case "run":
        this.port.run(this.handle(op.id).node);
        return;
      case "flush":
        this.port.flush();
        return;
      case "if":
        this.block(this.expression(op.condition) ? op.then : op.else);
        return;
      case "batch":
        this.port.batch(() => this.block(op.body));
        return;
      case "untracked":
        this.port.untracked(() => this.block(op.body));
        return;
      case "try":
        try {
          this.block(op.body);
        } catch (error) {
          if (error instanceof Returned || error instanceof DomainError)
            throw error;
          this.registers.set(
            op.error,
            error instanceof Error ? error.message : String(error),
          );
          this.block(op.catch);
        }
        return;
      case "fail":
        throw new Error(op.message);
      case "return":
        throw new Returned(this.expression(op.value));
    }
  }
  execute(op: Instruction): IObservation {
    this.events = [];
    this.fuel = this.maxSteps;
    try {
      const value = this.step(op);
      return { value, events: this.events };
    } catch (error) {
      if (error instanceof DomainError) {
        this.domainViolation = error.message;
        throw error;
      }
      if (error instanceof Returned) throw error;
      return {
        error: {
          name: error instanceof Error ? error.name : "ThrownValue",
          message: error instanceof Error ? error.message : String(error),
        },
        events: this.events,
      };
    }
  }
  programState() {
    return {
      registers: [...this.registers].sort(([a], [b]) => a.localeCompare(b)),
      definitions: [...this.handles].map(([id, handle]) => ({
        id,
        kind: handle.kind,
        body: handle.body,
        cleanup: handle.cleanup,
      })),
    };
  }
}
