"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { CodexAccountSwitcher } = require("../src/codex-account-switcher");
const {
  CodexAccountBridgeApiError,
  ENGINE_ACCOUNT_ID_RE,
  addAccount,
  clearCooldown,
  getActiveAccount,
  listEngineAccounts,
  normalizeEngineAccountId,
  primeAccounts,
  reverseSyncEngineAccounts,
  seedEngineAccounts,
  selectAccount,
} = require("../src/open-codex/codex-account-bridge");

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "fixture",
  ].join(".");
}

function codexAuth({ email, plan = "plus", accountId, refreshToken, accessExp = 2_000_000_000 }) {
  return {
    tokens: {
      id_token: jwt({
        email,
        "https://api.openai.com/auth": {
          chatgpt_account_id: accountId,
          chatgpt_plan_type: plan,
        },
      }),
      access_token: jwt({
        exp: accessExp,
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      }),
      refresh_token: refreshToken,
      account_id: accountId,
    },
    last_refresh: "2026-07-01T00:00:00.000Z",
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-account-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const switcher = new CodexAccountSwitcher({ homeDir: root });
  const openCodexHome = path.join(root, "opencodex");
  fs.mkdirSync(openCodexHome, { recursive: true });
  return { root, switcher, openCodexHome };
}

function writeProfile(switcher, key, auth) {
  const dir = path.join(switcher.profilesRoot, key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  return path.join(dir, "auth.json");
}

test("normalizeEngineAccountId keeps valid keys and sanitizes invalid ones", () => {
  assert.equal(normalizeEngineAccountId("user-example-com-plus"), "user-example-com-plus");
  assert.equal(normalizeEngineAccountId("live"), "live");
  assert.equal(normalizeEngineAccountId("User A@example.com"), "user-a-example.com");
  assert.equal(normalizeEngineAccountId("  --weird key--  "), "weird-key");
  assert.equal(normalizeEngineAccountId("x".repeat(80)), "x".repeat(64));
  assert.match(normalizeEngineAccountId(""), /^acct-[0-9a-f]{8}$/);
  assert.match(normalizeEngineAccountId("###"), /^acct-[0-9a-f]{8}$/);
  for (const key of ["User A@example.com", "###", "x".repeat(80)]) {
    assert.ok(ENGINE_ACCOUNT_ID_RE.test(normalizeEngineAccountId(key)), `normalized id for ${key}`);
  }
});

test("listEngineAccounts orders profiles with auth active-first", (t) => {
  const { switcher } = fixture(t);
  writeProfile(switcher, "aaa-first", codexAuth({ email: "a@example.com", accountId: "acc-a", refreshToken: "rt-a" }));
  writeProfile(switcher, "zzz-second", codexAuth({ email: "b@example.com", accountId: "acc-b", refreshToken: "rt-b" }));
  switcher.writeActiveProfileKey("zzz-second");

  const accounts = listEngineAccounts({ switcher });

  assert.deepEqual(accounts.map((account) => account.profileKey), ["zzz-second", "aaa-first"]);
  assert.deepEqual(accounts.map((account) => account.id), ["zzz-second", "aaa-first"]);
  assert.equal(accounts[0].email, "b@example.com");
  assert.equal(accounts[0].plan, "plus");
  assert.equal(accounts[0].credential.chatgptAccountId, "acc-b");
  assert.equal(accounts[0].credential.refreshToken, "rt-b");
  assert.equal(accounts[0].credential.expiresAt, 2_000_000_000_000);
});

test("listEngineAccounts falls back to a single live account when no profiles exist", (t) => {
  const { switcher } = fixture(t);
  fs.mkdirSync(switcher.codexHome, { recursive: true });
  fs.writeFileSync(
    switcher.targetAuthPath,
    JSON.stringify(codexAuth({ email: "live@example.com", accountId: "acc-live", refreshToken: "rt-live" })),
    { mode: 0o600 }
  );

  const accounts = listEngineAccounts({ switcher });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "live");
  assert.equal(accounts[0].profileKey, "live");
  assert.equal(accounts[0].authPath, switcher.targetAuthPath);
  assert.equal(accounts[0].credential.refreshToken, "rt-live");
});

test("listEngineAccounts skips profiles without usable auth", (t) => {
  const { switcher } = fixture(t);
  writeProfile(switcher, "good", codexAuth({ email: "g@example.com", accountId: "acc-g", refreshToken: "rt-g" }));
  writeProfile(switcher, "not-json", null);
  fs.writeFileSync(path.join(switcher.profilesRoot, "not-json", "auth.json"), "{broken", { mode: 0o600 });
  const noRefresh = codexAuth({ email: "n@example.com", accountId: "acc-n", refreshToken: "rt-n" });
  delete noRefresh.tokens.refresh_token;
  writeProfile(switcher, "no-refresh", noRefresh);

  const accounts = listEngineAccounts({ switcher });

  assert.deepEqual(accounts.map((account) => account.profileKey), ["good"]);
});

test("listEngineAccounts dedupes colliding normalized ids deterministically", (t) => {
  const { switcher } = fixture(t);
  // Both keys normalize to "user-a"; the alphabetically first profile keeps it.
  writeProfile(switcher, "User A", codexAuth({ email: "a@example.com", accountId: "acc-1", refreshToken: "rt-1" }));
  writeProfile(switcher, "user-a", codexAuth({ email: "b@example.com", accountId: "acc-2", refreshToken: "rt-2" }));

  const accounts = listEngineAccounts({ switcher });

  assert.equal(accounts.length, 2);
  const ids = accounts.map((account) => account.id);
  assert.ok(ids.includes("user-a"));
  const other = ids.find((id) => id !== "user-a");
  assert.match(other, /^user-a-[0-9a-f]{4}$/);
  assert.ok(ENGINE_ACCOUNT_ID_RE.test(other));
  // Stable across calls: same input order produces the same ids.
  const again = listEngineAccounts({ switcher }).map((account) => account.id);
  assert.deepEqual(again, ids);
});

test("seedEngineAccounts writes the legacy store shape and returns config metadata", (t) => {
  const { switcher, openCodexHome } = fixture(t);
  writeProfile(switcher, "acct-one", codexAuth({ email: "one@example.com", accountId: "acc-1", refreshToken: "rt-1" }));
  writeProfile(switcher, "acct-two", codexAuth({ email: null, plan: null, accountId: "acc-2", refreshToken: "rt-2" }));
  switcher.writeActiveProfileKey("acct-two");
  const accounts = listEngineAccounts({ switcher });

  const result = seedEngineAccounts({ openCodexHome, accounts, nowMs: 1_800_000_000_000 });

  assert.deepEqual(result.seeded, ["acct-two", "acct-one"]);
  assert.deepEqual(result.codexAccounts, [
    { id: "acct-two", email: "acct-two", isMain: false },
    { id: "acct-one", email: "one@example.com", isMain: false, plan: "plus" },
  ]);

  const store = JSON.parse(fs.readFileSync(path.join(openCodexHome, "codex-accounts.json"), "utf8"));
  // Legacy simple shape the engine loader normalizes (account-store.ts:63-77):
  // exactly the four credential fields, strings plus a finite expiresAt.
  for (const id of ["acct-two", "acct-one"]) {
    assert.deepEqual(Object.keys(store[id]).sort(), ["accessToken", "chatgptAccountId", "expiresAt", "refreshToken"]);
    assert.equal(typeof store[id].accessToken, "string");
    assert.equal(typeof store[id].refreshToken, "string");
    assert.equal(typeof store[id].chatgptAccountId, "string");
    assert.equal(Number.isFinite(store[id].expiresAt), true);
  }
  assert.equal(store["acct-two"].refreshToken, "rt-2");
  assert.equal(fs.statSync(path.join(openCodexHome, "codex-accounts.json")).mode & 0o777, 0o600);

  const state = JSON.parse(fs.readFileSync(path.join(openCodexHome, "codepet-account-bridge.json"), "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.accounts["acct-two"].profileKey, "acct-two");
  assert.equal(state.accounts["acct-two"].seededAt, new Date(1_800_000_000_000).toISOString());
  assert.equal(typeof state.accounts["acct-two"].grantHash, "string");
});

test("reverseSyncEngineAccounts mirrors engine grant rotation back into the profile", (t) => {
  const { switcher, openCodexHome } = fixture(t);
  const authPath = writeProfile(
    switcher,
    "acct-one",
    codexAuth({ email: "one@example.com", accountId: "acc-1", refreshToken: "rt-old" })
  );
  const accounts = listEngineAccounts({ switcher });
  seedEngineAccounts({ openCodexHome, accounts, nowMs: 1_800_000_000_000 });

  // Engine refreshed and rotated the grant (normalized record shape this time).
  const engineStore = JSON.parse(fs.readFileSync(path.join(openCodexHome, "codex-accounts.json"), "utf8"));
  engineStore["acct-one"] = {
    credential: {
      accessToken: jwt({ exp: 2_100_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }),
      refreshToken: "rt-new",
      expiresAt: 2_100_000_000_000,
      chatgptAccountId: "acc-1",
    },
    generation: 1,
  };
  fs.writeFileSync(path.join(openCodexHome, "codex-accounts.json"), JSON.stringify(engineStore), { mode: 0o600 });

  const originalIdToken = JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.id_token;
  const first = reverseSyncEngineAccounts({ openCodexHome, nowMs: 1_800_000_100_000 });
  assert.deepEqual(first.synced, ["acct-one"]);
  assert.deepEqual(first.skippedConflict, []);

  const profile = JSON.parse(fs.readFileSync(authPath, "utf8"));
  assert.equal(profile.tokens.refresh_token, "rt-new");
  assert.equal(profile.tokens.access_token, engineStore["acct-one"].credential.accessToken);
  // Untouched fields survive the write-back.
  assert.equal(profile.tokens.account_id, "acc-1");
  assert.equal(profile.tokens.id_token, originalIdToken);
  assert.equal(profile.last_refresh, new Date(1_800_000_100_000).toISOString());
  assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);

  const second = reverseSyncEngineAccounts({ openCodexHome, nowMs: 1_800_000_200_000 });
  assert.deepEqual(second.unchanged, ["acct-one"]);
  assert.deepEqual(second.synced, []);
});

test("reverseSyncEngineAccounts skips a profile changed on disk since the seed", (t) => {
  const { switcher, openCodexHome } = fixture(t);
  const authPath = writeProfile(
    switcher,
    "acct-one",
    codexAuth({ email: "one@example.com", accountId: "acc-1", refreshToken: "rt-seed" })
  );
  seedEngineAccounts({ openCodexHome, accounts: listEngineAccounts({ switcher }) });

  // User re-logged in while the engine ran: profile grant no longer matches the seed.
  fs.writeFileSync(
    authPath,
    JSON.stringify(codexAuth({ email: "one@example.com", accountId: "acc-1", refreshToken: "rt-user-fresh" })),
    { mode: 0o600 }
  );
  const engineStore = JSON.parse(fs.readFileSync(path.join(openCodexHome, "codex-accounts.json"), "utf8"));
  engineStore["acct-one"].accessToken = "engine-rotated-access";
  engineStore["acct-one"].refreshToken = "rt-engine-rotated";
  fs.writeFileSync(path.join(openCodexHome, "codex-accounts.json"), JSON.stringify(engineStore), { mode: 0o600 });

  const result = reverseSyncEngineAccounts({ openCodexHome });

  assert.deepEqual(result.skippedConflict, ["acct-one"]);
  assert.deepEqual(result.synced, []);
  const profile = JSON.parse(fs.readFileSync(authPath, "utf8"));
  assert.equal(profile.tokens.refresh_token, "rt-user-fresh");
});

test("reverseSyncEngineAccounts never touches unmanaged profiles and skips tombstones", (t) => {
  const { switcher, openCodexHome } = fixture(t);
  const managedPath = writeProfile(
    switcher,
    "acct-managed",
    codexAuth({ email: "m@example.com", accountId: "acc-m", refreshToken: "rt-m" })
  );
  const unmanagedPath = writeProfile(
    switcher,
    "acct-unmanaged",
    codexAuth({ email: "u@example.com", accountId: "acc-u", refreshToken: "rt-u" })
  );
  // Seed only the managed profile, then delete the unmanaged one from the listing snapshot.
  const managedOnly = listEngineAccounts({ switcher }).filter((account) => account.profileKey === "acct-managed");
  seedEngineAccounts({ openCodexHome, accounts: managedOnly });

  const engineStore = JSON.parse(fs.readFileSync(path.join(openCodexHome, "codex-accounts.json"), "utf8"));
  engineStore["acct-managed"] = { generation: 2, deletedAt: Date.now() };
  fs.writeFileSync(path.join(openCodexHome, "codex-accounts.json"), JSON.stringify(engineStore), { mode: 0o600 });
  const unmanagedBefore = fs.readFileSync(unmanagedPath, "utf8");
  const managedBefore = fs.readFileSync(managedPath, "utf8");

  const result = reverseSyncEngineAccounts({ openCodexHome });

  assert.deepEqual(result.missingEngine, ["acct-managed"]);
  assert.deepEqual(result.synced, []);
  assert.equal(fs.readFileSync(unmanagedPath, "utf8"), unmanagedBefore);
  assert.equal(fs.readFileSync(managedPath, "utf8"), managedBefore);
});

async function withApiFixture(t, handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString("utf8") });
      handler(request, response);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, requests };
}

