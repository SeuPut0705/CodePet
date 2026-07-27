"use strict";

// Serving backend facade for Codex Desktop traffic: the OpenCodex engine is the
// default backend and the legacy CodexProxy is the automatic fallback. main.js
// consumes only this interface, so backend selection, drain, grant mirror and
// engine rotation visibility live here instead of spreading across main.js.
//
// Selection flow: start() tries the engine serving lifecycle first; ANY engine
// failure logs and falls back to the legacy proxy (never leaving a half-started
// engine). A proxy failure propagates so the caller can fail closed.

const os = require("node:os");
const path = require("node:path");

const {
  listEngineAccounts,
  normalizeEngineAccountId,
  primeAccounts,
  reverseSyncEngineAccounts,
  selectAccount: bridgeSelectAccount,
  getActiveAccount: bridgeGetActiveAccount,
} = require("./codex-account-bridge");
const { createOpenCodexServingLifecycle } = require("./serving-lifecycle");
const { syncKimiCliCredential } = require("./kimi-credential-adapter");
const { createKimiCredentialResync } = require("./kimi-credential-resync");
const { discoverManagedKimiModels } = require("../kimi-codex-models");

const DEFAULT_STATUS_POLL_MS = 1_000;
const DEFAULT_STOP_DRAIN_MS = 5_000;

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
  proxy,
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
  },
  statusPollMs = DEFAULT_STATUS_POLL_MS,
  stopDrainMs = DEFAULT_STOP_DRAIN_MS,
  createResync = createKimiCredentialResync,
  onAutoSwitch = () => {},
  log = () => {},
} = {}) {
  if (typeof userDataDir !== "string" || userDataDir.length === 0) {
    throw new OpenCodexServingBackendError("OPENCODEX_BACKEND_INVALID_ARGUMENT", "userDataDir is required");
  }
  if (!proxy) {
    throw new OpenCodexServingBackendError("OPENCODEX_BACKEND_INVALID_ARGUMENT", "proxy fallback is required");
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
    startPolling();
    // Watch the engine request log for kimi 401s and re-sync the bridged
    // credential; the engine re-reads auth.json per request, no restart needed.
    kimiResync = createResync({
      port: () => boundPort,
      syncKimiCredential: () => engine.syncKimiCredential(),
      log,
    });
    kimiResync.start();
    log(`OpenCodex engine backend serving on 127.0.0.1:${boundPort}`);
  }

  async function start() {
    if (backend && boundPort) return { backend, port: boundPort };
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        try {
          await startEngine();
        } catch (engineError) {
          log(`OpenCodex engine backend failed (${engineError?.message || engineError}); falling back to legacy proxy`);
          backend = null;
          boundPort = null;
          stopPolling();
          const port = await proxy.start();
          backend = "proxy";
          boundPort = port;
          log(`legacy codex proxy backend serving on 127.0.0.1:${boundPort}`);
        }
        return { backend, port: boundPort };
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }

  async function stop({ timeoutMs } = {}) {
    const current = backend;
    stopPolling();
    if (kimiResync) {
      // The watcher holds an interval; it must be cleared on every exit path.
      kimiResync.stop();
      kimiResync = null;
    }
    if (current === "engine" && lifecycle) {
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
    } else if (current === "proxy") {
      proxy.stop();
    }
    backend = null;
    boundPort = null;
    return { backend: null, port: null };
  }

  async function selectAccount(key) {
    if (backend === "engine" && boundPort) {
      const engineId = accountIdByProfileKey.get(key) ?? normalizeEngineAccountId(key);
      try {
        await bridgeApi.primeAccounts(boundPort);
        await bridgeApi.selectAccount(boundPort, engineId);
        return true;
      } catch (error) {
        log(`engine selectAccount failed for ${key}: ${error?.message || error}`);
        return false;
      }
    }
    if (backend === "proxy") {
      proxy.selectAccount(key);
      return true;
    }
    return false;
  }

  function isWorking() {
    if (backend === "engine") return lastActiveTurns > 0;
    if (backend === "proxy") return proxy.activeConnectionCount > 0;
    return false;
  }

  async function waitForIdle({ timeoutMs = stopDrainMs, pollMs = 250 } = {}) {
    if (backend === "engine" && lifecycle) {
      return lifecycle.waitForIdle({ timeoutMs });
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (backend !== "proxy" || proxy.activeConnectionCount === 0) {
        return { activeTurns: 0, backend };
      }
      if (Date.now() >= deadline) {
        throw new OpenCodexServingBackendError(
          "OPENCODEX_BACKEND_IDLE_TIMEOUT",
          `legacy proxy still has ${proxy.activeConnectionCount} active connection(s) after ${timeoutMs}ms`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async function getStatus() {
    if (backend === "engine" && lifecycle) {
      return { ...(await lifecycle.getStatus()), backend, port: boundPort };
    }
    if (backend === "proxy") {
      return { backend, port: boundPort, running: proxy.running, activeTurns: proxy.activeConnectionCount };
    }
    return { backend: null, port: null, running: false, activeTurns: 0 };
  }

  function onIdle(listener) {
    idleListeners.add(listener);
    if (proxy?.onIdle) {
      // The proxy backend fires its own idle event; the engine path uses polling.
      return proxy.onIdle(listener);
    }
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
