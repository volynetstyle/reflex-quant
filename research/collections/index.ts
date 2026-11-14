// Research prototype: a separate local collection machine over Quant's public API.
import { batch, get, signal, set, untracked } from "../../src/index";
import type { Readable, Signal } from "../../src/index";

export type Key = string | number | bigint;
export type Frozen<T> = T extends object
  ? { readonly [P in keyof T]: Frozen<T[P]> }
  : T;
export interface Change<K, V> {
  readonly key: K;
  readonly before: Frozen<V> | undefined;
  readonly after: Frozen<V> | undefined;
}
export interface Commit<C> {
  readonly revision: number;
  readonly changes: readonly C[];
}
export interface IndexChange<K, Q, V> {
  readonly type: "remove" | "insert";
  readonly key: Q;
  readonly rowKey: K;
  readonly value: Frozen<V>;
}
export interface Stats {
  quantNodes: number;
  operators: number;
  indexesBuilt: number;
  predicateCalls: number;
  keyCalls: number;
  sumCalls: number;
  indexProbes: number;
  storeReads: number;
  stagedWrites: number;
  commits: number;
  rejected: number;
  publications: number;
}
export interface View<K extends Key, V> {
  readonly size: Readable<number>;
  readonly revision: Readable<number>;
  get(key: K): Frozen<V> | undefined;
  snapshot(): readonly (readonly [K, Frozen<V>])[];
  observeChanges(fn: (commit: Commit<Change<K, V>>) => void): () => void;
  count(): Readable<number>;
  filter(predicate: (row: Frozen<V>) => boolean): View<K, V>;
  indexBy<Q extends Key>(
    key: (row: Frozen<V>) => Q,
    options: { readonly kind: "unique" | "multi" },
  ): Index<K, Q, V>;
  groupBy<Q extends Key>(key: (row: Frozen<V>) => Q): Grouped<K, Q, V>;
}
export interface Table<K extends Key, V extends object> extends View<K, V> {
  insert(row: V): void;
  remove(key: K): boolean;
  patch(key: K, fields: Partial<V>): void;
}
export interface Index<K extends Key, Q extends Key, V> {
  readonly kind: "unique" | "multi";
  readonly size: Readable<number>;
  readonly revision: Readable<number>;
  readonly stats: Readonly<{ builds: number; keyCalls: number }>;
  lookup(key: Q): readonly Frozen<V>[];
  bucketSize(key: Q): number;
  observeChanges(
    fn: (commit: Commit<IndexChange<K, Q, V>>) => void,
  ): () => void;
}
export interface Grouped<K extends Key, Q extends Key, V> extends Index<
  K,
  Q,
  V
> {
  count(): View<Q, number>;
  sumBigInt(value: (row: Frozen<V>) => bigint): View<Q, bigint>;
}
export interface Collections {
  readonly stats: Readonly<Stats>;
  table<K extends Key, V extends object>(options: {
    key: (row: Frozen<V>) => K;
    rows?: Iterable<V>;
  }): Table<K, V>;
  dispose(): void;
}

type Store = Map<Key, unknown>;
interface Delta {
  key: Key;
  before: unknown;
  after: unknown;
  oldGroup?: Key;
  newGroup?: Key;
}
type Observer = (commit: Commit<unknown>) => void;
type Derive = (tx: Transaction, changes: readonly Delta[]) => Delta[];
const identity = (value: unknown): unknown => value;
const bucketCount = (value: unknown): unknown =>
  value === undefined ? undefined : (value as Store).size;

function validKey(value: unknown): Key {
  if (
    typeof value === "string" ||
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  throw new TypeError("Keys must be strings, bigints or finite numbers");
}

// Own data-property trees only. Freeze does not make Map/Date internals immutable.
function ownValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (
    value === null ||
    value === undefined ||
    ["string", "number", "boolean", "bigint"].includes(typeof value)
  )
    return value;
  if (typeof value !== "object")
    throw new TypeError("Rows contain only plain data");
  const proto: unknown = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array && proto !== Array.prototype)
    throw new TypeError("Exotic arrays are not row data");
  if (!array && proto !== Object.prototype && proto !== null)
    throw new TypeError("Exotic objects are not row data");
  if (ancestors.has(value)) throw new TypeError("Cyclic rows are unsupported");
  ancestors.add(value);
  const copy: object = array
    ? []
    : (Object.create(proto as object | null) as object);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string")
      throw new TypeError("Symbol row fields are unsupported");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor))
      throw new TypeError("Accessors are not row data");
    if (array && key === "length") continue;
    if (!descriptor.enumerable)
      throw new TypeError("Row fields must be enumerable");
    if (array && !/^(0|[1-9]\d*)$/.test(key))
      throw new TypeError("Arrays have indexed data only");
    Object.defineProperty(copy, key, {
      value: ownValue(descriptor.value, ancestors),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (array) (copy as unknown[]).length = (value as unknown[]).length;
  ancestors.delete(value);
  return Object.freeze(copy);
}

function ownRow<T extends object>(value: T): Frozen<T> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("A row must be a plain record");
  return ownValue(value) as Frozen<T>;
}

