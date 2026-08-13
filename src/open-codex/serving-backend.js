"use strict";

// Serving backend facade for Codex Desktop traffic: the embedded OpenCodex
// engine is the only backend. main.js consumes only this interface, so engine
// lifecycle, drain, grant mirror and rotation visibility live here instead of
// spreading across main.js.
//
// Failure contract: any engine start failure propagates so the caller can
// fail closed (config rollback + full stop). There is no fallback backend.

const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs");

const {
  listEngineAccounts,
  normalizeEngineAccountId,
  primeAccounts,
  reverseSyncEngineAccounts,
  seedEngineAccounts,
  selectAccount: bridgeSelectAccount,
  getActiveAccount: bridgeGetActiveAccount,
  addAccount: bridgeAddAccount,
} = require("./codex-account-bridge");
const { createOpenCodexServingLifecycle } = require("./serving-lifecycle");
const { syncKimiCliCredential } = require("./kimi-credential-adapter");
const { createKimiCredentialResync } = require("./kimi-credential-resync");
const { discoverManagedKimiModels } = require("../kimi-codex-models");

const DEFAULT_STATUS_POLL_MS = 1_000;
const DEFAULT_STOP_DRAIN_MS = 5_000;
const DEFAULT_KIMI_SYNC_INTERVAL_MS = 90_000;
const DEFAULT_PRIME_TIMEOUT_MS = 10_000;

class OpenCodexServingBackendError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenCodexServingBackendError";
    this.code = code;
  }
}

