import { spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash, type BinaryLike } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { inspect as nodeInspect } from "node:util";

type HashInput = string | ArrayBuffer | ArrayBufferView;

interface BunSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: "ignore" | "inherit" | "pipe";
  stdout?: "ignore" | "inherit" | "pipe";
  stderr?: "ignore" | "inherit" | "pipe";
  timeout?: number;
  windowsHide?: boolean;
}

interface BunSpawnResult {
  success: boolean;
  exitCode: number | null;
  exitedDueToTimeout: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export class OpenCodexCapabilityError extends Error {
  readonly capability: string;
  readonly code = "OPENCODEX_CAPABILITY_UNAVAILABLE";

  constructor(capability: string) {
    super(`OpenCodex capability unavailable: ${capability}`);
    this.name = "OpenCodexCapabilityError";
    this.capability = capability;
  }
}

class UnsupportedBunImage {
  constructor(_input: unknown) {
    throw new OpenCodexCapabilityError("bun-image");
  }
}

class NodeCryptoHasher {
  private readonly hash;

  constructor(algorithm: string) {
    this.hash = createHash(algorithm);
  }

  update(input: BinaryLike): this {
    this.hash.update(input);
    return this;
  }

  digest(encoding?: BufferEncoding): Buffer | string {
    return encoding ? this.hash.digest(encoding) : this.hash.digest();
  }
}

function bytesForHash(input: HashInput): Uint8Array {
  if (typeof input === "string") return Buffer.from(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(input);
}

function deterministicHash(input: HashInput): bigint {
  return createHash("sha256").update(bytesForHash(input)).digest().readBigUInt64BE(0);
}

function file(filePath: string): Blob & { exists(): Promise<boolean> } {
  const blob = new Blob([readFileSync(filePath)]);
  return Object.assign(blob, {
    exists: async () => existsSync(filePath),
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function sleepSync(milliseconds: number): void {
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(state, 0, 0, Math.max(0, milliseconds));
}

function spawnSync(command: string[], options: BunSpawnOptions = {}): BunSpawnResult {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new TypeError("Bun.spawnSync requires a non-empty string command array");
  }
  const result = nodeSpawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: [options.stdin ?? "pipe", options.stdout ?? "pipe", options.stderr ?? "pipe"],
    timeout: options.timeout,
    windowsHide: options.windowsHide,
  });
  return {
    success: result.status === 0 && !result.error,
    exitCode: result.status,
    exitedDueToTimeout: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout instanceof Uint8Array ? result.stdout : new Uint8Array(),
    stderr: result.stderr instanceof Uint8Array ? result.stderr : new Uint8Array(),
  };
}

export interface BunCompatibility {
  CryptoHasher: typeof NodeCryptoHasher;
  Image: typeof UnsupportedBunImage;
  file: typeof file;
  hash: typeof deterministicHash;
  inspect: typeof nodeInspect;
  revision: string;
  sleep: typeof sleep;
  sleepSync: typeof sleepSync;
  spawnSync: typeof spawnSync;
  version: string;
}

export function installBunCompatibility(): BunCompatibility {
  const compatibility: BunCompatibility = {
    CryptoHasher: NodeCryptoHasher,
    Image: UnsupportedBunImage,
    file,
    hash: deterministicHash,
    inspect: nodeInspect,
    revision: `node-${process.version}`,
    sleep,
    sleepSync,
    spawnSync,
    version: "0.0.0-codepet",
  };
  const globals = globalThis as typeof globalThis & { Bun?: Partial<BunCompatibility> };
  globals.Bun = Object.assign(globals.Bun ?? {}, compatibility);
  return globals.Bun as BunCompatibility;
}
