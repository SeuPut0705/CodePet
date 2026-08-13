const fs = require("node:fs");
const { atomicWrite } = require("./provider-profile-store");

// ChatGPT OAuth token refresh for Codex auth.json files.
// Used by the account switcher for profiles outside the engine pool.

const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Public OAuth client id of the Codex CLI (same value opencodex uses).
const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return {};
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = part.padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function accessTokenExpiresAtMs(accessToken) {
  const exp = Number(decodeJwtPayload(accessToken).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

// Refreshes auth.json's access_token with the refresh_token when it expires
// soon, and persists the file atomically. On failure the original tokens are
// returned unchanged (the server makes the final call).
async function refreshAuthFileIfStale(authPath, { marginMs = 120000, fetchImpl = fetch } = {}) {
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }
  const tokens = auth?.tokens || {};
  if (!tokens.access_token) return auth;

  const expiresAt = accessTokenExpiresAtMs(tokens.access_token);
  if (!tokens.refresh_token || !expiresAt || expiresAt > Date.now() + marginMs) return auth;

  try {
    const response = await fetchImpl(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CHATGPT_CLIENT_ID,
        refresh_token: tokens.refresh_token,
      }),
    });
    if (!response.ok) throw new Error(`token refresh HTTP ${response.status}`);
    const data = await response.json();
    auth.tokens = {
      ...tokens,
      access_token: data.access_token || tokens.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      id_token: data.id_token || tokens.id_token,
    };
    auth.last_refresh = new Date().toISOString();
    // atomicWrite: 0o600 perms + collision-safe temp file + cleanup on failure.
    // auth.json carries tokens, so this matters.
    atomicWrite(authPath, auth);
  } catch {
    // Fall through and try with the existing token.
  }
  return auth;
}

module.exports = {
  CHATGPT_CLIENT_ID,
  accessTokenExpiresAtMs,
  refreshAuthFileIfStale,
};
