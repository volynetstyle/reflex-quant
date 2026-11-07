const globalScope = globalThis as typeof globalThis & {
  __DEV__?: boolean;
};

globalScope.__DEV__ = true;

export {};
