"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createOpenCodexServingBackend } = require("../src/open-codex/serving-backend");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeProxy({ startPort = 10161 } = {}) {
  const calls = [];
  const idleListeners = new Set();
  return {
    calls,
    activeConnectionCount: 0,
    running: false,
    port: null,
    async start() {
      calls.push("proxy.start");
      this.running = true;
      this.port = startPort;
      return startPort;
    },
    stop() {
      calls.push("proxy.stop");
      this.running = false;
      this.port = null;
    },
    selectAccount(key) {
      calls.push(`proxy.selectAccount:${key}`);
    },
    onIdle(listener) {
      idleListeners.add(listener);
      return () => idleListeners.delete(listener);
    },
    emitIdle() {
      for (const listener of idleListeners) listener();
    },
  };
}

function fakeLifecycle({ calls, failStart = null, turnScript = [] } = {}) {
  return {
    portValue: null,
    stopped: false,
    options: null,
    async start() {
      calls.push("engine.start");
      if (failStart) throw failStart;
      // The real lifecycle calls its listAccounts dep during prepare; mirror that
      // so the facade's profileKey <-> engineId index gets populated in tests.
      if (this.options?.listAccounts) await this.options.listAccounts();
      this.portValue = 19_900;
      return { state: "ready", port: this.portValue };
    },
    port() {
      return this.portValue;
    },
    async getStatus() {
      const activeTurns = turnScript.length > 0 ? turnScript.shift() : 0;
      return { activeTurns, running: true, state: "ready", port: this.portValue };
    },
    async syncKimiCredential() {
      calls.push("syncKimiCredential");
      if (this.syncError) {
        const error = this.syncError;
        this.syncError = null;
        throw error;
      }
      return { status: "synced" };
    },
    async waitForIdle() {
      calls.push("engine.waitForIdle");
      return { activeTurns: 0 };
    },
    async stop() {
      calls.push("engine.stop");
      this.stopped = true;
      this.portValue = null;
      return { state: "stopped" };
    },
  };
}

function backendDeps(overrides = {}) {
  const calls = overrides.calls ?? [];
  const lifecycle = overrides.lifecycle ?? fakeLifecycle({ calls });
  const proxy = overrides.proxy ?? fakeProxy();
  const resyncInstances = overrides.resyncInstances ?? [];
  return {
    calls,
    lifecycle,
    proxy,
    resyncInstances,
    deps: {
      userDataDir: "/tmp/codepet-serving-backend-test",
      enginePath: "/tmp/engine.mjs",
      codexAccountSwitcher: overrides.switcher ?? { readActiveProfileKey: () => "acct-a" },
      discoverKimiModels: () => [],
      createLifecycle: (options) => {
        calls.push("createLifecycle");
        lifecycle.options = options;
        return lifecycle;
      },
      listAccounts: async () => {
        calls.push("listAccounts");
        return [
          { id: "acct-a", profileKey: "acct-a", authPath: "/p/acct-a/auth.json", email: "a@example.com", plan: "plus", credential: {} },
          { id: "acct-b", profileKey: "acct-b", authPath: "/p/acct-b/auth.json", email: "b@example.com", plan: "plus", credential: {} },
        ];
      },
      syncKimiCredential: () => ({ status: "synced" }),
      reverseSync: async () => {
        calls.push("reverseSync");
        return { synced: [], unchanged: ["acct-a"], skippedConflict: [], missingEngine: [], missingProfile: [] };
      },
      bridgeApi: {
        primeAccounts: async (port) => {
          calls.push(`primeAccounts:${port}`);
          return { accounts: [] };
        },
        selectAccount: async (port, id) => {
          calls.push(`selectAccount:${port}:${id}`);
          return { ok: true };
        },
        getActiveAccount: async (port) => {
          calls.push(`getActiveAccount:${port}`);
          return overrides.activeAccount ?? { activeCodexAccountId: "acct-a" };
        },
      },
      statusPollMs: 5,
      kimiSyncIntervalMs: overrides.kimiSyncIntervalMs ?? 90_000,
      kimiHome: overrides.kimiHome ?? path.join(os.tmpdir(), "codepet-backend-test-no-kimi-home"),
      createResync: (options) => {
        calls.push("createResync");
        resyncInstances.push({ options, started: 0, stopped: 0, start() { this.started += 1; }, stop() { this.stopped += 1; } });
        return resyncInstances[resyncInstances.length - 1];
      },
      proxy,
      log: () => {},
      ...overrides.deps,
    },
  };
}

