const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const { buildEngine } = require("../scripts/opencodex/build-engine");

const projectRoot = path.resolve(__dirname, "..");

test("OpenCodex engine build는 vendored server를 단일 Node 24 ESM으로 만든다", async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencodex-engine-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const outputPath = path.join(outputDir, "opencodex-engine.mjs");

  const result = await buildEngine({ projectRoot, outputPath });
  const source = fs.readFileSync(outputPath, "utf8");

  assert.equal(result.outputPath, outputPath);
  assert.ok(result.bytes > 100_000, `unexpected engine size: ${result.bytes}`);
  assert.match(source, /startEmbeddedEngine/);
  assert.match(source, /getEmbeddedEngineStatus/);
  assert.doesNotMatch(source, /(?:from|import\()["']bun:/);
  assert.doesNotMatch(source, /require\(["']bun:/);

  const engine = await import(pathToFileURL(outputPath).href);
  assert.deepEqual(Object.keys(engine).sort(), [
    "getEmbeddedEngineStatus",
    "startEmbeddedEngine",
    "stopEmbeddedEngine",
  ]);
  assert.deepEqual(engine.getEmbeddedEngineStatus(), {
    activeTurns: 0,
    draining: false,
    port: null,
    running: false,
  });
});

test("OpenCodex engine build는 같은 입력에서 byte-stable하다", async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencodex-engine-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const firstPath = path.join(outputDir, "first.mjs");
  const secondPath = path.join(outputDir, "second.mjs");

  await buildEngine({ projectRoot, outputPath: firstPath });
  await buildEngine({ projectRoot, outputPath: secondPath });

  assert.deepEqual(fs.readFileSync(secondPath), fs.readFileSync(firstPath));
});
