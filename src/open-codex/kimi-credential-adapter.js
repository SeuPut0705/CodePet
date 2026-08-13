"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_KIMI_HOME = path.join(os.homedir(), ".kimi-code");
const IMPORTED_ACCOUNT_ID = "codepet-kimi-cli";
const KIMI_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const OPEN_CODEX_REFRESH_SKEW_MS = 60 * 1000;

class OpenCodexCredentialSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenCodexCredentialSyncError";
    this.code = code;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function identityFromKimiTokens(accessToken, refreshToken) {
  const access = decodeJwtPayload(accessToken);
  const refresh = refreshToken ? decodeJwtPayload(refreshToken) : undefined;
  const accountId =
    nonEmptyString(access?.user_id) ||
    nonEmptyString(refresh?.user_id) ||
    nonEmptyString(access?.sub) ||
    nonEmptyString(refresh?.sub);
  const email = (nonEmptyString(access?.email) || nonEmptyString(refresh?.email))?.toLowerCase();
  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  };
}

function parseKimiCliCredential(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!nonEmptyString(raw.access_token)) return null;
  if (typeof raw.refresh_token !== "string") return null;
  if (!Number.isFinite(raw.expires_at) || raw.expires_at < 0) return null;
  if (!Number.isFinite(raw.expires_in) || raw.expires_in < 0) return null;
  if (typeof raw.scope !== "string" || !nonEmptyString(raw.token_type)) return null;
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: raw.expires_at * 1000 - KIMI_EXPIRY_SKEW_MS,
  };
}

function isCredential(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.access === "string" &&
    typeof value.refresh === "string" &&
    Number.isFinite(value.expires)
  );
}

function stableLegacyAccountId(credential) {
  const identity = credential.accountId || credential.email || credential.refresh;
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 8);
}

function normalizeKimiAccountSet(value) {
  if (value === undefined) return { activeAccountId: null, accounts: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Array.isArray(value.accounts)) {
    if (value.accounts.length === 0) return null;
    const accounts = value.accounts.map((account) => {
      if (
        !account ||
        typeof account !== "object" ||
        Array.isArray(account) ||
        !nonEmptyString(account.id) ||
        !isCredential(account.credential)
      ) return null;
      return { ...account, credential: { ...account.credential } };
    });
    if (accounts.some((account) => account === null)) return null;
    const activeAccountId = accounts.some((account) => account.id === value.activeAccountId)
      ? value.activeAccountId
      : accounts[0].id;
    return { ...value, activeAccountId, accounts };
  }
  if (!isCredential(value)) return null;
  const id = stableLegacyAccountId(value);
  return {
    activeAccountId: id,
    accounts: [{ id, credential: { ...value } }],
  };
}

function readJson(file, { missing = null } = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return missing;
    throw error;
  }
}

function hardenDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the OS. */ }
}