function createOpenCodexServingBackend({
  userDataDir,
  enginePath,
  codexAccountSwitcher,
  discoverKimiModels = discoverManagedKimiModels,
  workerEnv = process.env,
  kimiHome = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"),
  createLifecycle = createOpenCodexServingLifecycle,
  listAccounts = listEngineAccounts,
  seedAccounts,
  syncKimiCredential = syncKimiCliCredential,
  reverseSync = reverseSyncEngineAccounts,
  bridgeApi = {
    primeAccounts,
    selectAccount: bridgeSelectAccount,
    getActiveAccount: bridgeGetActiveAccount,
    addAccount: bridgeAddAccount,
  },
  statusPollMs = DEFAULT_STATUS_POLL_MS,
  stopDrainMs = DEFAULT_STOP_DRAIN_MS,
  createResync = createKimiCredentialResync,
  kimiSyncIntervalMs = DEFAULT_KIMI_SYNC_INTERVAL_MS,
  primeTimeoutMs = DEFAULT_PRIME_TIMEOUT_MS,
  onAutoSwitch = () => {},
  log = () => {},
} = {}) {
  if (typeof userDataDir !== "string" || userDataDir.length === 0) {
    throw new OpenCodexServingBackendError("OPENCODEX_BACKEND_INVALID_ARGUMENT", "userDataDir is required");
  }

  const openCodexHome = path.join(userDataDir, "opencodex");
  let backend = null;
  let boundPort = null;
  let lifecycle = null;
  let startPromise = null;
  let accountIdByProfileKey = new Map();
  let profileKeyByEngineId = new Map();
  const idleListeners = new Set();

  // Engine activeTurns is only available asynchronously; keep a cached count so
  // the synchronous isWorking() the shutdown coordinator needs stays cheap.
  let pollTimer = null;
  let pollInFlight = false;
  let lastActiveTurns = 0;
  let sawActiveTurns = false;
  let kimiResync = null;
  let kimiSyncTimer = null;
  let kimiSyncInFlight = false;
  let lastKimiSourceFingerprint = null;

  // The Kimi CLI access token lives ~900s; the engine's copy in auth.json goes
  // stale within one app session. Re-sync periodically — but skip the write when
  // the CLI credential file is byte-identical to the last tick (the common case).
  function kimiSourceFingerprint() {
    try {
      return crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(kimiHome, "credentials", "kimi-code.json")))
        .digest("hex");
    } catch {
      return null;
    }
  }

  async function periodicKimiSyncTick() {
    if (!lifecycle || backend !== "engine") return;
    const fingerprint = kimiSourceFingerprint();
    if (fingerprint !== null && fingerprint === lastKimiSourceFingerprint) return;
    try {
      const result = await lifecycle.syncKimiCredential();
      lastKimiSourceFingerprint = fingerprint;
      log(`periodic kimi credential re-sync: ${result?.status ?? "unknown"}`);
    } catch (error) {
      // Keep lastKimiSourceFingerprint so a transient failure retries next tick.
      log(`periodic kimi credential re-sync failed: ${error?.message || error}`);
    }
  }

  function startKimiSyncTimer() {
    stopKimiSyncTimer();
    kimiSyncTimer = setInterval(() => {
      if (kimiSyncInFlight) return;
      kimiSyncInFlight = true;
      periodicKimiSyncTick().catch(() => {}).finally(() => {
        kimiSyncInFlight = false;
      });
    }, kimiSyncIntervalMs);
    kimiSyncTimer.unref?.();
  }

  function stopKimiSyncTimer() {
    if (kimiSyncTimer) clearInterval(kimiSyncTimer);
    kimiSyncTimer = null;
    kimiSyncInFlight = false;
  }

  function fireIdle() {
    for (const listener of idleListeners) {
      try {
        listener();
      } catch {
        // Listener failures must not break engine status polling.
      }
    }
  }

  // Engine-side rotation happens inside the pool; CodePet only learns about it
  // by asking. Checked on every working -> idle transition so the tray and the
  // profile store can mirror the account the engine actually settled on.
  async function checkEngineRotation() {
    try {
      const active = await bridgeApi.getActiveAccount(boundPort);
      const engineId = active?.activeCodexAccountId;
      if (!engineId) return;
      const profileKey = profileKeyByEngineId.get(engineId);
      if (!profileKey || profileKey === "live") return;
      const currentKey = codexAccountSwitcher?.readActiveProfileKey?.() ?? null;
      if (profileKey === currentKey) return;
      onAutoSwitch({ profileKey, engineId });
    } catch (error) {
      log(`engine rotation check failed: ${error?.message || error}`);
    }
  }

  async function pollOnce() {
    if (pollInFlight || backend !== "engine" || !lifecycle) return;
    pollInFlight = true;
    try {
      const status = await lifecycle.getStatus();
      lastActiveTurns = status.activeTurns ?? 0;
      if (lastActiveTurns > 0) {
        sawActiveTurns = true;
      } else if (sawActiveTurns) {
        sawActiveTurns = false;
        fireIdle();
        await checkEngineRotation();
      }
    } catch {
      // A failed poll is transient; the next tick retries.
    } finally {
      pollInFlight = false;
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      void pollOnce();
    }, statusPollMs);
    pollTimer.unref?.();
    void pollOnce();
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    lastActiveTurns = 0;
    sawActiveTurns = false;
  }

  async function listAndIndexAccounts() {
    const entries = await listAccounts({ switcher: codexAccountSwitcher });
    accountIdByProfileKey = new Map(entries.map((entry) => [entry.profileKey, entry.id]));
    profileKeyByEngineId = new Map(entries.map((entry) => [entry.id, entry.profileKey]));
    return entries;
  }

  function ensureLifecycle() {
    if (lifecycle) return lifecycle;
    lifecycle = createLifecycle({
      openCodexHome,
      enginePath,
      listAccounts: listAndIndexAccounts,
      discoverKimiModels,
      seedAccounts,
      syncKimiCredential: ({ openCodexHome: home, ...rest } = {}) =>
        syncKimiCredential({ kimiHome, openCodexHome: home, ...rest }),
      workerEnv,
      log,
    });
    return lifecycle;
  }

  async function startEngine() {
    const engine = ensureLifecycle();
    await engine.start();
    backend = "engine";
    boundPort = engine.port();
    // Prime pool quotas before declaring readiness: unprimed accounts score 100
    // (unknown) and the auto-switch threshold flip-flops rotation on early requests.
    // Best effort — a slow usage endpoint must not hold startup hostage.
    try {
      await bridgeApi.primeAccounts(boundPort, { timeoutMs: primeTimeoutMs });
    } catch (error) {
      log(`quota prime after engine start failed (continuing): ${error?.message || error}`);
    }
    startPolling();
    // Watch the engine request log for kimi 401s and re-sync the bridged
    // credential; the engine re-reads auth.json per request, no restart needed.
    kimiResync = createResync({
      port: () => boundPort,
      syncKimiCredential: () => engine.syncKimiCredential(),
      log,
    });
    kimiResync.start();
    startKimiSyncTimer();
    log(`OpenCodex engine backend serving on 127.0.0.1:${boundPort}`);
  }

  async function start() {
    if (backend && boundPort) return { backend, port: boundPort };
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        await startEngine();
        return { backend, port: boundPort };
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }

  async function stop({ timeoutMs } = {}) {
    stopPolling();
    stopKimiSyncTimer();
    if (kimiResync) {
      // The watcher holds an interval; it must be cleared on every exit path.
      kimiResync.stop();
      kimiResync = null;
    }
    if (backend === "engine" && lifecycle) {
      try {
        await lifecycle.waitForIdle({ timeoutMs: stopDrainMs });
      } catch (error) {
        log(`serving drain wait failed (continuing to stop): ${error?.message || error}`);
      }
      try {
        await lifecycle.stop({ timeoutMs });
      } finally {
        // The engine owns ChatGPT refresh and rotates grants while it runs; mirror
        // the final state back into the CodePet profiles once it is fully stopped.
        try {
          const result = await reverseSync({ openCodexHome });
          log(
            `engine grant reverse-sync: synced=${result.synced.length}`
            + ` unchanged=${result.unchanged.length} conflict=${result.skippedConflict.length}`
          );
        } catch (error) {
          log(`engine grant reverse-sync failed: ${error?.message || error}`);
        }
      }
    }
    backend = null;
    boundPort = null;
    return { backend: null, port: null };
  }

  // A profile added after engine start is unknown to the in-memory pool.
  // Re-seed the credentials file (read live per request), import the account
  // through the management API, then retry the selection once.
  async function reseedAndSelectAccount(key) {
    const entries = await listAndIndexAccounts();
    const entry = entries.find((candidate) => candidate.profileKey === key);
    if (!entry) return false;
    const seed = seedAccounts
      ? (accounts) => seedAccounts({ openCodexHome, accounts })
      : (accounts) => seedEngineAccounts({ openCodexHome, accounts });
    await seed(entries);
    await bridgeApi.addAccount(boundPort, entry);
    await bridgeApi.primeAccounts(boundPort);
    await bridgeApi.selectAccount(boundPort, entry.id);
    return true;
  }

  async function selectAccount(key) {
    if (backend !== "engine" || !boundPort) return false;
    const engineId = accountIdByProfileKey.get(key) ?? normalizeEngineAccountId(key);
    try {
      await bridgeApi.primeAccounts(boundPort);
      await bridgeApi.selectAccount(boundPort, engineId);
      return true;
    } catch (firstError) {
      try {
        const ok = await reseedAndSelectAccount(key);
        if (ok) log(`engine selectAccount succeeded after re-seed for ${key}`);
        return ok;
      } catch (error) {
        log(`engine selectAccount failed for ${key}: ${error?.message || error} (first: ${firstError?.message || firstError})`);
        return false;
      }
    }
  }

  function isWorking() {
    return backend === "engine" && lastActiveTurns > 0;
  }

  async function waitForIdle({ timeoutMs = stopDrainMs } = {}) {
    if (backend === "engine" && lifecycle) {
      return lifecycle.waitForIdle({ timeoutMs });
    }
    return { activeTurns: 0, backend };
  }

  async function getStatus() {
    if (backend === "engine" && lifecycle) {
      return { ...(await lifecycle.getStatus()), backend, port: boundPort };
    }
    return { backend: null, port: null, running: false, activeTurns: 0 };
  }

  function onIdle(listener) {
    idleListeners.add(listener);
    return () => idleListeners.delete(listener);
  }

  return {
    start,
    stop,
    selectAccount,
    isWorking,
    waitForIdle,
    getStatus,
    onIdle,
    backend: () => backend,
    port: () => boundPort,
  };
}

module.exports = {
  OpenCodexServingBackendError,
  createOpenCodexServingBackend,
};
