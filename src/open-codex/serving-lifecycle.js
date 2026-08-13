"use strict";

// Serving-mode OpenCodex engine lifecycle: owns the engine that serves Codex
// Desktop traffic on a fixed loopback port, replacing codex-proxy.
//
// Design contract (docs/superpowers/specs/2026-07-28-opencodex-cutover-design.md):
// - config.json is written ONCE before the engine starts; afterwards the file is
//   engine-owned (the engine rewrites it for migrations, activeCodexAccountId and
//   seeds). This module never touches it while a host is running. Rewrites on a
//   later (fully stopped) start are safe because we always write
//   openaiProviderTierVersion: 2, which skips the tier migration and its backup
//   collision check entirely.
// - Accounts are seeded from files before start (codex-account-bridge); live
//   operations go through the management API, not config edits.
// - CODEX_HOME is an isolated directory under the serving home, NOT the real
//   ~/.codex: the engine treats CODEX_HOME/auth.json as a read-only "main" pool
//   member (vendor/opencodex/src/codex/auth-context.ts:208-223) and keeps runtime
//   state there. An isolated home keeps the user's live Codex login out of the
//   pool and the engine's state out of the user's Codex directory.

const fs = require("node:fs");
const path = require("node:path");

const { createEngineHost } = require("./engine-host");
const { seedEngineAccounts } = require("./codex-account-bridge");
const { atomicWriteText } = require("../provider-profile-store");

const DEFAULT_SERVING_PORTS = Object.freeze(
  Array.from({ length: 10 }, (_value, index) => 10_161 + index)
);
const DEFAULT_IDLE_POLL_MS = 250;

// CodePet Kimi slug -> engine-side kimi model id.
// Evidence (vendor/opencodex/src/providers/registry.ts):
// - "k3[1m]": KIMI_CODING_K3_MODELS = ["k3", "k3[1m]"] (registry.ts:268); the
//   [1m] alias advertises the 1M context ceiling and is stripped to bare "k3"
//   before the upstream request (registry.ts:260-268, modelSuffixBracketStrip).
// - "k3": bare k3 advertises the Moderato 256K ceiling (registry.ts:266).
// - "kimi-for-coding": member of KIMI_CODING_MODELS (registry.ts:271).
// - "kimi-for-coding-highspeed": NOT in the registry. Combo targets are only
//   provider-validated (combos/types.ts:208-228) and the slash-namespace router
//   passes unknown native ids through unchanged (router.ts:333-341), so the
//   upstream receives the exact id today's codex-proxy sends.
const KIMI_ENGINE_MODEL_BY_SLUG = Object.freeze({
  "codepet-kimi-k3": "k3[1m]",
  "codepet-kimi-k3-256k": "k3",
  "codepet-kimi-k2-7-coding": "kimi-for-coding",
  "codepet-kimi-k2-7-coding-fast": "kimi-for-coding-highspeed",
});

class OpenCodexServingLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenCodexServingLifecycleError";
    this.code = code;
  }
}

function buildKimiCombos(kimiModels) {
  const combos = {};
  for (const model of kimiModels ?? []) {
    const engineModel = KIMI_ENGINE_MODEL_BY_SLUG[model?.slug];
    if (!engineModel) {
      throw new OpenCodexServingLifecycleError(
        "OPENCODEX_SERVING_UNKNOWN_KIMI_SLUG",
        `No engine model mapping for managed Kimi slug "${model?.slug}".`
        + ` Known slugs: ${Object.keys(KIMI_ENGINE_MODEL_BY_SLUG).join(", ")}`
      );
    }
    combos[model.slug] = {
      alias: model.slug,
      targets: [{ provider: "kimi", model: engineModel }],
    };
  }
  return combos;
}

// Pure config builder (exported for tests). codexAccounts comes from the bridge
// seed; combos map each managed Kimi slug to its engine model.
function buildServingConfig({ port, codexAccounts = [], kimiModels = [] } = {}) {
  return {
    port,
    hostname: "127.0.0.1",
    openaiProviderTierVersion: 2,
    defaultProvider: "openai",
    websockets: true,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
      kimi: {
        adapter: "openai-chat",
        baseUrl: "https://api.kimi.com/coding/v1",
        authMode: "oauth",
      },
    },
    codexAccounts,
    combos: buildKimiCombos(kimiModels),
  };
}

function isAddrInUseError(error) {
  const code = error?.code;
  if (code === "EADDRINUSE") return true;
  const text = String(error?.message ?? "").toLowerCase();
  return text.includes("eaddrinuse") || text.includes("address already in use");
}