test("engine backend is preferred and the proxy stays untouched on success", async () => {
  const { calls, deps, proxy } = backendDeps();
  const backend = createOpenCodexServingBackend(deps);

  const result = await backend.start();

  assert.deepEqual(result, { backend: "engine", port: 19_900 });
  assert.equal(backend.backend(), "engine");
  assert.equal(backend.port(), 19_900);
  assert.equal(proxy.calls.length, 0);
  assert.equal(proxy.running, false);
  // Readiness gate: quota priming happens after engine start, before start() resolves.
  const engineStart = calls.indexOf("engine.start");
  const prime = calls.indexOf("primeAccounts:19900");
  assert.ok(engineStart >= 0 && prime > engineStart, `prime order: ${calls}`);
  await backend.stop();
});

test("a failed quota prime does not fail engine startup", async () => {
  const { deps } = backendDeps({});
  deps.bridgeApi.primeAccounts = async () => {
    throw new Error("usage endpoint timeout");
  };
  const backend = createOpenCodexServingBackend(deps);

  const result = await backend.start();

  assert.deepEqual(result, { backend: "engine", port: 19_900 });
  await backend.stop();
});

test("any engine failure falls back to the legacy proxy", async () => {
  const failure = new Error("No free OpenCodex serving port; attempted: 10161");
  const { calls, deps, proxy } = backendDeps({ lifecycle: fakeLifecycle({ calls: [], failStart: failure }) });
  deps.createLifecycle = (options) => {
    const lifecycle = fakeLifecycle({ calls, failStart: failure });
    lifecycle.options = options;
    return lifecycle;
  };
  const backend = createOpenCodexServingBackend(deps);

  const result = await backend.start();

  assert.deepEqual(result, { backend: "proxy", port: 10161 });
  assert.equal(backend.backend(), "proxy");
  assert.equal(proxy.running, true);
  assert.equal(calls.includes("engine.start"), true);
  assert.deepEqual(proxy.calls.filter((call) => call === "proxy.start"), ["proxy.start"]);
  await backend.stop();
  assert.equal(proxy.running, false);
  assert.deepEqual(proxy.calls.filter((call) => call === "proxy.stop"), ["proxy.stop"]);
});

test("selectAccount routes to the engine API with the seeded engine id", async () => {
  const { calls, deps } = backendDeps();
  const backend = createOpenCodexServingBackend(deps);
  await backend.start();

  const selected = await backend.selectAccount("acct-b");

  assert.equal(selected, true);
  // One prime at startup (readiness gate), then prime + select for the switch.
  assert.deepEqual(
    calls.filter((call) => call.startsWith("primeAccounts") || call.startsWith("selectAccount")),
    ["primeAccounts:19900", "primeAccounts:19900", "selectAccount:19900:acct-b"]
  );
  await backend.stop();
});

test("selectAccount routes to the proxy when the proxy backend is active", async () => {
  const failure = new Error("engine down");
  const deps = backendDeps({}).deps;
  deps.createLifecycle = () => fakeLifecycle({ calls: [], failStart: failure });
  const proxy = deps.proxy;
  const backend = createOpenCodexServingBackend(deps);
  await backend.start();

  const selected = await backend.selectAccount("acct-b");

  assert.equal(selected, true);
  assert.deepEqual(proxy.calls.filter((call) => call.startsWith("proxy.selectAccount")), ["proxy.selectAccount:acct-b"]);
  await backend.stop();
});

