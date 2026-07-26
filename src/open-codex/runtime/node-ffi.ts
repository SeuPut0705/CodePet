class OpenCodexFfiCapabilityError extends Error {
  readonly capability = "bun-ffi";
  readonly code = "OPENCODEX_CAPABILITY_UNAVAILABLE";

  constructor() {
    super("OpenCodex capability unavailable: bun-ffi");
    this.name = "OpenCodexCapabilityError";
  }
}

export function dlopen(_library: string, _symbols: unknown): never {
  throw new OpenCodexFfiCapabilityError();
}

export function ptr<T extends ArrayBuffer | ArrayBufferView>(buffer: T): T {
  return buffer;
}

export type Pointer = ArrayBuffer | ArrayBufferView;
