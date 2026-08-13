"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { EngineHostError } = require("../src/open-codex/engine-interface");
const { KIMI_CODEX_MODELS } = require("../src/kimi-codex-models");
const {
  KIMI_ENGINE_MODEL_BY_SLUG,
  OpenCodexServingLifecycleError,
  buildServingConfig,
  createOpenCodexServingLifecycle,
} = require("../src/open-codex/serving-lifecycle");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-serving-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, openCodexHome: path.join(root, "opencodex") };
}

function bridgeAccount(id, overrides = {}) {
  return {
    id,
    profileKey: id,
    authPath: `/profiles/${id}/auth.json`,
    email: `${id}@example.com`,
    plan: "plus",
    credential: {
      accessToken: `at-${id}`,
      refreshToken: `rt-${id}`,
      expiresAt: 2_000_000_000_000,
      chatgptAccountId: `chatgpt-${id}`,
    },
    ...overrides,
  };
}

function fakeHostFactory({ busyPorts = [], turnScript = [], calls } = {}) {
  const hosts = [];
  const factory = (options) => {
    const host = {
      options,
      stopped: false,
      async start({ port }) {
        calls.push(`host.start:${port}`);
        if (busyPorts.includes(port)) {
          throw new EngineHostError("ENGINE_WORKER_ERROR", `listen EADDRINUSE: address already in use 127.0.0.1:${port}`);
        }
        host.port = port;
        return { activeTurns: 0, draining: false, port, running: true, state: "ready" };
      },
      async getStatus() {
        const activeTurns = turnScript.length > 0 ? turnScript.shift() : 0;
        return { activeTurns, draining: false, port: host.port ?? null, running: true, state: "ready" };
      },
      async quiesceAndStop() {
        host.stopped = true;
        calls.push("host.stop");
        return { activeTurns: 0, draining: false, port: null, running: false, state: "stopped" };
      },
    };
    hosts.push(host);
    return host;
  };
  return { factory, hosts };
}

function lifecycleDeps(overrides = {}) {
  const calls = overrides.calls ?? [];
  return {
    calls,
    listAccounts: async () => {
      calls.push("listAccounts");
      return [bridgeAccount("acct-a"), bridgeAccount("acct-b")];
    },
    discoverKimiModels: () => {
      calls.push("discoverKimiModels");
      return KIMI_CODEX_MODELS.map((model) => ({ ...model }));
    },
    seedAccounts: async ({ openCodexHome, accounts }) => {
      calls.push("seedAccounts");
      return {
        codexAccounts: accounts.map((account) => ({ id: account.id, email: account.email, isMain: false, plan: account.plan })),
        seeded: accounts.map((account) => account.id),
      };
    },
    syncKimiCredential: async ({ openCodexHome }) => {
      calls.push("syncKimiCredential");
      return { status: "synced", openCodexHome };
    },
    ...overrides,
  };
}

test("start writes config.json once with the required serving shape", async (t) => {
  const { openCodexHome } = fixture(t);
  const calls = [];
  const { factory } = fakeHostFactory({ calls });
  const lifecycle = createOpenCodexServingLifecycle({
    openCodexHome,
    createHost: factory,
    ports: [19611],
    ...lifecycleDeps({ calls }),
  });

  const status = await lifecycle.start();

  assert.equal(status.state, "ready");
  assert.equal(lifecycle.port(), 19611);
  const config = JSON.parse(fs.readFileSync(path.join(openCodexHome, "config.json"), "utf8"));
  assert.equal(config.openaiProviderTierVersion, 2);
  assert.equal(config.hostname, "127.0.0.1");
  assert.equal(config.defaultProvider, "openai");
  assert.equal(config.websockets, true);
  assert.deepEqual(config.providers.openai, {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward",
    codexAccountMode: "pool",
  });
  assert.deepEqual(config.providers.kimi, {
    adapter: "openai-chat",
    baseUrl: "https://api.kimi.com/coding/v1",
    authMode: "oauth",
  });
  assert.deepEqual(config.codexAccounts, [
    { id: "acct-a", email: "acct-a@example.com", isMain: false, plan: "plus" },
    { id: "acct-b", email: "acct-b@example.com", isMain: false, plan: "plus" },
  ]);
  // Every managed Kimi slug maps to exactly the registry-evidenced engine model.
  for (const model of KIMI_CODEX_MODELS) {
    assert.deepEqual(config.combos[model.slug], {
      alias: model.slug,
      targets: [{ provider: "kimi", model: KIMI_ENGINE_MODEL_BY_SLUG[model.slug] }],
    });
  }
  assert.equal(config.combos["codepet-kimi-k3"].targets[0].model, "k3[1m]");
  assert.equal(config.combos["codepet-kimi-k3-256k"].targets[0].model, "k3");
  assert.equal(config.combos["codepet-kimi-k2-7-coding"].targets[0].model, "kimi-for-coding");
  assert.equal(config.combos["codepet-kimi-k2-7-coding-fast"].targets[0].model, "kimi-for-coding-highspeed");
});

