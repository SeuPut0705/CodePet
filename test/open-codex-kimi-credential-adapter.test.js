const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  OpenCodexCredentialSyncError,
  syncKimiCliCredential,
} = require("../src/open-codex/kimi-credential-adapter");

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "fixture",
  ].join(".");
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencodex-kimi-"));
  const kimiHome = path.join(root, "kimi");
  const openCodexHome = path.join(root, "opencodex");
  const credentialFile = path.join(kimiHome, "credentials", "kimi-code.json");
  fs.mkdirSync(path.dirname(credentialFile), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { credentialFile, kimiHome, openCodexHome };
}

function writeKimiCredential(file, overrides = {}) {
  const credential = {
    access_token: jwt({ user_id: "kimi-user-1", email: "USER@EXAMPLE.COM" }),
    refresh_token: jwt({ user_id: "kimi-user-1" }),
    expires_at: 2_000_000_000,
    expires_in: 3600,
    scope: "openid",
    token_type: "Bearer",
    ...overrides,
  };
  fs.writeFileSync(file, `${JSON.stringify(credential)}\n`, { mode: 0o600 });
  return credential;
}

test("Kimi CLI 계정을 OpenCodex multiauth로 원자 동기화한다", (t) => {
  const target = fixture(t);
  const source = writeKimiCredential(target.credentialFile);
  fs.writeFileSync(path.join(target.kimiHome, "device_id"), "device-123\n", { mode: 0o600 });

  const result = syncKimiCliCredential({
    kimiHome: target.kimiHome,
    openCodexHome: target.openCodexHome,
    nowMilliseconds: () => 1_700_000_000_000,
  });

  assert.deepEqual(result, {
    accountId: "kimi-user-1",
    deviceIdCopied: true,
    status: "synced",
  });
  const authPath = path.join(target.openCodexHome, "auth.json");
  const store = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const account = store.kimi.accounts.find((candidate) => candidate.id === store.kimi.activeAccountId);
  assert.equal(account.id, "codepet-kimi-cli");
  assert.equal(account.alias, "Kimi Code CLI");
  assert.deepEqual(account.credential, {
    access: source.access_token,
    refresh: "",
    expires: source.expires_at * 1000 - 300_000,
    email: "user@example.com",
    accountId: "kimi-user-1",
    source: "local-cli",
  });
  assert.equal(fs.readFileSync(path.join(target.openCodexHome, "kimi-device-id"), "utf8"), "device-123\n");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(target.openCodexHome).mode & 0o777, 0o700);
    assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(target.openCodexHome, "kimi-device-id")).mode & 0o777, 0o600);
  }
});

test("CodePet 소유 슬롯만 갱신하고 같은 신원의 OpenCodex 계정도 보존한다", (t) => {
  const target = fixture(t);
  const source = writeKimiCredential(target.credentialFile, {
    access_token: jwt({ sub: "same-user" }),
    refresh_token: jwt({ user_id: "same-user", email: "same@example.com" }),
  });
  fs.mkdirSync(target.openCodexHome, { recursive: true });
  fs.writeFileSync(path.join(target.openCodexHome, "auth.json"), `${JSON.stringify({
    chatgpt: { access: "keep", refresh: "keep", expires: 123 },
    kimi: {
      activeAccountId: "other",
      accounts: [
        {
          id: "native",
          alias: "내 Kimi",
          credential: {
            access: "old-access",
            refresh: "old-refresh",
            expires: 1,
            accountId: "same-user",
          },
        },
        {
          id: "codepet-kimi-cli",
          alias: "Kimi Code CLI",
          needsReauth: true,
          credential: {
            access: "old-codepet-access",
            refresh: "must-not-survive",
            expires: 1,
            source: "local-cli",
          },
        },
        {
          id: "other",
          credential: { access: "other", refresh: "other", expires: 999 },
        },
      ],
    },
  }, null, 2)}\n`, { mode: 0o600 });

  syncKimiCliCredential({ kimiHome: target.kimiHome, openCodexHome: target.openCodexHome });

  const store = JSON.parse(fs.readFileSync(path.join(target.openCodexHome, "auth.json"), "utf8"));
  assert.deepEqual(store.chatgpt, { access: "keep", refresh: "keep", expires: 123 });
  assert.equal(store.kimi.accounts.length, 3);
  assert.equal(store.kimi.activeAccountId, "codepet-kimi-cli");
  assert.equal(store.kimi.accounts[0].alias, "내 Kimi");
  assert.equal(store.kimi.accounts[0].credential.access, "old-access");
  assert.equal(store.kimi.accounts[0].credential.refresh, "old-refresh");
  assert.equal(store.kimi.accounts[1].needsReauth, undefined);
  assert.equal(store.kimi.accounts[1].credential.access, source.access_token);
  assert.equal(store.kimi.accounts[1].credential.refresh, "");
  assert.equal(store.kimi.accounts[2].credential.access, "other");
});