class Transaction {
  readonly writes = new Map<Store, Store>();
  readonly sizes = new Map<Store, number>();
  readonly changes = new Map<Operator, Delta[]>();
  readonly queue: { node: Operator; changes: readonly Delta[] }[] = [];
  constructor(readonly engine: Engine) {}
  read(store: Store, key: Key): unknown {
    this.engine.counters.storeReads++;
    const writes = this.writes.get(store);
    return writes?.has(key) ? writes.get(key) : store.get(key);
  }
  write(store: Store, key: Key, value: unknown): void {
    const previous = this.read(store, key);
    if (Object.is(previous, value)) return;
    let writes = this.writes.get(store);
    if (!writes) {
      writes = new Map();
      this.writes.set(store, writes);
    }
    writes.set(key, value);
    this.sizes.set(
      store,
      (this.sizes.get(store) ?? store.size) +
        Number(value !== undefined) -
        Number(previous !== undefined),
    );
    this.engine.counters.stagedWrites++;
  }
  size(store: Store): number {
    return this.sizes.get(store) ?? store.size;
  }
  emit(node: Operator, changes: Delta[]): void {
    if (!changes.length) return;
    this.changes.set(node, changes);
    for (const child of node.children)
      this.queue.push({ node: child, changes });
  }
  commit(): void {
    for (const [store, writes] of this.writes)
      for (const [key, value] of writes) {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      }
  }
}

class Operator {
  readonly children = new Set<Operator>();
  readonly observers = new Set<Observer>();
  readonly version: Signal<number>;
  readonly size: Signal<number>;
  constructor(
    readonly engine: Engine,
    readonly data: Store,
    readonly derive: Derive,
    readonly project: (value: unknown) => unknown = identity,
  ) {
    this.version = signal(0);
    this.size = signal(data.size);
    engine.counters.quantNodes += 2;
    engine.counters.operators++;
    engine.nodes.push(this);
  }
  events(changes: readonly Delta[]): readonly unknown[] {
    return Object.freeze(
      changes.map(({ key, before, after }) =>
        Object.freeze({ key, before, after }),
      ),
    );
  }
}

class Engine {
  readonly counters: Stats = {
    quantNodes: 0,
    operators: 0,
    indexesBuilt: 0,
    predicateCalls: 0,
    keyCalls: 0,
    sumCalls: 0,
    indexProbes: 0,
    storeReads: 0,
    stagedWrites: 0,
    commits: 0,
    rejected: 0,
    publications: 0,
  };
  readonly nodes: Operator[] = [];
  phase: "idle" | "preparing" | "publishing" | "closed" = "idle";
  revision = 0;
  open(): void {
    if (this.phase === "closed")
      throw new Error("Collections engine is disposed");
  }
  idle(): void {
    this.open();
    if (this.phase !== "idle")
      throw new Error("Reentrant collection mutation or construction");
  }
  build<T>(fn: () => T): T {
    this.idle();
    this.phase = "preparing";
    try {
      return untracked(fn);
    } finally {
      this.phase = "idle";
    }
  }
  mutate(source: Operator, prepare: (tx: Transaction) => Delta[]): boolean {
    this.idle();
    if (this.revision === Number.MAX_SAFE_INTEGER)
      throw new Error("Collection revision exhausted");
    this.phase = "preparing";
    try {
      const tx = new Transaction(this);
      try {
        untracked(() => {
          tx.emit(source, prepare(tx));
          for (let i = 0; i < tx.queue.length; i++) {
            const { node, changes } = tx.queue[i]!;
            tx.emit(node, node.derive(tx, changes));
          }
        });
      } catch (error) {
        this.counters.rejected++;
        throw error;
      }
      if (!tx.changes.size) return false;
      tx.commit();
      this.revision++;
      this.counters.commits++;
      this.phase = "publishing";
      const deliveries = [...tx.changes].map(([node, changes]) => ({
        node,
        observers: [...node.observers],
        commit: Object.freeze({
          revision: this.revision,
          changes: node.events(changes),
        }),
      }));
      batch(() => {
        // All physical stores are committed before the first scalar is set.
        for (const { node } of deliveries) {
          set(node.size, node.data.size);
          set(node.version, this.revision);
          this.counters.publications++;
        }
        let failed = false,
          first: unknown;
        for (const { observers, commit } of deliveries)
          for (const observer of observers) {
            try {
              untracked(() => observer(commit));
            } catch (error) {
              if (!failed) first = error;
              failed = true;
            }
          }
        // Quant's F5 also preserves this first error if a deferred effect fails.
        if (failed) throw first;
      });
      return true;
    } finally {
      this.phase = "idle";
    }
  }
  close(): void {
    this.idle();
    this.phase = "closed";
    for (const node of this.nodes) {
      node.data.clear();
      node.children.clear();
      node.observers.clear();
    }
    this.nodes.length = 0;
  }
}

