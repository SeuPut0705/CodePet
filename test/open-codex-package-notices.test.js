const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const packageJson = require("../package.json");
const {
  verifyPackageNotices,
} = require("../scripts/opencodex/verify-package-notices");

const projectRoot = path.resolve(__dirname, "..");

test("패키지 설정은 OpenCodex MIT 고지와 출처 metadata 세 파일을 포함한다", () => {
  const result = verifyPackageNotices({
    projectRoot,
    buildConfig: packageJson.build,
  });

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.destinations, [
    "third-party/opencodex/FILES.sha256",
    "third-party/opencodex/LICENSE",
    "third-party/opencodex/UPSTREAM.json",
  ]);
});

test("패키지 고지 검증은 누락되거나 다른 위치로 매핑된 파일을 거부한다", () => {
  const missing = verifyPackageNotices({
    projectRoot,
    buildConfig: { extraResources: [] },
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.includes("missing package notice mapping: vendor/opencodex/LICENSE"));

  const misplaced = verifyPackageNotices({
    projectRoot,
    buildConfig: {
      extraResources: [
        { from: "vendor/opencodex/LICENSE", to: "LICENSE" },
      ],
    },
  });
  assert.equal(misplaced.ok, false);
  assert.ok(misplaced.errors.includes("invalid package notice destination: vendor/opencodex/LICENSE"));
});
