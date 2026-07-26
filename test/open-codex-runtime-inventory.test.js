const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  scanRuntimeDependencies,
  writeRuntimeInventory,
} = require("../scripts/opencodex/runtime-inventory");

const codePetRoot = path.resolve(__dirname, "..");
const vendorDir = path.join(codePetRoot, "vendor", "opencodex");
const requiredCapabilities = [
  "Bun.CryptoHasher",
  "Bun.Image",
  "Bun.file",
  "Bun.hash",
  "Bun.serve",
  "Bun.sleep",
  "Bun.sleepSync",
  "bun:ffi",
  "bun:jsc",
  "bun:sqlite",
  "import.meta.dir",
];

test("runtime inventory는 Electron 호환이 필요한 Bun 표면을 실제 경로와 함께 찾는다", () => {
  const inventory = scanRuntimeDependencies({ vendorDir });

  assert.equal(inventory.upstreamCommit, "ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10");
  for (const capability of requiredCapabilities) {
    const entry = inventory.capabilities.find((candidate) => candidate.name === capability);
    assert.ok(entry, capability);
    assert.ok(entry.occurrences.length > 0, `${capability} occurrences`);
    for (const occurrence of entry.occurrences) {
      assert.match(occurrence.file, /^src\/.+\.ts$/);
      assert.ok(Number.isInteger(occurrence.line) && occurrence.line > 0);
      assert.equal(fs.existsSync(path.join(vendorDir, occurrence.file)), true);
      assert.deepEqual(Object.keys(occurrence).sort(), ["file", "line"]);
    }
  }
});

test("runtime inventory 출력은 같은 source에서 byte-stable하다", (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-runtime-inventory-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const outputPath = path.join(outputDir, "inventory.json");

  writeRuntimeInventory({ vendorDir, outputPath });
  const first = fs.readFileSync(outputPath, "utf8");
  writeRuntimeInventory({ vendorDir, outputPath });

  assert.equal(fs.readFileSync(outputPath, "utf8"), first);
  assert.equal(first.endsWith("\n"), true);
});
