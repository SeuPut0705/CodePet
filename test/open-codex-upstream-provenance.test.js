const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseInventory,
  validateManifest,
  verifyVendoredSnapshot,
} = require("../src/open-codex/upstream-provenance");

const EXPECTED_COMMIT = "ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10";
const EXPECTED_TREE = "0123456789abcdef0123456789abcdef01234567";
const HASH = "a".repeat(64);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: "https://github.com/lidge-jun/opencodex.git",
    tag: "v2.7.41",
    commit: EXPECTED_COMMIT,
    tree: EXPECTED_TREE,
    license: "MIT",
    licensePath: "LICENSE",
    licenseSha256: HASH,
    inventoryPath: "FILES.sha256",
    trackedFiles: 2,
    syncedAt: "2026-07-27T00:00:00.000Z",
    patches: [],
    ...overrides,
  };
}

function writeFixture(t) {
  const vendorDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencodex-provenance-"));
  t.after(() => fs.rmSync(vendorDir, { recursive: true, force: true }));

  const license = "MIT License\nfixture\n";
  const source = "export const value = 1;\n";
  fs.mkdirSync(path.join(vendorDir, "src"));
  fs.writeFileSync(path.join(vendorDir, "LICENSE"), license);
  fs.writeFileSync(path.join(vendorDir, "src", "index.ts"), source);
  fs.writeFileSync(
    path.join(vendorDir, "FILES.sha256"),
    `${sha256(license)}  100644  LICENSE\n${sha256(source)}  100644  src/index.ts\n`
  );
  fs.writeFileSync(
    path.join(vendorDir, "UPSTREAM.json"),
    `${JSON.stringify(manifest({ licenseSha256: sha256(license) }), null, 2)}\n`
  );
  return vendorDir;
}

test("OpenCodex manifest는 저장소 태그 커밋과 MIT 고지를 요구한다", () => {
  for (const field of ["repository", "tag", "commit", "tree", "license", "licensePath", "licenseSha256", "inventoryPath"]) {
    const invalid = manifest();
    delete invalid[field];
    assert.throws(() => validateManifest(invalid), new RegExp(field));
  }

  assert.equal(validateManifest(manifest()).commit, EXPECTED_COMMIT);
  assert.throws(() => validateManifest(manifest({ commit: "short" })), /commit/);
  assert.throws(() => validateManifest(manifest({ license: "Apache-2.0" })), /MIT/);
});

test("OpenCodex inventory는 경로 이탈과 중복을 거부한다", () => {
  assert.throws(() => parseInventory(`${HASH}  100644  ../secret\n`), /unsafe path/);
  assert.throws(() => parseInventory(`${HASH}  100644  /absolute\n`), /unsafe path/);
  assert.throws(() => parseInventory(`${HASH}  100600  src/a.ts\n`), /mode/);
  assert.throws(
    () => parseInventory(`${HASH}  100644  src/a.ts\n${HASH}  100644  src/a.ts\n`),
    /duplicate/
  );
  assert.deepEqual(parseInventory(`${HASH}  100755  src/a.ts\n`), [
    { hash: HASH, mode: "100755", relativePath: "src/a.ts" },
  ]);
});

test("검증기는 정상 snapshot의 license와 전체 tracked file을 확인한다", (t) => {
  const vendorDir = writeFixture(t);

  const result = verifyVendoredSnapshot({ vendorDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.filesChecked, 2);
  assert.equal(result.manifest.commit, EXPECTED_COMMIT);
});

test("검증기는 변조와 inventory 밖의 추가 파일을 보고한다", (t) => {
  const vendorDir = writeFixture(t);
  fs.writeFileSync(path.join(vendorDir, "src", "index.ts"), "tampered\n");
  fs.writeFileSync(path.join(vendorDir, "src", "extra.ts"), "extra\n");

  const result = verifyVendoredSnapshot({ vendorDir });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("hash mismatch: src/index.ts"));
  assert.ok(result.errors.includes("unexpected file: src/extra.ts"));
});

test("검증기는 snapshot 내부를 가리키는 symlink의 대상까지 검증한다", (t) => {
  const vendorDir = writeFixture(t);
  fs.symlinkSync("index.ts", path.join(vendorDir, "src", "entry.ts"));
  fs.writeFileSync(
    path.join(vendorDir, "FILES.sha256"),
    [
      `${sha256("MIT License\nfixture\n")}  100644  LICENSE`,
      `${sha256("symlink:index.ts")}  120000  src/entry.ts`,
      `${sha256("export const value = 1;\n")}  100644  src/index.ts`,
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(vendorDir, "UPSTREAM.json"),
    `${JSON.stringify(manifest({
      licenseSha256: sha256("MIT License\nfixture\n"),
      trackedFiles: 3,
    }), null, 2)}\n`
  );

  assert.equal(verifyVendoredSnapshot({ vendorDir }).ok, true);

  fs.unlinkSync(path.join(vendorDir, "src", "entry.ts"));
  fs.symlinkSync("../../outside.ts", path.join(vendorDir, "src", "entry.ts"));
  const result = verifyVendoredSnapshot({ vendorDir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("unsafe symbolic link: src/entry.ts"));
});
