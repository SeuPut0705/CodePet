"use strict";

// Bridge between CodePet's Codex profile store (~/.codepet/codex-switch/profiles/)
// and the embedded OpenCodex engine account pool.
//
// Contract (docs/superpowers/specs/2026-07-28-opencodex-cutover-design.md):
// - At engine boot the pool is seeded from files: credentials go to
//   OPENCODEX_HOME/codex-accounts.json (legacy simple shape; the engine loader
//   normalizes it, vendor/opencodex/src/codex/account-store.ts:63-77) and the
//   caller merges the returned codexAccounts metadata into config.json.
// - Live operations (add/select/prime/clear-cooldown) go through the engine
//   management API, never through config.json edits.
// - The engine owns ChatGPT token refresh and rotates grants. Reverse sync
//   mirrors rotated grants back into the CodePet profile auth.json files so the
//   next seed never resurrects a stale grant.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { atomicWrite } = require("../provider-profile-store");

// Mirror of the engine account id rule (vendor/opencodex/src/codex/auth-api.ts:66).
const ENGINE_ACCOUNT_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

const CODEX_ACCOUNTS_FILE = "codex-accounts.json";
const BRIDGE_STATE_FILE = "codepet-account-bridge.json";
const AUTH_FILE = "auth.json";

class CodexAccountBridgeApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "CodexAccountBridgeApiError";
    this.code = "OPENCODEX_ACCOUNT_API_ERROR";
    this.status = status;
  }
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return {};
  try {
    const payloadPart = token.split(".")[1];
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

// Profile keys are directory names produced by CodexAccountSwitcher.sanitizeProfileName
// (already [a-z0-9._-], <= 72 chars). Normalize defensively anyway: the engine id is
// the stable identity key for codex-accounts.json records, so the mapping must be
// deterministic across restarts.
function normalizeEngineAccountId(profileKey) {
  const raw = String(profileKey || "").trim();
  if (ENGINE_ACCOUNT_ID_RE.test(raw)) return raw;
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
  if (sanitized) return sanitized;
  return `acct-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}

// Two profile keys can normalize to the same engine id (e.g. "User A" and "user-a").
// Keep the first one canonical and suffix later ones with a deterministic hash tag.
function dedupeEngineAccountId(baseId, profileKey, used) {
  if (!used.has(baseId)) {
    used.add(baseId);
    return baseId;
  }
  const suffix = crypto.createHash("sha256").update(String(profileKey)).digest("hex").slice(0, 4);
  const candidate = `${baseId.slice(0, 64 - 5)}-${suffix}`;
  used.add(candidate);
  return candidate;
}

function openAiAuthClaim(auth) {
  const idPayload = decodeJwtPayload(auth?.tokens?.id_token);
  const accessPayload = decodeJwtPayload(auth?.tokens?.access_token);
  return {
    idPayload,
    accessPayload,
    claim: idPayload["https://api.openai.com/auth"] || accessPayload["https://api.openai.com/auth"] || {},
  };
}

// Engine credential shape (account-store.ts isCredential): accessToken, refreshToken,
// expiresAt (ms), chatgptAccountId. Returns null when the auth file cannot populate
// every required field — such a profile is skipped, not seeded half-valid.
function engineCredentialFromAuth(auth, { nowMs = Date.now() } = {}) {
  const accessToken = auth?.tokens?.access_token || auth?.access_token || null;
  const refreshToken = auth?.tokens?.refresh_token || auth?.refresh_token || null;
  const { accessPayload, claim } = openAiAuthClaim(auth);
  const chatgptAccountId =
    auth?.tokens?.account_id ||
    auth?.account_id ||
    claim.chatgpt_account_id ||
    accessPayload.chatgpt_account_id ||
    null;
  if (
    typeof accessToken !== "string" || !accessToken ||
    typeof refreshToken !== "string" || !refreshToken ||
    typeof chatgptAccountId !== "string" || !chatgptAccountId
  ) {
    return null;
  }
  // Same rule as the engine's own account import: trust the JWT exp, fall back to 1h.
  const exp = accessPayload.exp;
  const expiresAt = Number.isFinite(exp) ? exp * 1000 : nowMs + 3_600_000;
  return { accessToken, refreshToken, expiresAt, chatgptAccountId };
}

function engineMetadataFromAuth(auth) {
  const { idPayload, accessPayload, claim } = openAiAuthClaim(auth);
  return {
    email: idPayload.email || accessPayload.email || null,
    plan: claim.chatgpt_plan_type || auth?.plan_type || null,
  };
}

function grantHash(credential) {
  return crypto
    .createHash("sha256")
    .update(`${credential.refreshToken}:${credential.accessToken}`)
    .digest("hex");
}

function readEngineAccountEntry({ profileKey, authPath, used, nowMs }) {
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }
  const credential = engineCredentialFromAuth(auth, { nowMs });
  if (!credential) return null;
  const metadata = engineMetadataFromAuth(auth);
  return {
    id: dedupeEngineAccountId(normalizeEngineAccountId(profileKey), profileKey, used),
    profileKey,
    authPath,
    email: metadata.email,
    plan: metadata.plan,
    credential,
  };
}

// Ordered engine account list for one seed pass. Mirrors listCodexProxyAccounts
// (src/main.js:610-633): profiles with usable auth, active profile first, and a
// single fallback "live" account from ~/.codex/auth.json when no profiles exist.
// Entries later in the array win no tie-breaks: engine pool order IS the config
// codexAccounts order, which is the equal-usage tie-break.
function listEngineAccounts({ switcher, nowMs = Date.now() } = {}) {
  if (!switcher) throw new TypeError("switcher is required");
  const used = new Set();
  const entries = [];
  for (const profile of switcher.listProfiles()) {
    if (!profile.hasAuth) continue;
    const entry = readEngineAccountEntry({
      profileKey: profile.key,
      authPath: path.join(profile.homePath, AUTH_FILE),
      used,
      nowMs,
    });
    if (entry) entries.push(entry);
  }
  const activeKey = switcher.readActiveProfileKey();
  entries.sort(
    (left, right) => Number(right.profileKey === activeKey) - Number(left.profileKey === activeKey)
  );
  if (entries.length === 0) {
    const liveAuthPath = switcher.targetAuthPath;
    if (typeof liveAuthPath === "string" && fs.existsSync(liveAuthPath)) {
      const entry = readEngineAccountEntry({ profileKey: "live", authPath: liveAuthPath, used, nowMs });
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

// Write the engine seed. Returns the codexAccounts metadata array for config.json
// (caller assembles the config) plus the seeded id list. Also persists a bridge
// state file recording which profile/authPath backs each engine id and the grant
// hash at seed time — the reverse-sync conflict guard compares against this.
function seedEngineAccounts({ openCodexHome, accounts, nowMs = Date.now() } = {}) {
  if (!openCodexHome) throw new TypeError("openCodexHome is required");
  const list = Array.isArray(accounts) ? accounts : [];
  const store = {};
  const snapshot = {};
  for (const account of list) {
    store[account.id] = {
      accessToken: account.credential.accessToken,
      refreshToken: account.credential.refreshToken,
      expiresAt: account.credential.expiresAt,
      chatgptAccountId: account.credential.chatgptAccountId,
    };
    snapshot[account.id] = {
      profileKey: account.profileKey,
      authPath: account.authPath,
      grantHash: grantHash(account.credential),
      seededAt: new Date(nowMs).toISOString(),
    };
  }
  atomicWrite(path.join(openCodexHome, CODEX_ACCOUNTS_FILE), store);
  atomicWrite(path.join(openCodexHome, BRIDGE_STATE_FILE), { version: 1, accounts: snapshot });
  return {
    codexAccounts: list.map((account) => ({
      id: account.id,
      // The engine type marks email as required; fall back to the profile key so
      // log labels and collision checks still have a stable printable value.
      email: account.email ?? account.profileKey,
      isMain: false,
      ...(account.plan ? { plan: account.plan } : {}),
    })),
    seeded: list.map((account) => account.id),
  };
}

function readBridgeState(openCodexHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(openCodexHome, BRIDGE_STATE_FILE), "utf8"));
    return parsed && typeof parsed === "object" && parsed.accounts ? parsed : null;
  } catch {
    return null;
  }
}

// Read the engine store in either shape: legacy bare credentials or normalized
// records ({credential, generation, deletedAt, ...}). Tombstoned ids are skipped.
function readEngineAccountCredentials(openCodexHome) {
  const raw = JSON.parse(fs.readFileSync(path.join(openCodexHome, CODEX_ACCOUNTS_FILE), "utf8"));
  const credentials = {};
  for (const [id, value] of Object.entries(raw)) {
    if (value?.deletedAt != null) continue;
    const candidate = value?.credential ?? value;
    if (
      candidate &&
      typeof candidate.accessToken === "string" &&
      typeof candidate.refreshToken === "string" &&
      Number.isFinite(candidate.expiresAt) &&
      typeof candidate.chatgptAccountId === "string"
    ) {
      credentials[id] = candidate;
    }
  }
  return credentials;
}

// Mirror engine-side grant rotations back into the CodePet profiles.
//
// Conflict guard (compare-and-skip): a profile is only rewritten when its CURRENT
// grant hash equals the hash captured at seed time. A profile whose auth.json
// changed since the seed (user re-login, manual edit, account switcher write) is
// left untouched and reported as skippedConflict — the human's newer file always
// wins over the engine's older rotation. Profiles the engine does not manage
// (absent from the bridge state) are never touched.
function reverseSyncEngineAccounts({ openCodexHome, nowMs = Date.now() } = {}) {
  const result = {
    synced: [],
    unchanged: [],
    skippedConflict: [],
    missingEngine: [],
    missingProfile: [],
  };
  const state = readBridgeState(openCodexHome);
  if (!state) return result;
  let engineCredentials;
  try {
    engineCredentials = readEngineAccountCredentials(openCodexHome);
  } catch {
    return result;
  }

  let stateDirty = false;
  for (const [id, managed] of Object.entries(state.accounts)) {
    const engineCredential = engineCredentials[id];
    if (!engineCredential) {
      result.missingEngine.push(id);
      continue;
    }
    const engineHash = grantHash(engineCredential);
    if (engineHash === managed.grantHash) {
      result.unchanged.push(id);
      continue;
    }
    let auth;
    try {
      auth = JSON.parse(fs.readFileSync(managed.authPath, "utf8"));
    } catch {
      result.missingProfile.push(id);
      continue;
    }
    const currentCredential = engineCredentialFromAuth(auth, { nowMs });
    if (!currentCredential || grantHash(currentCredential) !== managed.grantHash) {
      result.skippedConflict.push(id);
      continue;
    }
    const next = {
      ...auth,
      tokens: {
        ...auth.tokens,
        access_token: engineCredential.accessToken,
        refresh_token: engineCredential.refreshToken,
      },
      last_refresh: new Date(nowMs).toISOString(),
    };
    atomicWrite(managed.authPath, next);
    managed.grantHash = engineHash;
    managed.syncedAt = new Date(nowMs).toISOString();
    stateDirty = true;
    result.synced.push(id);
  }
  if (stateDirty) {
    atomicWrite(path.join(openCodexHome, BRIDGE_STATE_FILE), state);
  }
  return result;
}

async function callEngineApi(port, { method, apiPath, body, timeoutMs = 5_000, fetchImpl = fetch }) {
  const response = await fetchImpl(`http://127.0.0.1:${port}${apiPath}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = "";
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.error === "string") detail = `: ${parsed.error}`;
    } catch {
      // Non-JSON error bodies carry no actionable detail.
    }
    throw new CodexAccountBridgeApiError(
      response.status,
      `engine API ${method} ${apiPath} failed with HTTP ${response.status}${detail}`
    );
  }
  return text ? JSON.parse(text) : null;
}

