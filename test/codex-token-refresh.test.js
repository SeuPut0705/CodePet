const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  accessTokenExpiresAtMs,
  refreshAuthFileIfStale,
} = require("../src/codex-token-refresh");

function fakeJwt(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

test("JWT exp 클레임으로 만료 시각을 계산하고 형식이 다르면 null을 준다", () => {
  assert.equal(accessTokenExpiresAtMs(fakeJwt({ exp: 1000 })), 1000 * 1000);
  assert.equal(accessTokenExpiresAtMs("not-a-jwt"), null);
});

test("만료 임박한 Codex 토큰은 refresh token으로 갱신하고 auth 파일에 원자 저장한다", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-proxy-refresh-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const authPath = path.join(home, "auth.json");
  const original = {
    auth_mode: "chatgpt",
    tokens: {
      account_id: "workspace-a",
      access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 30 }),
      refresh_token: "refresh-old",
      id_token: "id-old",
    },
  };
  fs.writeFileSync(authPath, JSON.stringify(original), "utf8");

  let request = null;
  const refreshed = await refreshAuthFileIfStale(authPath, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return {
            access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: "refresh-new",
            id_token: "id-new",
          };
        },
      };
    },
  });

  const saved = JSON.parse(fs.readFileSync(authPath, "utf8"));
  assert.match(request.url, /auth\.openai\.com\/oauth\/token$/);
  assert.equal(JSON.parse(request.options.body).refresh_token, "refresh-old");
  assert.equal(refreshed.tokens.refresh_token, "refresh-new");
  assert.equal(saved.tokens.refresh_token, "refresh-new");
  assert.equal(saved.tokens.account_id, "workspace-a");
  assert.ok(saved.last_refresh);
});