function createOpenCodexServingLifecycle({
  openCodexHome,
  enginePath = path.join(__dirname, "..", "..", "build", "generated", "opencodex-engine.mjs"),
  createHost = createEngineHost,
  listAccounts,
  discoverKimiModels = () => [],
  seedAccounts = seedEngineAccounts,
  syncKimiCredential,
  ports = DEFAULT_SERVING_PORTS,
  workerEnv = process.env,
  startupTimeoutMs,
  stopTimeoutMs = 30_000,
  writeConfigAtomic = (file, value) => atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`),
  log = () => {},
} = {}) {
  if (typeof openCodexHome !== "string" || openCodexHome.length === 0) {
    throw new OpenCodexServingLifecycleError(
      "OPENCODEX_SERVING_INVALID_ARGUMENT",
      "openCodexHome is required"
    );
  }
  if (typeof listAccounts !== "function") {
    throw new OpenCodexServingLifecycleError(
      "OPENCODEX_SERVING_INVALID_ARGUMENT",
      "listAccounts is required"
    );
  }
  if (typeof syncKimiCredential !== "function") {
    throw new OpenCodexServingLifecycleError(
      "OPENCODEX_SERVING_INVALID_ARGUMENT",
      "syncKimiCredential is required"
    );
  }

  const codexHome = path.join(openCodexHome, "codex-home");
  const candidatePorts = [...ports];
  let host = null;
  let boundPort = null;
  let startPromise = null;
  let status = { state: "stopped", port: null };

  async function prepare() {
    fs.mkdirSync(codexHome, { recursive: true });
    const accounts = await listAccounts();
    const kimiModels = (await discoverKimiModels()) ?? [];
    // Validate combos first: an unknown Kimi slug must fail before any file is written.
    buildKimiCombos(kimiModels);
    const seeded = await seedAccounts({ openCodexHome, accounts });
    const config = buildServingConfig({
      port: candidatePorts[0],
      codexAccounts: seeded.codexAccounts,
      kimiModels,
    });
    writeConfigAtomic(path.join(openCodexHome, "config.json"), config);
    const kimiSync = await syncKimiCredential({ openCodexHome });
    log(`OpenCodex serving prepared: ${seeded.seeded.length} account(s), kimi sync ${kimiSync?.status ?? "unknown"}`);
    return seeded;
  }

  async function startOnFirstFreePort() {
    const failures = [];
    for (const port of candidatePorts) {
      const attempt = createHost({
        startupTimeoutMs,
        workerData: { enginePath },
        workerEnv: {
          ...workerEnv,
          CODEX_HOME: codexHome,
          OPENCODEX_HOME: openCodexHome,
          OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT: "1",
        },
      });
      try {
        const started = await attempt.start({ port });
        host = attempt;
        boundPort = started.port ?? port;
        return { ...started, port: boundPort };
      } catch (error) {
        failures.push(port);
        // engine-host cleans up its own worker on a failed start; drop the reference.
        if (!isAddrInUseError(error)) {
          throw new OpenCodexServingLifecycleError(
            "OPENCODEX_SERVING_START_FAILED",
            `OpenCodex serving engine failed on port ${port}: ${error?.message || error}`
          );
        }
        log(`OpenCodex serving port ${port} is busy; trying next`);
      }
    }
    throw new OpenCodexServingLifecycleError(
      "OPENCODEX_SERVING_NO_FREE_PORT",
      `No free OpenCodex serving port; attempted: ${failures.join(", ")}`
    );
  }

  async function start() {
    if (status.state === "ready") return status;
    if (startPromise) return startPromise;
    status = { state: "starting", port: null };
    startPromise = (async () => {
      try {
        await prepare();
        status = { ...(await startOnFirstFreePort()), state: "ready" };
        log(`OpenCodex serving engine ready on 127.0.0.1:${boundPort}`);
      } catch (error) {
        host = null;
        boundPort = null;
        status = {
          state: "failed",
          port: null,
          error: error?.message || String(error),
          ...(error?.code ? { code: error.code } : {}),
        };
        throw error;
      } finally {
        startPromise = null;
      }
      return status;
    })();
    return startPromise;
  }

  async function stop(options = {}) {
    if (startPromise) await startPromise.catch(() => {});
    if (!host) {
      status = { state: "stopped", port: null };
      return status;
    }
    const stoppingHost = host;
    const timeoutMs = options.timeoutMs ?? stopTimeoutMs;
    status = { state: "draining", port: boundPort };
    try {
      const stopped = await stoppingHost.quiesceAndStop({ timeoutMs });
      status = { ...stopped, port: null, state: "stopped" };
      log("OpenCodex serving engine stopped");
    } finally {
      if (host === stoppingHost) host = null;
      boundPort = null;
    }
    return status;
  }

  async function getStatus() {
    if (!host) return { ...status };
    const live = await host.getStatus();
    return { ...live, state: status.state === "draining" ? "draining" : live.state ?? status.state };
  }

  // Poll until no in-flight turns remain (or the engine is fully stopped).
  // The engine exposes no turn-count callback; polling is the contract.
  async function waitForIdle({ timeoutMs = stopTimeoutMs, pollMs = DEFAULT_IDLE_POLL_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await getStatus();
      const activeTurns = current.activeTurns ?? 0;
      if (!current.running || activeTurns === 0) return current;
      if (Date.now() >= deadline) {
        throw new OpenCodexServingLifecycleError(
          "OPENCODEX_SERVING_IDLE_TIMEOUT",
          `OpenCodex serving engine still has ${activeTurns} active turn(s) after ${timeoutMs}ms`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  return {
    start,
    stop,
    getStatus,
    waitForIdle,
    port: () => boundPort,
    // Task 5 hook: re-sync the bridged Kimi credential into this OPENCODEX_HOME
    // (the engine re-reads auth.json per request, so no restart is needed).
    syncKimiCredential: (options = {}) => syncKimiCredential({ openCodexHome, ...options }),
  };
}

module.exports = {
  DEFAULT_SERVING_PORTS,
  KIMI_ENGINE_MODEL_BY_SLUG,
  OpenCodexServingLifecycleError,
  buildKimiCombos,
  buildServingConfig,
  createOpenCodexServingLifecycle,
};