test("live ops helpers hit the expected management endpoints", async (t) => {
  const { port, requests } = await withApiFixture(t, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });

  await primeAccounts(port);
  await getActiveAccount(port);
  await selectAccount(port, "acct-one");
  await clearCooldown(port, "acct-two");
  await addAccount(port, {
    id: "acct-three",
    email: "three@example.com",
    accessToken: "at",
    refreshToken: "rt",
    chatgptAccountId: "acc-3",
  });

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    [
      "GET /api/codex-auth/accounts?refresh=1",
      "GET /api/codex-auth/active",
      "PUT /api/codex-auth/active",
      "POST /api/codex-auth/accounts/clear-cooldown",
      "POST /api/codex-auth/accounts",
    ]
  );
  assert.deepEqual(JSON.parse(requests[2].body), { accountId: "acct-one" });
  assert.deepEqual(JSON.parse(requests[3].body), { id: "acct-two" });
  assert.equal(JSON.parse(requests[4].body).id, "acct-three");
});

test("live ops surface the engine error status and message", async (t) => {
  const { port } = await withApiFixture(t, (request, response) => {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Manual Codex account import is disabled.", code: "manual_import_disabled" }));
  });

  await assert.rejects(
    addAccount(port, { id: "acct-one", email: "a@example.com", accessToken: "at", refreshToken: "rt", chatgptAccountId: "acc" }),
    (error) => {
      assert.ok(error instanceof CodexAccountBridgeApiError);
      assert.equal(error.status, 403);
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /Manual Codex account import is disabled/);
      return true;
    }
  );
});

test("addAccount rejects an invalid engine id before any HTTP call", async () => {
  await assert.rejects(
    addAccount(1, { id: "bad id!", email: "a@example.com" }),
    (error) => {
      assert.ok(error instanceof CodexAccountBridgeApiError);
      assert.match(error.message, /invalid engine account id/);
      return true;
    }
  );
});
