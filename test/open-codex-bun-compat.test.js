const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const compatibilityUrl = pathToFileURL(
  path.resolve(__dirname, "../src/open-codex/runtime/bun-compat.ts")
).href;

async function loadCompatibility() {
  return import(compatibilityUrl);
}

test("Bun 기본 호환 계층은 sleep과 동기 sleep을 독립적으로 제공한다", async (t) => {
  const previousBun = globalThis.Bun;
  t.after(() => {
    if (previousBun === undefined) delete globalThis.Bun;
    else globalThis.Bun = previousBun;
  });
  const { installBunCompatibility } = await loadCompatibility();
  const bun = installBunCompatibility();

  const first = bun.sleep(2);
  const second = bun.sleep(2);
  assert.notEqual(first, second);
  await Promise.all([first, second]);

  const startedAt = Date.now();
  bun.sleepSync(2);
  assert.ok(Date.now() - startedAt >= 1);
});

test("Bun 기본 호환 계층은 digest와 결정적 hash를 제공한다", async (t) => {
  const previousBun = globalThis.Bun;
  t.after(() => {
    if (previousBun === undefined) delete globalThis.Bun;
    else globalThis.Bun = previousBun;
  });
  const { installBunCompatibility } = await loadCompatibility();
  const bun = installBunCompatibility();

  const digest = new bun.CryptoHasher("sha256").update("abc").digest();
  assert.equal(
    Buffer.from(digest).toString("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  const first = bun.hash("same input");
  assert.equal(first, bun.hash("same input"));
  assert.notEqual(first, bun.hash("different input"));
  assert.ok(typeof first === "bigint" || Number.isSafeInteger(first));
});

test("Bun 기본 호환 계층은 파일 본문과 정제된 spawn 결과를 전달한다", async (t) => {
  const previousBun = globalThis.Bun;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-bun-compat-"));
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    if (previousBun === undefined) delete globalThis.Bun;
    else globalThis.Bun = previousBun;
  });
  const { installBunCompatibility } = await loadCompatibility();
  const bun = installBunCompatibility();
  const filePath = path.join(directory, "body.txt");
  fs.writeFileSync(filePath, "OpenCodex body");

  assert.equal(await new Response(bun.file(filePath)).text(), "OpenCodex body");
  const result = bun.spawnSync([process.execPath, "-e", "process.stdout.write('ok')"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.from(result.stdout).toString(), "ok");
  assert.equal("command" in result, false);
  assert.equal("env" in result, false);
});

test("지원하지 않는 Bun.Image는 이름 있는 capability 오류를 낸다", async (t) => {
  const previousBun = globalThis.Bun;
  t.after(() => {
    if (previousBun === undefined) delete globalThis.Bun;
    else globalThis.Bun = previousBun;
  });
  const { installBunCompatibility, OpenCodexCapabilityError } = await loadCompatibility();
  const bun = installBunCompatibility();

  assert.throws(
    () => new bun.Image(new Uint8Array()),
    (error) => error instanceof OpenCodexCapabilityError && error.capability === "bun-image"
  );
  assert.equal(typeof bun.version, "string");
  assert.equal(typeof bun.revision, "string");
  assert.match(bun.inspect({ healthy: true }), /healthy/);
});