function observe(node: Operator, fn: Observer): () => void {
  node.engine.open();
  node.observers.add(fn);
  return () => {
    node.observers.delete(fn);
  };
}

function view<K extends Key, V>(node: Operator): View<K, V> {
  return Object.freeze({
    size: node.size as Readable<number>,
    revision: node.version as Readable<number>,
    get(key: K): Frozen<V> | undefined {
      node.engine.open();
      get(node.version);
      return node.project(node.data.get(validKey(key))) as
        Frozen<V> | undefined;
    },
    snapshot(): readonly (readonly [K, Frozen<V>])[] {
      node.engine.open();
      get(node.version);
      return Object.freeze(
        [...node.data].map(([key, value]) =>
          Object.freeze([key as K, node.project(value) as Frozen<V>] as const),
        ),
      );
    },
    observeChanges(fn: (commit: Commit<Change<K, V>>) => void): () => void {
      return observe(node, fn as Observer);
    },
    count(): Readable<number> {
      return node.size;
    },
    filter(predicate: (row: Frozen<V>) => boolean): View<K, V> {
      return node.engine.build(() => {
        const test = (row: unknown): boolean => {
          node.engine.counters.predicateCalls++;
          return !!predicate(row as Frozen<V>);
        };
        const data: Store = new Map();
        for (const [key, raw] of node.data) {
          const row = node.project(raw);
          if (test(row)) data.set(key, row);
        }
        const filtered = new Operator(node.engine, data, (tx, changes) => {
          const output: Delta[] = [];
          for (const d of changes) {
            const before = tx.read(data, d.key),
              after =
                d.after !== undefined && test(d.after) ? d.after : undefined;
            tx.write(data, d.key, after);
            if (!Object.is(before, after))
              output.push({ key: d.key, before, after });
          }
          return output;
        });
        node.children.add(filtered);
        return view<K, V>(filtered);
      });
    },
    indexBy<Q extends Key>(
      key: (row: Frozen<V>) => Q,
      options: { readonly kind: "unique" | "multi" },
    ): Index<K, Q, V> {
      return makeIndex<K, Q, V>(node, key, options.kind);
    },
    groupBy<Q extends Key>(key: (row: Frozen<V>) => Q): Grouped<K, Q, V> {
      return makeIndex<K, Q, V>(node, key, "multi");
    },
  });
}