function atomicWriteText(file, contents) {
  hardenDirectory(path.dirname(file));
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs are managed by the OS. */ }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function readDeviceId(kimiHome) {
  try {
    const value = fs.readFileSync(path.join(kimiHome, "device_id"), "utf8").trim();
    if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function removeImportedCredential(openCodexHome) {
  const authPath = path.join(openCodexHome, "auth.json");
  let store;
  try {
    store = readJson(authPath);
  } catch {
    return false;
  }
  if (!store || typeof store !== "object" || Array.isArray(store)) return false;
  const accountSet = normalizeKimiAccountSet(store.kimi);
  if (!accountSet) return false;
  const remaining = accountSet.accounts.filter((account) => account.id !== IMPORTED_ACCOUNT_ID);
  if (remaining.length === accountSet.accounts.length) return false;
  if (remaining.length === 0) {
    delete store.kimi;
  } else {
    accountSet.accounts = remaining;
    if (!remaining.some((account) => account.id === accountSet.activeAccountId)) {
      accountSet.activeAccountId = remaining[0].id;
    }
    store.kimi = accountSet;
  }
  atomicWriteText(authPath, `${JSON.stringify(store, null, 2)}\n`);
  try { fs.rmSync(path.join(openCodexHome, "kimi-device-id"), { force: true }); } catch { /* best effort */ }
  return true;
}

function syncKimiCliCredential({
  kimiHome = process.env.KIMI_CODE_HOME || DEFAULT_KIMI_HOME,
  openCodexHome,
  nowMilliseconds = () => Date.now(),
} = {}) {
  if (!nonEmptyString(openCodexHome)) {
    throw new OpenCodexCredentialSyncError(
      "OPENCODEX_CREDENTIAL_SYNC_INVALID_ARGUMENT",
      "OpenCodex credential destination is required"
    );
  }

  const sourcePath = path.join(kimiHome, "credentials", "kimi-code.json");
  let rawCredential;
  try {
    rawCredential = readJson(sourcePath);
  } catch {
    removeImportedCredential(openCodexHome);
    return { reason: "invalid", status: "unavailable" };
  }
  if (rawCredential === null) {
    removeImportedCredential(openCodexHome);
    return { reason: "missing", status: "unavailable" };
  }
  const source = parseKimiCliCredential(rawCredential);
  if (!source) {
    removeImportedCredential(openCodexHome);
    return { reason: "invalid", status: "unavailable" };
  }
  if (source.expiresAt <= nowMilliseconds() + OPEN_CODEX_REFRESH_SKEW_MS) {
    removeImportedCredential(openCodexHome);
    return { reason: "expired", status: "unavailable" };
  }

  const authPath = path.join(openCodexHome, "auth.json");
  let store;
  try {
    store = readJson(authPath, { missing: {} });
  } catch {
    throw new OpenCodexCredentialSyncError(
      "OPENCODEX_AUTH_STORE_INVALID",
      "OpenCodex credential store is invalid and was preserved"
    );
  }
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new OpenCodexCredentialSyncError(
      "OPENCODEX_AUTH_STORE_INVALID",
      "OpenCodex credential store is invalid and was preserved"
    );
  }
  const accountSet = normalizeKimiAccountSet(store.kimi);
  if (!accountSet) {
    throw new OpenCodexCredentialSyncError(
      "OPENCODEX_AUTH_STORE_INVALID",
      "OpenCodex Kimi credential store is invalid and was preserved"
    );
  }

  const identity = identityFromKimiTokens(source.accessToken, source.refreshToken);
  const credential = {
    access: source.accessToken,
    // Kimi CLI remains the only refresh-token owner. Two independent stores rotating the
    // same grant can invalidate each other and break the already-running CodePet proxy.
    refresh: "",
    expires: source.expiresAt,
    ...identity,
    source: "local-cli",
  };
  // Only mutate CodePet's reserved slot. A native OpenCodex login with the same human
  // identity may have its own valid refresh lineage and must remain user-owned.
  let account = accountSet.accounts.find((candidate) => candidate.id === IMPORTED_ACCOUNT_ID);
  if (account) {
    account.credential = credential;
    delete account.needsReauth;
  } else {
    account = {
      id: IMPORTED_ACCOUNT_ID,
      alias: "Kimi Code CLI",
      credential,
      addedAt: nowMilliseconds(),
    };
    accountSet.accounts.push(account);
  }
  accountSet.activeAccountId = account.id;
  store.kimi = accountSet;

  atomicWriteText(authPath, `${JSON.stringify(store, null, 2)}\n`);
  const deviceId = readDeviceId(kimiHome);
  if (deviceId) atomicWriteText(path.join(openCodexHome, "kimi-device-id"), `${deviceId}\n`);

  return {
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
    deviceIdCopied: Boolean(deviceId),
    status: "synced",
  };
}

module.exports = {
  OpenCodexCredentialSyncError,
  identityFromKimiTokens,
  syncKimiCliCredential,
};
