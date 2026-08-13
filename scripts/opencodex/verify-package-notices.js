const fs = require("node:fs");
const path = require("node:path");

const { sha256File } = require("../../src/open-codex/upstream-provenance");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const NOTICE_MAPPINGS = [
  {
    from: "vendor/opencodex/FILES.sha256",
    to: "third-party/opencodex/FILES.sha256",
  },
  {
    from: "vendor/opencodex/LICENSE",
    to: "third-party/opencodex/LICENSE",
  },
  {
    from: "vendor/opencodex/UPSTREAM.json",
    to: "third-party/opencodex/UPSTREAM.json",
  },
];

function verifyPackageNotices({ projectRoot, buildConfig }) {
  const resources = Array.isArray(buildConfig?.extraResources) ? buildConfig.extraResources : [];
  const errors = [];
  const destinations = [];
  for (const expected of NOTICE_MAPPINGS) {
    const mapping = resources.find((resource) => resource && resource.from === expected.from);
    if (!mapping) {
      errors.push(`missing package notice mapping: ${expected.from}`);
      continue;
    }
    if (mapping.to !== expected.to) {
      errors.push(`invalid package notice destination: ${expected.from}`);
      continue;
    }
    const sourcePath = path.join(projectRoot, ...expected.from.split("/"));
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      errors.push(`missing package notice source: ${expected.from}`);
      continue;
    }
    destinations.push(expected.to);
  }

  const manifestPath = path.join(projectRoot, "vendor", "opencodex", "UPSTREAM.json");
  const licensePath = path.join(projectRoot, "vendor", "opencodex", "LICENSE");
  if (fs.existsSync(manifestPath) && fs.existsSync(licensePath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.license !== "MIT") errors.push("OpenCodex package license must be MIT");
    if (sha256File(licensePath) !== manifest.licenseSha256) {
      errors.push("OpenCodex package license hash mismatch");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    destinations: destinations.sort(),
  };
}

function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const result = verifyPackageNotices({ projectRoot: PROJECT_ROOT, buildConfig: packageJson.build });
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`OpenCodex package notice: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`OpenCodex package notices verified (${result.destinations.length} files)\n`);
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
  verifyPackageNotices,
};
