const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, "build", "generated", "opencodex-engine.mjs");

const BUN_MODULE_SHIMS = {
  "bun:ffi": `
    const unavailable = () => { throw new Error("OpenCodex capability unavailable: FFI"); };
    export const dlopen = unavailable;
    export const ptr = unavailable;
  `,
  "bun:jsc": `
    export function heapStats() {
      return { heapSize: 0, heapCapacity: 0, extraMemorySize: 0 };
    }
  `,
  "bun:sqlite": `
    export class Database {
      constructor() {
        throw new Error("OpenCodex capability unavailable: SQLite");
      }
    }
    export const constants = Object.freeze({});
  `,
};

function bunModuleShimPlugin() {
  return {
    name: "codepet-bun-module-shims",
    setup(build) {
      build.onResolve({ filter: /^bun:(ffi|jsc|sqlite)$/ }, (args) => ({
        path: args.path,
        namespace: "codepet-bun-shim",
      }));
      build.onLoad({ filter: /.*/, namespace: "codepet-bun-shim" }, (args) => ({
        contents: BUN_MODULE_SHIMS[args.path],
        loader: "js",
      }));
    },
  };
}

async function buildEngine({
  projectRoot = PROJECT_ROOT,
  outputPath = path.join(projectRoot, "build", "generated", "opencodex-engine.mjs"),
} = {}) {
  const entryPoint = path.join(projectRoot, "src", "open-codex", "runtime", "engine-entry.ts");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await esbuild.build({
    absWorkingDir: projectRoot,
    banner: {
      js: 'import { createRequire as __codepetCreateRequire } from "node:module"; const require = __codepetCreateRequire(import.meta.url);',
    },
    bundle: true,
    entryPoints: [entryPoint],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    outfile: outputPath,
    platform: "node",
    plugins: [bunModuleShimPlugin()],
    sourcemap: false,
    splitting: false,
    target: "node24",
  });
  return {
    bytes: fs.statSync(outputPath).size,
    outputPath,
  };
}

async function main() {
  const result = await buildEngine();
  process.stdout.write(`OpenCodex engine built (${result.bytes} bytes): ${result.outputPath}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildEngine,
  bunModuleShimPlugin,
};
