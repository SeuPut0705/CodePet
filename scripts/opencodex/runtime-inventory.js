const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_VENDOR_DIR = path.join(PROJECT_ROOT, "vendor", "opencodex");
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, "docs", "opencodex-runtime-inventory.json");
const CAPABILITY_PATTERNS = [
  ["Bun.CryptoHasher", /\bBun\.CryptoHasher\b/],
  ["Bun.Image", /\bBun\.Image\b/],
  ["Bun.file", /\bBun\.file\s*\(/],
  ["Bun.hash", /\bBun\.hash\s*\(/],
  ["Bun.inspect", /\bBun\.inspect\b/],
  ["Bun.revision", /\bBun\.revision\b/],
  ["Bun.serve", /\bBun\.serve\b/],
  ["Bun.sleep", /\bBun\.sleep\s*\(/],
  ["Bun.sleepSync", /\bBun\.sleepSync\s*\(/],
  ["Bun.spawn", /\bBun\.spawn\s*\(/],
  ["Bun.spawnSync", /\bBun\.spawnSync\s*\(/],
  ["Bun.version", /\bBun\.version\b/],
  ["bun:ffi", /["']bun:ffi["']/],
  ["bun:jsc", /["']bun:jsc["']/],
  ["bun:sqlite", /["']bun:sqlite["']/],
  ["import.meta.dir", /\bimport\.meta\.dir\b/],
  ["import.meta.dirname", /\bimport\.meta\.dirname\b/],
];

function listTypeScriptFiles(rootDir, relativeDir = "src") {
  const directory = path.join(rootDir, ...relativeDir.split("/"));
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(rootDir, relativePath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relativePath);
  }
  return files.sort();
}

function scanRuntimeDependencies({ vendorDir = DEFAULT_VENDOR_DIR } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, "UPSTREAM.json"), "utf8"));
  const occurrences = new Map(CAPABILITY_PATTERNS.map(([name]) => [name, []]));
  for (const relativePath of listTypeScriptFiles(vendorDir)) {
    const lines = fs.readFileSync(path.join(vendorDir, ...relativePath.split("/")), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const [name, pattern] of CAPABILITY_PATTERNS) {
        if (pattern.test(line)) occurrences.get(name).push({ file: relativePath, line: index + 1 });
      }
    });
  }
  const capabilities = [...occurrences.entries()]
    .filter(([, evidence]) => evidence.length > 0)
    .map(([name, evidence]) => ({ name, occurrences: evidence }));
  return {
    schemaVersion: 1,
    upstreamCommit: manifest.commit,
    summary: {
      capabilities: capabilities.length,
      occurrences: capabilities.reduce((sum, entry) => sum + entry.occurrences.length, 0),
    },
    capabilities,
  };
}

function writeRuntimeInventory({
  vendorDir = DEFAULT_VENDOR_DIR,
  outputPath = DEFAULT_OUTPUT_PATH,
} = {}) {
  const inventory = scanRuntimeDependencies({ vendorDir });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
  return inventory;
}

function main() {
  const inventory = writeRuntimeInventory();
  process.stdout.write(
    `OpenCodex runtime inventory generated (${inventory.summary.capabilities} capabilities, ${inventory.summary.occurrences} occurrences)\n`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  scanRuntimeDependencies,
  writeRuntimeInventory,
};
