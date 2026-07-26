const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, "build", "generated", "opencodex-engine.mjs");

const BUN_MODULE_ALIASES = {
  "bun:ffi": "node-ffi.ts",
  "bun:jsc": "node-jsc.ts",
  "bun:sqlite": "node-sqlite.ts",
};

function bunModuleShimPlugin(projectRoot = PROJECT_ROOT) {
  return {
    name: "codepet-bun-module-aliases",
    setup(build) {
      build.onResolve({ filter: /^bun:(ffi|jsc|sqlite)$/ }, (args) => ({
        path: path.join(projectRoot, "src", "open-codex", "runtime", BUN_MODULE_ALIASES[args.path]),
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
    plugins: [bunModuleShimPlugin(projectRoot)],
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
