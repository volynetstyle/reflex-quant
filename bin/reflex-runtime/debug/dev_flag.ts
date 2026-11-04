const globalScope = globalThis as typeof globalThis & {
  __DEV__?: boolean;
};

if (typeof globalScope.__DEV__ === "undefined") {
  globalScope.__DEV__ = false;
}

export {};
