const test = require("node:test");
const assert = require("node:assert/strict");

const { ProviderHookBridge } = require("../src/provider-hook-bridge");

test("hook bridge는 loopback token 요청만 해당 provider watcher에 전달한다", async (t) => {
  const received = [];
  const bridge = new ProviderHookBridge({
    port: 0,
    token: "test-token",
    watchers: {
      cursor: { ingest: (eventName, payload) => received.push({ eventName, payload }) },
    },
  });
  await bridge.start();
  t.after(() => bridge.stop());
  const url = `http://127.0.0.1:${bridge.info().port}/codepet/v1/events/cursor/stop`;

  const denied = await fetch(url, { method: "POST", body: "{}" });
  const accepted = await fetch(url, {
    method: "POST",
    headers: { "X-CodePet-Token": "test-token", "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: "cursor-1" }),
  });
  const unknown = await fetch(url.replace("/cursor/", "/unknown/"), {
    method: "POST",
    headers: { "X-CodePet-Token": "test-token" },
    body: "{}",
  });

  assert.equal(denied.status, 403);
  assert.equal(accepted.status, 202);
  assert.equal(unknown.status, 404);
  assert.deepEqual(received, [{ eventName: "stop", payload: { conversation_id: "cursor-1" } }]);
});