test("config.json is not rewritten while the engine is running or on idempotent start", async (t) => {
  const { openCodexHome } = fixture(t);
  const calls = [];
  const { factory } = fakeHostFactory({ calls });
  const lifecycle = createOpenCodexServingLifecycle({
    openCodexHome,
    createHost: factory,
    ports: [19612],
    ...lifecycleDeps({ calls }),
  });

  await lifecycle.start();
  const configPath = path.join(openCodexHome, "config.json");
  const written = fs.readFileSync(configPath, "utf8");
  const seedCalls = calls.filter((call) => call === "seedAccounts").length;

  const again = await lifecycle.start();
  assert.equal(again.state, "ready");
  assert.equal(fs.readFileSync(configPath, "utf8"), written);
  assert.equal(calls.filter((call) => call === "seedAccounts").length, seedCalls);
  assert.equal(calls.filter((call) => call.startsWith("host.start")).length, 1);
});

test("preparation runs seed and kimi sync before host.start, in order", async (t) => {
  const { openCodexHome } = fixture(t);
  const calls = [];
  const { factory } = fakeHostFactory({ calls });
  const lifecycle = createOpenCodexServingLifecycle({
    openCodexHome,
    createHost: factory,
    ports: [19613],
    ...lifecycleDeps({ calls }),
  });

  await lifecycle.start();

  assert.deepEqual(calls, [
    "listAccounts",
    "discoverKimiModels",
    "seedAccounts",
    "syncKimiCredential",
    "host.start:19613",
  ]);
});

test("worker env isolates CODEX_HOME and enables the account import API", async (t) => {
  const { openCodexHome } = fixture(t);
  const { factory, hosts } = fakeHostFactory({ calls: [] });
  const lifecycle = createOpenCodexServingLifecycle({
    openCodexHome,
    createHost: factory,
    ports: [19614],
    ...lifecycleDeps({ calls: [] }),
  });

  await lifecycle.start();

  const env = hosts[0].options.workerEnv;
  assert.equal(env.OPENCODEX_HOME, openCodexHome);
  assert.equal(env.CODEX_HOME, path.join(openCodexHome, "codex-home"));
  assert.notEqual(env.CODEX_HOME, path.join(os.homedir(), ".codex"));
  assert.equal(env.OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT, "1");
});

test("port scan skips busy ports and binds the first free one", async (t) => {
  const { openCodexHome } = fixture(t);
  const calls = [];
  const { factory, hosts } = fakeHostFactory({ busyPorts: [19621, 19622], calls });
  const lifecycle = createOpenCodexServingLifecycle({
    openCodexHome,
    createHost: factory,
    ports: [19621, 19622, 19623],
    ...lifecycleDeps({ calls }),
  });

  const status = await lifecycle.start();

  assert.equal(lifecycle.port(), 19623);
  assert.equal(status.port, 19623);
  assert.deepEqual(calls.filter((call) => call.startsWith("host.start")), [
    "host.start:19621",
    "host.start:19622",
    "host.start:19623",
  ]);
  assert.equal(hosts.length, 3);
});

test("all ports busy fails loudly and leaves no running host", async (t) => {
  const { openCodexHome } = fixture(t);
  const { factory, hosts } = fakeHostFactory({ busyPorts: [19631, 19632], calls: [] });
  const lifecycle = createOpenCodexServingLifecycle({
    openCodexHome,
    createHost: factory,
    ports: [19631, 19632],
    ...lifecycleDeps({ calls: [] }),
  });

  await assert.rejects(lifecycle.start(), (error) => {
    assert.ok(error instanceof OpenCodexServingLifecycleError);
    assert.equal(error.code, "OPENCODEX_SERVING_NO_FREE_PORT");
    assert.match(error.message, /19631/);
    assert.match(error.message, /19632/);
    return true;
  });
  assert.equal(lifecycle.port(), null);
  assert.equal((await lifecycle.getStatus()).state, "failed");
  assert.equal(hosts.every((host) => !host.stopped || host.stopped), true);
});

