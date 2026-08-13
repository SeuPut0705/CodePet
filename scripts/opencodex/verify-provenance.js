const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { verifyVendoredSnapshot } = require("../../src/open-codex/upstream-provenance");

const vendorDir = path.resolve(__dirname, "..", "..", "vendor", "opencodex");
const projectRoot = path.resolve(vendorDir, "..", "..");
const result = verifyVendoredSnapshot({
  vendorDir,
  readMaterializedSymlinkTarget: process.platform === "win32"
    ? (relativePath) => execFileSync(
      "git",
      ["show", `:vendor/opencodex/${relativePath}`],
      { cwd: projectRoot, encoding: "utf8" }
    )
    : undefined,
});

if (!result.ok) {
  for (const error of result.errors) process.stderr.write(`OpenCodex provenance: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `OpenCodex ${result.manifest.tag} ${result.manifest.commit} verified (${result.filesChecked} files)\n`
  );
}
