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
  assert.match(requests[0], /\/api\/logs\?provider=kimi&status=401/);

  // Entries already seen must not retrigger a sync.
  const again = await resync.checkOnce(4_000);
  assert.deepEqual(again, { fresh401: 0, synced: false });
  assert.equal(syncs.length, 1);
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
  const seen = requests.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(requests.length, seen, "polling continued after stop");
});
