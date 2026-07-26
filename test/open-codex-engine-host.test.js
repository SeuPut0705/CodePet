const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createEngineHost } = require("../src/open-codex/engine-host");

const workerPath = path.join(__dirname, "fixtures", "open-codex-engine-worker-fixture.js");
const productionWorkerPath = path.join(__dirname, "..", "src", "open-codex", "engine-worker.js");
const engineFixturePath = path.join(__dirname, "fixtures", "open-codex-engine-module-fixture.mjs");

test("EngineHost start는 중복 호출에도 worker를 한 번만 시작한다", async () => {
  const host = createEngineHost({ workerPath, startupTimeoutMs: 500 });
  const [first, second] = await Promise.all([host.start({}), host.start({})]);

  assert.equal(first.state, "ready");
  assert.equal(first.startCount, 1);
  assert.deepEqual(second, first);
  await host.quiesceAndStop({ timeoutMs: 100 });
});

test("EngineHost는 startup timeout worker를 정리하고 failed 상태를 남긴다", async () => {
  const host = createEngineHost({ workerPath, startupTimeoutMs: 10 });

  await assert.rejects(host.start({ startDelayMs: 100 }), { code: "ENGINE_START_TIMEOUT" });
  assert.deepEqual(await host.getStatus(), {
    activeTurns: 0,
    draining: false,
    port: null,
    running: false,
    state: "failed",
  });
});

test("EngineHost는 worker crash를 현재 프로세스와 격리하고 비밀 없는 오류를 반환한다", async () => {
  const host = createEngineHost({ workerPath, startupTimeoutMs: 500 });

  await assert.rejects(
    host.start({ crash: true }),
    (error) => error.code === "ENGINE_WORKER_EXITED"
      && !error.message.includes("secret")
      && !error.message.includes("oauth.example")
      && !error.stack?.includes("fixture crash")
  );
  assert.equal((await host.getStatus()).state, "failed");
});

test("EngineHost는 순서가 바뀐 worker 응답을 요청 ID로 연결한다", async () => {
  const host = createEngineHost({ workerPath, startupTimeoutMs: 500 });
  await host.start({});

  const [status, capabilities] = await Promise.all([
    host.getStatus(),
    host.getCapabilities(),
  ]);

  assert.equal(status.startCount, 1);
  assert.equal(status.state, "ready");
  assert.deepEqual(capabilities, {
    protocolVersion: 1,
    transports: ["http", "websocket"],
  });
  await host.quiesceAndStop({ timeoutMs: 100 });
});

test("EngineHost는 drain timeout 때 worker를 죽이지 않고 재시도를 허용한다", async () => {
  const host = createEngineHost({ workerPath, startupTimeoutMs: 500 });
  await host.start({ stopDelayMs: 50 });

  await assert.rejects(host.quiesceAndStop({ timeoutMs: 5 }), { code: "ENGINE_DRAIN_TIMEOUT" });
  assert.equal((await host.getStatus()).running, true);

  const stopped = await host.quiesceAndStop({ timeoutMs: 100 });
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.running, false);
});

test("실제 engine worker는 번들 모듈을 로드하고 protocol capability를 반환한다", async () => {
  const host = createEngineHost({
    workerPath: productionWorkerPath,
    startupTimeoutMs: 500,
    workerData: { enginePath: engineFixturePath },
  });

  const started = await host.start({ port: 0 });
  assert.equal(started.port, 45678);
  assert.deepEqual(await host.getCapabilities(), {
    lifecycle: ["start", "status", "quiesce-and-stop"],
    protocolVersion: 1,
    reload: "restart-required",
    transports: ["http", "websocket"],
  });
  assert.equal((await host.quiesceAndStop({ timeoutMs: 100 })).state, "stopped");
});

test("실제 engine worker는 오류 stack과 credential 값을 IPC 밖으로 보내지 않는다", async () => {
  const host = createEngineHost({
    workerPath: productionWorkerPath,
    startupTimeoutMs: 500,
    workerData: { enginePath: engineFixturePath },
  });

  await assert.rejects(
    host.start({ port: 999 }),
    (error) => error.code === "ENGINE_WORKER_ERROR"
      && !error.message.includes("secret")
      && !error.message.includes("oauth.example")
      && !error.stack?.includes("open-codex-engine-module-fixture")
  );
});