class IndexOperator extends Operator {
  keyCalls = 0;
  constructor(
    readonly parent: Operator,
    readonly selector: (row: unknown) => Key,
    readonly kind: "unique" | "multi",
    data: Store,
  ) {
    super(parent.engine, data, (tx, changes) => this.maintain(tx, changes));
    parent.engine.counters.indexesBuilt++;
  }
  bucket(tx: Transaction, key: Key): Store | undefined {
    this.engine.counters.indexProbes++;
    return tx.read(this.data, key) as Store | undefined;
  }
  key(row: unknown): Key {
    this.keyCalls++;
    this.engine.counters.keyCalls++;
    return validKey(this.selector(row));
  }
  maintain(tx: Transaction, changes: readonly Delta[]): Delta[] {
    const result: Delta[] = [];
    const prior = changes.map((d) =>
      d.before === undefined ? undefined : this.key(d.before),
    );
    // Retract all old membership before checking new unique-key collisions.
    for (const [i, d] of changes.entries())
      if (d.before !== undefined) {
        const group = prior[i]!;
        const bucket = this.bucket(tx, group)!;
        tx.write(bucket, d.key, undefined);
        if (tx.size(bucket) === 0) tx.write(this.data, group, undefined);
      }
    for (const [i, d] of changes.entries()) {
      const oldGroup = prior[i];
      let newGroup: Key | undefined;
      if (d.after !== undefined) {
        newGroup = this.key(d.after);
        let bucket = this.bucket(tx, newGroup);
        if (!bucket) {
          bucket = new Map();
          tx.write(this.data, newGroup, bucket);
        }
        if (this.kind === "unique" && tx.size(bucket) !== 0)
          throw new Error("Unique index conflict");
        tx.write(bucket, d.key, d.after);
      }
      const output: Delta = { key: d.key, before: d.before, after: d.after };
      if (oldGroup !== undefined) output.oldGroup = oldGroup;
      if (newGroup !== undefined) output.newGroup = newGroup;
      result.push(output);
    }
    return result;
  }
  override events(changes: readonly Delta[]): readonly unknown[] {
    const result: unknown[] = [];
    for (const d of changes) {
      if (d.before !== undefined)
        result.push(
          Object.freeze({
            type: "remove",
            key: d.oldGroup,
            rowKey: d.key,
            value: d.before,
          }),
        );
      if (d.after !== undefined)
        result.push(
          Object.freeze({
            type: "insert",
            key: d.newGroup,
            rowKey: d.key,
            value: d.after,
          }),
        );
    }
    return Object.freeze(result);
  }
}

function aggregate<Q extends Key>(
  index: IndexOperator,
  select?: (row: unknown) => bigint,
): View<Q, number | bigint> {
  return index.engine.build(() => {
    // Counts are a virtual view of bucket sizes; no duplicate group-count map.
    const data: Store = select ? new Map() : index.data;
    const project = (row: unknown): bigint => {
      index.engine.counters.sumCalls++;
      const value = select!(row);
      if (typeof value !== "bigint")
        throw new TypeError("sumBigInt requires bigint values");
      return value;
    };
    for (const [group, raw] of index.data) {
      const bucket = raw as Store;
      if (select) {
        let sum = 0n;
        for (const row of bucket.values()) {
          const value = project(row);
          sum += value;
        }
        data.set(group, sum);
      }
    }
    const result = new Operator(
      index.engine,
      data,
      (tx, changes) => {
        const groups = new Set<Key>();
        for (const d of changes) {
          if (d.oldGroup !== undefined) {
            groups.add(d.oldGroup);
            if (select) {
              tx.write(
                data,
                d.oldGroup,
                (tx.read(data, d.oldGroup) as bigint) - project(d.before),
              );
            }
          }
          if (d.newGroup !== undefined) {
            groups.add(d.newGroup);
            if (select) {
              const value = project(d.after);
              tx.write(
                data,
                d.newGroup,
                ((tx.read(data, d.newGroup) as bigint | undefined) ?? 0n) +
                  value,
              );
            }
          }
        }
        const output: Delta[] = [];
        for (const group of groups) {
          const bucket = index.bucket(tx, group);
          const after = !bucket
            ? undefined
            : select
              ? tx.read(data, group)
              : tx.size(bucket);
          const before = select
            ? data.get(group)
            : bucketCount(index.data.get(group));
          if (select) tx.write(data, group, after);
          if (!Object.is(before, after))
            output.push({ key: group, before, after });
        }
        return output;
      },
      select ? identity : bucketCount,
    );
    index.children.add(result);
    return view<Q, number | bigint>(result);
  });
}

