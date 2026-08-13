"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createKimiCredentialResync } = require("../src/open-codex/kimi-credential-resync");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function logsFixture(t, entries) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(entries));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, requests };
}

test("a fresh kimi 401 log entry triggers exactly one credential re-sync", async (t) => {
  const entries = [
    { requestId: "1", timestamp: 1_000, provider: "kimi", model: "kimi-for-coding", status: 401 },
    { requestId: "2", timestamp: 2_000, provider: "kimi", model: "kimi-for-coding", status: 401 },
  ];
  const { server, requests } = logsFixture(t, entries);
  const port = await listen(server);
  const syncs = [];
  const resync = createKimiCredentialResync({
    port,
    syncKimiCredential: async () => {
      syncs.push(Date.now());
      return { status: "synced" };
    },
  });

  const result = await resync.checkOnce(3_000);

  assert.deepEqual(result, { fresh401: 2, synced: true });
  assert.equal(syncs.length, 1);
  assert.match(requests[0], /\/api\/logs\?provider=kimi&tail=50/);

  // Entries already seen must not retrigger a sync.
  const again = await resync.checkOnce(4_000);
  assert.deepEqual(again, { fresh401: 0, synced: false });
  assert.equal(syncs.length, 1);
});

test("auth failures match through attempts: combo parent 502 with a kimi 401 attempt", async () => {
  let entries = [];
  const fetchImpl = async () => ({ ok: true, json: async () => entries });
  let syncCalls = 0;
  const resync = createKimiCredentialResync({
    port: 1,
    fetchImpl,
    syncKimiCredential: async () => {
      syncCalls += 1;
      return { status: "synced" };
    },
  });

  // The WS turn shape: the parent turn can classify as a generic error while the
  // attempt carries the real auth failure (and combo parents record provider "combo").
  entries = [{
    requestId: "ws-1",
    timestamp: 1_000,
    provider: "combo",
    model: "codepet-kimi-k3",
    status: 502,
    attempts: [{ provider: "kimi", model: "k3[1m]", status: 401, errorCode: "invalid_api_key" }],
  }];
  const fired = await resync.checkOnce(2_000);
  assert.deepEqual(fired, { fresh401: 1, synced: true });
  assert.equal(syncCalls, 1);

  // A plain 502 with no auth signal anywhere must not trigger a rewrite.
  entries = [{
    requestId: "ws-2",
    timestamp: 3_000,
    provider: "kimi",
    status: 502,
    attempts: [{ provider: "kimi", model: "k3", status: 502 }],
  }];
  const quiet = await resync.checkOnce(4_000);
  assert.deepEqual(quiet, { fresh401: 0, synced: false });
  assert.equal(syncCalls, 1);

  // errorCode alone (no 401 anywhere) still counts as an auth failure.
  entries = [{
    requestId: "ws-3",
    timestamp: 5_000,
    provider: "kimi",
    status: 502,
    errorCode: "invalid_api_key",
  }];
  const coded = await resync.checkOnce(6_000);
  assert.deepEqual(coded, { fresh401: 1, synced: true });
  assert.equal(syncCalls, 2);
});

test("no kimi 401 entries means no re-sync", async (t) => {
  const { server } = logsFixture(t, [
    { requestId: "1", timestamp: 1_000, provider: "kimi", model: "k3", status: 200 },
  ]);
  const port = await listen(server);
  let syncCalls = 0;
  const resync = createKimiCredentialResync({
    port,
    syncKimiCredential: async () => {
      syncCalls += 1;
      return { status: "synced" };
    },
  });

  const result = await resync.checkOnce(5_000);
  assert.deepEqual(result, { fresh401: 0, synced: false });
  assert.equal(syncCalls, 0);
});

test("persistent 401s escalate once after the configured threshold", async () => {
  let entries = [];
  const fetchImpl = async () => ({ ok: true, json: async () => entries });
  const escalations = [];
  const logs = [];
  let syncCalls = 0;
  const resync = createKimiCredentialResync({
    port: 1,
    fetchImpl,
    escalateAfter: 3,
    syncKimiCredential: async () => {
      syncCalls += 1;
      return { status: "synced" };
    },
    log: (message) => logs.push(message),
    escalateLog: (message) => escalations.push(message),
  });

  // Four consecutive polls each carrying a FRESH 401 (rising timestamps).
  for (let i = 1; i <= 4; i += 1) {
    entries = [{ requestId: String(i), timestamp: i * 1_000, provider: "kimi", status: 401 }];
    await resync.checkOnce(i * 1_000 + 500);
  }

  assert.equal(syncCalls, 4);
  assert.equal(escalations.length, 1, "escalation fired at the threshold and only once");
  assert.match(escalations[0], /re-login/);
  assert.equal(logs.filter((message) => message.includes("kimi 401 observed")).length, 4);

  // A quiet poll resets the streak; the next incident escalates again.
  entries = [];
  await resync.checkOnce(9_000);
  entries = [{ requestId: "9", timestamp: 10_000, provider: "kimi", status: 401 }];
  await resync.checkOnce(10_500);
  entries = [{ requestId: "10", timestamp: 11_000, provider: "kimi", status: 401 }];
  await resync.checkOnce(11_500);
  entries = [{ requestId: "11", timestamp: 12_000, provider: "kimi", status: 401 }];
  await resync.checkOnce(12_500);
  assert.equal(escalations.length, 2, "a new 401 streak escalates again after a quiet period");
});

test("interval handle starts and is always cleared by stop", async (t) => {
  const { server, requests } = logsFixture(t, []);
  const port = await listen(server);
  const resync = createKimiCredentialResync({
    port,
    intervalMs: 5,
    syncKimiCredential: async () => ({ status: "synced" }),
  });

  resync.start();
  resync.start(); // idempotent
  await new Promise((resolve) => setTimeout(resolve, 25));
  resync.stop();
  // A poll already in flight when stop() runs may still land; let it settle,
  // then assert no NEW polls are scheduled.
  await new Promise((resolve) => setTimeout(resolve, 40));
  const settled = requests.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(requests.length, settled, "polling continued after stop");
});
