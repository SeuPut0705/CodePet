const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyGoogleAntigravityEnvOnly,
} = require("../patches/opencodex/google-antigravity-env-only");
const { applyPatchSeries } = require("../scripts/opencodex/sync");

const sourceFixture = `
const CLIENT_ID = process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID
  || "client-id-fixture";
const CLIENT_SECRET = process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET
  || "client-secret-fixture";

class AntigravityOAuthFlow {
  async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
    const pkce = await generatePKCE();
    return { client_id: CLIENT_ID };
  }

  async exchangeToken(code: string, _state: string, redirectUri: string) {
    return postToken({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  }
}

export async function refreshAntigravityToken(refreshToken: string, signal?: AbortSignal) {
  return postToken({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
}
`;

test("Google Antigravity patch는 정적 OAuth 기본값을 제거하고 각 진입점에서 환경값을 검증한다", (t) => {
  const vendorDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencodex-patch-"));
  t.after(() => fs.rmSync(vendorDir, { recursive: true, force: true }));
  const filePath = path.join(vendorDir, "src", "oauth", "google-antigravity.ts");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, sourceFixture);

  const result = applyGoogleAntigravityEnvOnly({ vendorDir });
  const patched = fs.readFileSync(filePath, "utf8");

  assert.equal(result.changed, true);
  assert.doesNotMatch(patched, /client-(?:id|secret)-fixture/);
  assert.match(patched, /GOOGLE_ANTIGRAVITY_CLIENT_ID\?\.trim\(\) \|\| ""/);
  assert.match(patched, /GOOGLE_ANTIGRAVITY_CLIENT_SECRET\?\.trim\(\) \|\| ""/);
  assert.equal((patched.match(/assertGoogleAntigravityOAuthEnvironment\(\);/g) || []).length, 3);
});

test("Google Antigravity patch는 이미 적용된 파일에서 멱등이다", (t) => {
  const vendorDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencodex-patch-"));
  t.after(() => fs.rmSync(vendorDir, { recursive: true, force: true }));
  const filePath = path.join(vendorDir, "src", "oauth", "google-antigravity.ts");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, sourceFixture);

  applyGoogleAntigravityEnvOnly({ vendorDir });
  const once = fs.readFileSync(filePath, "utf8");
  const result = applyGoogleAntigravityEnvOnly({ vendorDir });

  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(filePath, "utf8"), once);
});

test("sync patch series는 선언 순서대로 transformer를 적용하고 ID를 반환한다", (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencodex-series-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const patchDir = path.join(projectRoot, "patches", "opencodex");
  const vendorDir = path.join(projectRoot, "vendor", "opencodex");
  fs.mkdirSync(patchDir, { recursive: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, "value.txt"), "start\n");
  fs.writeFileSync(
    path.join(patchDir, "fixture.js"),
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "module.exports.apply = ({ vendorDir }) => {",
      '  fs.appendFileSync(path.join(vendorDir, "value.txt"), "patched\\n");',
      "};",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(patchDir, "series.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      patches: [{ id: "fixture", module: "fixture.js", reason: "test" }],
    })}\n`
  );

  const patches = applyPatchSeries({ projectRoot, vendorDir });

  assert.deepEqual(patches, ["fixture"]);
  assert.equal(fs.readFileSync(path.join(vendorDir, "value.txt"), "utf8"), "start\npatched\n");
});