test("stop drains, stops the engine, then reverse-syncs grants in order", async () => {
  const { calls, deps } = backendDeps();
  const backend = createOpenCodexServingBackend(deps);
  await backend.start();
  calls.length = 0;

  await backend.stop();

  assert.deepEqual(calls, ["engine.waitForIdle", "engine.stop", "reverseSync"]);
  assert.equal(backend.backend(), null);
  assert.equal(backend.port(), null);
});

test("isWorking reflects the cached engine activeTurns and idle fires the listener", async () => {
  const { deps, lifecycle } = backendDeps({});
  const seen = [...Array(20).fill(1), 0];
  lifecycle.getStatus = async () => ({
    activeTurns: seen.length > 0 ? seen.shift() : 0,
    running: true,
    state: "ready",
    port: 19_900,
  });
  const backend = createOpenCodexServingBackend(deps);
  const idleFired = [];
  backend.onIdle(() => idleFired.push(Date.now()));
  await backend.start();

  await delay(40);
  assert.equal(backend.isWorking(), true);
  await delay(160);
  assert.equal(backend.isWorking(), false);
  assert.equal(idleFired.length, 1);
  await backend.stop();
});

test("proxy backend isWorking and onIdle come from the proxy itself", async () => {
  const deps = backendDeps({}).deps;
  deps.createLifecycle = () => fakeLifecycle({ calls: [], failStart: new Error("engine down") });
  const proxy = deps.proxy;
  const backend = createOpenCodexServingBackend(deps);
  const idleFired = [];
  backend.onIdle(() => idleFired.push(Date.now()));
  await backend.start();

  proxy.activeConnectionCount = 1;
  assert.equal(backend.isWorking(), true);
  proxy.activeConnectionCount = 0;
  proxy.emitIdle();
  assert.equal(backend.isWorking(), false);
  assert.equal(idleFired.length, 1);
  await backend.stop();
});

test("engine rotation is reported after a working-to-idle transition", async () => {
  const { deps, lifecycle } = backendDeps({
    activeAccount: { activeCodexAccountId: "acct-b" },
    switcher: { readActiveProfileKey: () => "acct-a" },
  });
  const seen = [1, 0];
  lifecycle.getStatus = async () => ({
    activeTurns: seen.length > 0 ? seen.shift() : 0,
    running: true,
    state: "ready",
    port: 19_900,
  });
  const switches = [];
  deps.onAutoSwitch = (event) => switches.push(event);
  const backend = createOpenCodexServingBackend(deps);
  await backend.start();

  await delay(80);

  assert.deepEqual(switches, [{ profileKey: "acct-b", engineId: "acct-b" }]);
  await backend.stop();
});

test("no rotation event when the engine settled on the already-active profile", async () => {
  const { deps, lifecycle } = backendDeps({
    activeAccount: { activeCodexAccountId: "acct-a" },
    switcher: { readActiveProfileKey: () => "acct-a" },
  });
  const seen = [1, 0];
  lifecycle.getStatus = async () => ({
    activeTurns: seen.length > 0 ? seen.shift() : 0,
    running: true,
    state: "ready",
    port: 19_900,
  });
  const switches = [];
  deps.onAutoSwitch = (event) => switches.push(event);
  const backend = createOpenCodexServingBackend(deps);
  await backend.start();

  await delay(80);

  assert.deepEqual(switches, []);
  await backend.stop();
});

test("proxy waitForIdle resolves on zero connections and times out otherwise", async () => {
  const deps = backendDeps({}).deps;
  deps.createLifecycle = () => fakeLifecycle({ calls: [], failStart: new Error("engine down") });
  const proxy = deps.proxy;
  const backend = createOpenCodexServingBackend(deps);
  await backend.start();

  proxy.activeConnectionCount = 0;
  const idle = await backend.waitForIdle({ timeoutMs: 50, pollMs: 1 });
  assert.equal(idle.activeTurns, 0);

  proxy.activeConnectionCount = 1;
  await assert.rejects(backend.waitForIdle({ timeoutMs: 20, pollMs: 1 }), /active connection/);
  await backend.stop();
});

