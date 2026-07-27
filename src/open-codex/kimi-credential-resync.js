"use strict";

// Kimi 401 credential resync watcher.
//
// The engine has no hook for upstream Kimi 401s, but every request is recorded
// in its request log (GET /api/logs, filterable by provider/status — vendor
// request-log.ts:78-112 + management/logs-usage-routes.ts:113-116). This watcher
// polls the log, and on any FRESH kimi 401 calls the CodePet credential re-sync
// (auth.json is re-read by the engine per request, so the next turn picks the
// new token up with no restart). If 401s keep appearing after several re-syncs,
// it escalates once: at that point only a Kimi CLI re-login can help.

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_ESCALATE_AFTER = 3;

function createKimiCredentialResync({
  port,
  syncKimiCredential,
  fetchImpl = fetch,
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  escalateAfter = DEFAULT_ESCALATE_AFTER,
  log = () => {},
  escalateLog = log,
} = {}) {
  if (typeof syncKimiCredential !== "function") {
    throw new TypeError("syncKimiCredential is required");
  }
  const resolvePort = typeof port === "function" ? port : () => port;
  let timer = null;
  let inFlight = false;
  let lastSeenAt = 0;
  let consecutive401Polls = 0;
  let escalated = false;

  // Kimi auth failures surface in several log shapes: plain 401s, combo parents
  // (provider "combo" with the kimi attempt nested), and WS turns where the parent
  // can be classified as a generic error while the attempt carries the real 401.
  // Match on the entry OR any attempt: status 401 or the auth error code.
  function isKimiAuthFailure(entry) {
    if (!entry || typeof entry !== "object") return false;
    if (entry.status === 401 || entry.errorCode === "invalid_api_key") return true;
    const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
    return attempts.some((attempt) => attempt?.status === 401 || attempt?.errorCode === "invalid_api_key");
  }

  async function checkOnce(now = Date.now()) {
    const currentPort = resolvePort();
    if (!currentPort) return { fresh401: 0, synced: false };
    const response = await fetchImpl(
      `http://127.0.0.1:${currentPort}/api/logs?provider=kimi&tail=50`,
      { signal: AbortSignal.timeout(timeoutMs) }
    );
    if (!response.ok) return { fresh401: 0, synced: false };
    const entries = await response.json();
    const fresh = (Array.isArray(entries) ? entries : [])
      .filter(isKimiAuthFailure)
      .filter((entry) => Number.isFinite(entry?.timestamp) && entry.timestamp > lastSeenAt);
    if (fresh.length === 0) {
      lastSeenAt = Math.max(lastSeenAt, now);
      consecutive401Polls = 0;
      escalated = false;
      return { fresh401: 0, synced: false };
    }

    lastSeenAt = Math.max(...fresh.map((entry) => entry.timestamp));
    consecutive401Polls += 1;
    let syncStatus = "unknown";
    try {
      const result = await syncKimiCredential();
      syncStatus = result?.status ?? "unknown";
    } catch (error) {
      syncStatus = `failed: ${error?.message || error}`;
    }
    log(`kimi 401 observed in engine log (${fresh.length} new); credential re-sync: ${syncStatus}`);
    if (consecutive401Polls >= escalateAfter && !escalated) {
      escalated = true;
      escalateLog(
        `kimi 401 persists after ${consecutive401Polls} credential re-syncs; Kimi CLI re-login is likely required`
      );
    }
    return { fresh401: fresh.length, synced: true };
  }

  function start() {
    if (timer) return;
    lastSeenAt = Date.now();
    consecutive401Polls = 0;
    escalated = false;
    timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      checkOnce().catch(() => {}).finally(() => {
        inFlight = false;
      });
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, checkOnce };
}

module.exports = { createKimiCredentialResync };