// Live management operations. The engine picks up codex-accounts.json file changes
// on its own; these cover the operations that only the live config can serve.

function primeAccounts(port, options = {}) {
  return callEngineApi(port, { method: "GET", apiPath: "/api/codex-auth/accounts?refresh=1", ...options });
}

function getActiveAccount(port, options = {}) {
  return callEngineApi(port, { method: "GET", apiPath: "/api/codex-auth/active", ...options });
}

function selectAccount(port, id, options = {}) {
  return callEngineApi(port, { method: "PUT", apiPath: "/api/codex-auth/active", body: { accountId: id }, ...options });
}

function clearCooldown(port, id, options = {}) {
  return callEngineApi(port, {
    method: "POST",
    apiPath: "/api/codex-auth/accounts/clear-cooldown",
    body: { id },
    ...options,
  });
}

// Adding requires OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT=1 in the worker env and
// passes a live ChatGPT warmup. Token updates for existing ids must go through a
// codex-accounts.json seed/file write instead — this endpoint rejects known ids.
function addAccount(port, account, options = {}) {
  if (!ENGINE_ACCOUNT_ID_RE.test(String(account?.id || ""))) {
    return Promise.reject(
      new CodexAccountBridgeApiError(400, `invalid engine account id: ${String(account?.id)}`)
    );
  }
  return callEngineApi(port, { method: "POST", apiPath: "/api/codex-auth/accounts", body: account, ...options });
}

module.exports = {
  CodexAccountBridgeApiError,
  ENGINE_ACCOUNT_ID_RE,
  addAccount,
  clearCooldown,
  engineCredentialFromAuth,
  getActiveAccount,
  listEngineAccounts,
  normalizeEngineAccountId,
  primeAccounts,
  reverseSyncEngineAccounts,
  seedEngineAccounts,
  selectAccount,
};
