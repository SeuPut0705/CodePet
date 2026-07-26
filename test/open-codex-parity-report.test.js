const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildParityReport,
  writeParityReport,
} = require("../scripts/opencodex/parity-report");

const codePetRoot = path.resolve(__dirname, "..");
const vendorDir = path.join(codePetRoot, "vendor", "opencodex");
const categoryNames = [
  "providers",
  "adapters",
  "oauth",
  "transports",
  "codexIntegration",
  "claudeIntegration",
  "usage",
  "management",
  "cliRuntime",
];

test("동등성 보고서는 OpenCodex 런타임 범주와 실제 upstream evidence를 목록화한다", () => {
  const report = buildParityReport({ vendorDir, codePetRoot });

  assert.equal(report.upstream.commit, "ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10");
  for (const categoryName of categoryNames) {
    const entries = report.categories[categoryName];
    assert.ok(entries.length > 0, `${categoryName} must not be empty`);
    for (const entry of entries) {
      assert.equal(entry.status, "imported");
      assert.ok(entry.upstreamEvidence.length > 0);
      for (const evidence of entry.upstreamEvidence) {
        assert.equal(fs.existsSync(path.join(vendorDir, evidence)), true, evidence);
      }
    }
  }
  assert.equal(report.summary.statusCounts["runtime-verified"], 0);
  assert.equal(
    report.summary.total,
    categoryNames.reduce((sum, name) => sum + report.categories[name].length, 0)
  );
});

test("Kimi 관련 upstream 항목은 현재 CodePet Kimi 파일을 후보 evidence로 연결한다", () => {
  const report = buildParityReport({ vendorDir, codePetRoot });
  const entries = Object.values(report.categories).flat();
  const kimiEntries = entries.filter((entry) => /kimi/i.test(entry.id));

  assert.ok(kimiEntries.length > 0);
  assert.ok(
    kimiEntries.some((entry) => entry.codePetEvidence.includes("src/kimi-codex-adapter.js"))
  );
});

test("동등성 보고서 파일은 같은 입력에서 byte-stable하게 생성된다", (t) => {
  const outputDir = fs.mkdtempSync(path.join(codePetRoot, ".parity-test-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const outputPath = path.join(outputDir, "opencodex-parity.json");

  writeParityReport({ vendorDir, codePetRoot, outputPath });
  const first = fs.readFileSync(outputPath, "utf8");
  writeParityReport({ vendorDir, codePetRoot, outputPath });
  const second = fs.readFileSync(outputPath, "utf8");

  assert.equal(second, first);
  assert.equal(first.endsWith("\n"), true);
});