test("non-port start failures do not trigger the scan fallback", async (t) => {
  const { openCodexHome } = fixture(t);
  const factory = () => ({
    async start() {
      throw new EngineHostError("ENGINE_START_TIMEOUT", "engine did not answer");
    },
  });
  const lifecycle = createOpenCodexServingLifecycle({
    openCodexHome,
    createHost: factory,
    ports: [19641, 19642],
    ...lifecycleDeps({ calls: [] }),
  });

  await assert.rejects(lifecycle.start(), (error) => {
    assert.equal(error.code, "OPENCODEX_SERVING_START_FAILED");
    assert.match(error.message, /19641/);
    return true;
  });
  assert.equal(lifecycle.port(), null);
});

test("config build failure happens before any host is created", async (t) => {
  const { openCodexHome } = fixture(t);
  let hostCreated = 0;
  const factory = () => {
    hostCreated += 1;
    return fakeHostFactory({ calls: [] }).factory();
  };
  const deps = lifecycleDeps({ calls: [] });
  deps.discoverKimiModels = () => [{ slug: "codepet-kimi-unknown", upstreamModel: "mystery" }];
  const lifecycle = createOpenCodexServingLifecycle({
    openCodexHome,
    createHost: factory,
    ports: [19651],
    ...deps,
  });

  await assert.rejects(lifecycle.start(), (error) => {
    assert.equal(error.code, "OPENCODEX_SERVING_UNKNOWN_KIMI_SLUG");
    assert.match(error.message, /codepet-kimi-unknown/);
    return true;
  });
  assert.equal(hostCreated, 0);
  assert.equal(fs.existsSync(path.join(openCodexHome, "config.json")), false);
});

test("waitForIdle resolves when activeTurns reaches zero", async (t) => {
  const { openCodexHome } = fixture(t);
  const { factory } = fakeHostFactory({ turnScript: [1, 1, 0], calls: [] });
  const lifecycle = createOpenCodexServingLifecycle({
    openCodexHome,
    createHost: factory,
    ports: [19661],
    ...lifecycleDeps({ calls: [] }),
  });
  await lifecycle.start();

  const idle = await lifecycle.waitForIdle({ timeoutMs: 1_000, pollMs: 1 });
  assert.equal(idle.activeTurns, 0);
});

test("waitForIdle rejects on timeout while turns stay active", async (t) => {
  const { openCodexHome } = fixture(t);
  const { factory } = fakeHostFactory({ turnScript: Array(200).fill(1), calls: [] });
  const lifecycle = createOpenCodexServingLifecycle({
    openCodexHome,
    createHost: factory,
    ports: [19662],
    ...lifecycleDeps({ calls: [] }),
  });
  await lifecycle.start();

  await assert.rejects(lifecycle.waitForIdle({ timeoutMs: 20, pollMs: 1 }), (error) => {
    assert.equal(error.code, "OPENCODEX_SERVING_IDLE_TIMEOUT");
    return true;
  });
});

test("stop quiesces the host and clears the bound port", async (t) => {
  const { openCodexHome } = fixture(t);
  const calls = [];
  const { factory, hosts } = fakeHostFactory({ calls });
  const lifecycle = createOpenCodexServingLifecycle({
    openCodexHome,
    createHost: factory,
    ports: [19671],
    ...lifecycleDeps({ calls }),
  });
  await lifecycle.start();

  const stopped = await lifecycle.stop({ timeoutMs: 500 });

  assert.equal(stopped.state, "stopped");
  assert.equal(lifecycle.port(), null);
  assert.equal(hosts[0].stopped, true);
  assert.deepEqual(calls.filter((call) => call === "host.stop"), ["host.stop"]);
  const again = await lifecycle.stop();
  assert.equal(again.state, "stopped");
});

test("buildServingConfig throws on an unknown Kimi slug", () => {
  assert.throws(
    () => buildServingConfig({ port: 10161, kimiModels: [{ slug: "codepet-kimi-nope" }] }),
    (error) => {
      assert.equal(error.code, "OPENCODEX_SERVING_UNKNOWN_KIMI_SLUG");
      return true;
    }
  );
});