function makeIndex<K extends Key, Q extends Key, V>(
  parent: Operator,
  selector: (row: Frozen<V>) => Q,
  kind: "unique" | "multi",
): Grouped<K, Q, V> {
  return parent.engine.build(() => {
    if (kind !== "unique" && kind !== "multi")
      throw new TypeError("Index cardinality must be unique or multi");
    const data: Store = new Map();
    let calls = 0;
    for (const [key, raw] of parent.data) {
      const row = parent.project(raw);
      calls++;
      parent.engine.counters.keyCalls++;
      const group = validKey(selector(row as Frozen<V>));
      let bucket = data.get(group) as Store | undefined;
      if (!bucket) {
        bucket = new Map();
        data.set(group, bucket);
      }
      if (kind === "unique" && bucket.size)
        throw new Error("Unique index conflict");
      bucket.set(key, row);
    }
    const index = new IndexOperator(
      parent,
      selector as (row: unknown) => Key,
      kind,
      data,
    );
    index.keyCalls = calls;
    parent.children.add(index);
    return Object.freeze({
      kind,
      size: index.size as Readable<number>,
      revision: index.version as Readable<number>,
      get stats(): Readonly<{ builds: number; keyCalls: number }> {
        return Object.freeze({ builds: 1, keyCalls: index.keyCalls });
      },
      lookup(key: Q): readonly Frozen<V>[] {
        parent.engine.open();
        get(index.version);
        parent.engine.counters.indexProbes++;
        return Object.freeze([
          ...((index.data.get(validKey(key)) as Store | undefined)?.values() ??
            []),
        ]) as readonly Frozen<V>[];
      },
      bucketSize(key: Q): number {
        parent.engine.open();
        get(index.version);
        parent.engine.counters.indexProbes++;
        return (index.data.get(validKey(key)) as Store | undefined)?.size ?? 0;
      },
      observeChanges(
        fn: (commit: Commit<IndexChange<K, Q, V>>) => void,
      ): () => void {
        return observe(index, fn as Observer);
      },
      count(): View<Q, number> {
        return aggregate<Q>(index) as View<Q, number>;
      },
      sumBigInt(fn: (row: Frozen<V>) => bigint): View<Q, bigint> {
        return aggregate<Q>(index, fn as (row: unknown) => bigint) as View<
          Q,
          bigint
        >;
      },
    });
  });
}

export function createCollections(): Collections {
  const engine = new Engine();
  return Object.freeze({
    get stats(): Readonly<Stats> {
      return Object.freeze({ ...engine.counters });
    },
    dispose(): void {
      engine.close();
    },
    table<K extends Key, V extends object>(options: {
      key: (row: Frozen<V>) => K;
      rows?: Iterable<V>;
    }): Table<K, V> {
      return engine.build(() => {
        const data: Store = new Map();
        const selectKey = options.key;
        const keyOf = (row: Frozen<V>): K => {
          engine.counters.keyCalls++;
          return validKey(selectKey(row)) as K;
        };
        for (const input of options.rows ?? []) {
          const row = ownRow(input),
            key = keyOf(row);
          if (data.has(key)) throw new Error("Duplicate primary key");
          data.set(key, row);
        }
        const source = new Operator(engine, data, () => []);
        return Object.freeze({
          ...view<K, V>(source),
          insert(input: V): void {
            engine.mutate(source, (tx) => {
              const row = ownRow(input),
                key = keyOf(row);
              if (tx.read(data, key) !== undefined)
                throw new Error("Duplicate primary key");
              tx.write(data, key, row);
              return [{ key, before: undefined, after: row }];
            });
          },
          remove(key: K): boolean {
            return engine.mutate(source, (tx) => {
              validKey(key);
              const before = tx.read(data, key);
              if (before === undefined) return [];
              tx.write(data, key, undefined);
              return [{ key, before, after: undefined }];
            });
          },
          patch(key: K, fields: Partial<V>): void {
            engine.mutate(source, (tx) => {
              validKey(key);
              const before = tx.read(data, key) as Frozen<V> | undefined;
              if (before === undefined) throw new Error("Missing primary key");
              const row = ownRow({ ...before, ...ownRow(fields) } as V),
                nextKey = keyOf(row);
              if (nextKey !== key && tx.read(data, nextKey) !== undefined)
                throw new Error("Duplicate primary key");
              if (nextKey !== key) {
                tx.write(data, key, undefined);
                tx.write(data, nextKey, row);
                return [
                  { key, before, after: undefined },
                  { key: nextKey, before: undefined, after: row },
                ];
              }
              tx.write(data, key, row);
              return [{ key, before, after: row }];
            });
          },
        });
      });
    },
  });
}
