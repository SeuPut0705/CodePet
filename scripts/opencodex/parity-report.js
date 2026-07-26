const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_VENDOR_DIR = path.join(PROJECT_ROOT, "vendor", "opencodex");
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, "docs", "opencodex-parity.json");
const CATEGORY_ROOTS = {
  providers: ["src/providers"],
  adapters: ["src/adapters"],
  oauth: ["src/oauth"],
  transports: ["src/responses", "src/server"],
  codexIntegration: ["src/codex"],
  claudeIntegration: ["src/claude"],
  usage: ["src/usage"],
  management: ["src/server/management"],
  cliRuntime: ["src/cli"],
};
const GENERIC_TOKENS = new Set([
  "adapter",
  "api",
  "base",
  "client",
  "config",
  "control",
  "error",
  "events",
  "helpers",
  "index",
  "manager",
  "models",
  "provider",
  "routes",
  "server",
  "state",
  "store",
  "types",
]);
const CONTRACT_EVIDENCE = Object.freeze({
  "transports:server/index": [
    "scripts/opencodex/engine-smoke.js",
    "test/open-codex-engine-smoke.test.js",
  ],
  "transports:server/lifecycle": [
    "scripts/opencodex/engine-smoke.js",
    "test/open-codex-engine-host.test.js",
    "test/open-codex-engine-smoke.test.js",
  ],
});

function listFiles(rootDir, relativeDir, extension) {
  const absoluteDir = path.join(rootDir, ...relativeDir.split("/"));
  if (!fs.existsSync(absoluteDir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) results.push(...listFiles(rootDir, relativePath, extension));
    else if (entry.isFile() && relativePath.endsWith(extension)) results.push(relativePath);
  }
  return results.sort();
}

function codePetEvidenceFiles(codePetRoot) {
  return [
    ...listFiles(codePetRoot, "src", ".js"),
    ...listFiles(codePetRoot, "test", ".js"),
  ].sort();
}

function evidenceTokens(upstreamPath) {
  return path.basename(upstreamPath, path.extname(upstreamPath))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !GENERIC_TOKENS.has(token));
}

function matchingCodePetEvidence(upstreamPath, candidates) {
  const tokens = evidenceTokens(upstreamPath);
  if (tokens.length === 0) return [];
  return candidates.filter((candidate) => {
    const baseName = path.basename(candidate).toLowerCase();
    return tokens.some((token) => baseName.includes(token));
  });
}

function entryId(categoryName, upstreamPath) {
  return `${categoryName}:${upstreamPath.replace(/^src\//, "").replace(/\.ts$/, "")}`;
}

function buildCategory({ categoryName, roots, vendorDir, candidates }) {
  const upstreamFiles = [...new Set(roots.flatMap((root) => listFiles(vendorDir, root, ".ts")))].sort();
  return upstreamFiles.map((upstreamPath) => {
    const id = entryId(categoryName, upstreamPath);
    const contractEvidence = CONTRACT_EVIDENCE[id] || [];
    return {
      id,
      status: contractEvidence.length > 0 ? "contract-tested" : "imported",
      upstreamEvidence: [upstreamPath],
      codePetEvidence: [...new Set([
        ...matchingCodePetEvidence(upstreamPath, candidates),
        ...contractEvidence,
      ])].sort(),
    };
  });
}

function buildParityReport({ vendorDir = DEFAULT_VENDOR_DIR, codePetRoot = PROJECT_ROOT } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, "UPSTREAM.json"), "utf8"));
  const candidates = codePetEvidenceFiles(codePetRoot);
  const categories = {};
  for (const [categoryName, roots] of Object.entries(CATEGORY_ROOTS)) {
    categories[categoryName] = buildCategory({
      categoryName,
      roots,
      vendorDir,
      candidates,
    });
  }
  const entries = Object.values(categories).flat();
  const total = entries.length;
  const contractTested = entries.filter((entry) => entry.status === "contract-tested").length;
  return {
    schemaVersion: 1,
    upstream: {
      repository: manifest.repository,
      tag: manifest.tag,
      commit: manifest.commit,
      tree: manifest.tree,
    },
    summary: {
      total,
      statusCounts: {
        imported: total - contractTested,
        "contract-tested": contractTested,
        "runtime-verified": 0,
      },
    },
    categories,
  };
}

function writeParityReport({
  vendorDir = DEFAULT_VENDOR_DIR,
  codePetRoot = PROJECT_ROOT,
  outputPath = DEFAULT_OUTPUT_PATH,
} = {}) {
  const report = buildParityReport({ vendorDir, codePetRoot });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function main() {
  const report = writeParityReport();
  process.stdout.write(
    `OpenCodex parity baseline generated (${report.summary.total} capabilities)\n`
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
  buildParityReport,
  writeParityReport,
};