test("손상된 대상 auth.json은 보존하고 토큰 없는 오류만 낸다", (t) => {
  const target = fixture(t);
  const source = writeKimiCredential(target.credentialFile);
  fs.mkdirSync(target.openCodexHome, { recursive: true });
  const authPath = path.join(target.openCodexHome, "auth.json");
  const corrupt = '{"kimi":';
  fs.writeFileSync(authPath, corrupt, { mode: 0o600 });

  assert.throws(
    () => syncKimiCliCredential({ kimiHome: target.kimiHome, openCodexHome: target.openCodexHome }),
    (error) => {
      assert.ok(error instanceof OpenCodexCredentialSyncError);
      assert.equal(error.code, "OPENCODEX_AUTH_STORE_INVALID");
      assert.doesNotMatch(error.message, new RegExp(source.access_token.replaceAll(".", "\\.")));
      assert.doesNotMatch(error.message, /old-refresh/);
      return true;
    }
  );
  assert.equal(fs.readFileSync(authPath, "utf8"), corrupt);
});

test("없거나 잘못된 Kimi CLI 로그인은 대상 저장소를 만들지 않고 fail closed한다", (t) => {
  const target = fixture(t);
  assert.deepEqual(
    syncKimiCliCredential({ kimiHome: target.kimiHome, openCodexHome: target.openCodexHome }),
    { reason: "missing", status: "unavailable" }
  );

  fs.mkdirSync(path.dirname(target.credentialFile), { recursive: true });
  fs.writeFileSync(target.credentialFile, JSON.stringify({ access_token: "secret-but-incomplete" }));
  assert.deepEqual(
    syncKimiCliCredential({ kimiHome: target.kimiHome, openCodexHome: target.openCodexHome }),
    { reason: "invalid", status: "unavailable" }
  );
  assert.equal(fs.existsSync(path.join(target.openCodexHome, "auth.json")), false);
});

test("refresh token이 있어도 만료 임박 Kimi access token은 가져오지 않는다", (t) => {
  const target = fixture(t);
  fs.mkdirSync(target.openCodexHome, { recursive: true });
  fs.writeFileSync(path.join(target.openCodexHome, "auth.json"), `${JSON.stringify({
    kimi: {
      activeAccountId: "codepet-kimi-cli",
      accounts: [
        {
          id: "native",
          credential: { access: "native", refresh: "native-refresh", expires: 999 },
        },
        {
          id: "codepet-kimi-cli",
          credential: { access: "stale", refresh: "stale-refresh", expires: 1 },
        },
      ],
    },
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(target.openCodexHome, "kimi-device-id"), "stale-device\n", { mode: 0o600 });
  writeKimiCredential(target.credentialFile, {
    refresh_token: "refresh-owned-by-kimi-cli",
    expires_at: 100,
  });

  assert.deepEqual(
    syncKimiCliCredential({
      kimiHome: target.kimiHome,
      openCodexHome: target.openCodexHome,
      nowMilliseconds: () => 200_000,
    }),
    { reason: "expired", status: "unavailable" }
  );
  const store = JSON.parse(fs.readFileSync(path.join(target.openCodexHome, "auth.json"), "utf8"));
  assert.equal(store.kimi.activeAccountId, "native");
  assert.deepEqual(store.kimi.accounts.map((account) => account.id), ["native"]);
  assert.equal(fs.existsSync(path.join(target.openCodexHome, "kimi-device-id")), false);
});