test("kimi 401 resync watcher starts with the engine and is always stopped", async () => {
  const { deps, resyncInstances } = backendDeps({});
  const backend = createOpenCodexServingBackend(deps);

  await backend.start();
  assert.equal(resyncInstances.length, 1);
  assert.equal(resyncInstances[0].started, 1);
  assert.equal(resyncInstances[0].stopped, 0);
  assert.equal(resyncInstances[0].options.port(), 19_900);

  await backend.stop();
  assert.equal(resyncInstances[0].stopped, 1);
});

test("kimi 401 resync watcher is not created on the proxy fallback", async () => {
  const { deps, resyncInstances } = backendDeps({});
  deps.createLifecycle = () => fakeLifecycle({ calls: [], failStart: new Error("engine down") });
  const backend = createOpenCodexServingBackend(deps);

  await backend.start();
  assert.equal(resyncInstances.length, 0);
  await backend.stop();
  assert.equal(resyncInstances.length, 0);
});

test("periodic kimi re-sync fires on change, skips unchanged source, and stops cleanly", async (t) => {
  const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-backend-kimi-"));
  t.after(() => fs.rmSync(kimiHome, { recursive: true, force: true }));
  const credentialFile = path.join(kimiHome, "credentials", "kimi-code.json");
  fs.mkdirSync(path.dirname(credentialFile), { recursive: true });
  fs.writeFileSync(credentialFile, JSON.stringify({ access_token: "token-v1" }));

  const { calls, deps } = backendDeps({ kimiHome, kimiSyncIntervalMs: 5 });
  const backend = createOpenCodexServingBackend(deps);
  await backend.start();
  const syncCalls = () => calls.filter((call) => call === "syncKimiCredential").length;

  await delay(40);
  const afterFirst = syncCalls();
  assert.ok(afterFirst >= 1, "tick fired the initial re-sync");
  await delay(40);
  assert.equal(syncCalls(), afterFirst, "unchanged credential file is not rewritten");

  fs.writeFileSync(credentialFile, JSON.stringify({ access_token: "token-v2" }));
  await delay(40);
  assert.ok(syncCalls() > afterFirst, "changed credential file triggers a re-sync");

  await backend.stop();
  const atStop = syncCalls();
  await delay(40);
  assert.equal(syncCalls(), atStop, "timer kept firing after stop");
});

test("a periodic re-sync error is logged and the timer keeps running", async (t) => {
  const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-backend-kimi-"));
  t.after(() => fs.rmSync(kimiHome, { recursive: true, force: true }));
  const credentialFile = path.join(kimiHome, "credentials", "kimi-code.json");
  fs.mkdirSync(path.dirname(credentialFile), { recursive: true });
  fs.writeFileSync(credentialFile, JSON.stringify({ access_token: "token-v1" }));

  const logs = [];
  const { calls, deps, lifecycle } = backendDeps({ kimiHome, kimiSyncIntervalMs: 5 });
  deps.log = (message) => logs.push(message);
  const backend = createOpenCodexServingBackend(deps);
  await backend.start();
  const syncCalls = () => calls.filter((call) => call === "syncKimiCredential").length;

  lifecycle.syncError = new Error("auth.json locked");
  fs.writeFileSync(credentialFile, JSON.stringify({ access_token: "token-v2" }));
  await delay(40);
  assert.ok(logs.some((message) => message.includes("re-sync failed")), `missing failure log: ${logs}`);

  // The failed tick did not latch the fingerprint, so the next tick retries and succeeds.
  fs.writeFileSync(credentialFile, JSON.stringify({ access_token: "token-v3" }));
  await delay(40);
  assert.ok(syncCalls() >= 2, "timer kept running after the error");
  await backend.stop();
});
