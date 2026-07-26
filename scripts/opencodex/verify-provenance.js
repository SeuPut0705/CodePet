const path = require("node:path");

const { verifyVendoredSnapshot } = require("../../src/open-codex/upstream-provenance");

const vendorDir = path.resolve(__dirname, "..", "..", "vendor", "opencodex");
const result = verifyVendoredSnapshot({ vendorDir });

if (!result.ok) {
  for (const error of result.errors) process.stderr.write(`OpenCodex provenance: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `OpenCodex ${result.manifest.tag} ${result.manifest.commit} verified (${result.filesChecked} files)\n`
  );
}
