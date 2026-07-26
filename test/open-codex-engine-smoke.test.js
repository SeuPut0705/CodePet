const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildEngine } = require("../scripts/opencodex/build-engine");
const { runEngineSmoke } = require("../scripts/opencodex/engine-smoke");

const projectRoot = path.resolve(__dirname, "..");

test("내장 OpenCodex worker는 실제 health port와 stream drain을 보존한다", async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencodex-smoke-build-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const enginePath = path.join(outputDir, "opencodex-engine.mjs");
  await buildEngine({ projectRoot, outputPath: enginePath });

  const result = await runEngineSmoke({ enginePath, projectRoot });

  assert.equal(result.health.service, "opencodex");
  assert.equal(result.health.pidMatches, true);
  assert.equal(result.health.portMatches, true);
  assert.deepEqual(result.kimi, {
    credentialLoaded: true,
    modelSelectable: true,
    statusTokenSafe: true,
  });
  assert.equal(result.streamHeldDrain, true);
  assert.equal(result.listenerClosed, true);
});
