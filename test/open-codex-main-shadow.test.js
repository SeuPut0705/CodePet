const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const packageJson = require("../package.json");

const {
  createOpenCodexShadowLifecycle,
} = require("../src/open-codex/shadow-lifecycle");

test("shadow flag가 꺼지면 engine worker를 만들지 않는다", async () => {
  let created = 0;
  const lifecycle = createOpenCodexShadowLifecycle({
    enabled: false,
    createHost: () => { created += 1; },
  });

  assert.deepEqual(await lifecycle.start(), { state: "disabled" });
  assert.equal(created, 0);
  assert.deepEqual(await lifecycle.stop(), { state: "disabled" });
});

test("shadow lifecycle은 ready 진단을 남기고 drain 뒤 worker를 멈춘다", async () => {
  const events = [];
  const lifecycle = createOpenCodexShadowLifecycle({
    enabled: true,
    createHost: () => ({
      start: async (configuration) => {
        events.push(["start", configuration]);
        return { state: "ready", running: true, port: 43123 };
      },
      quiesceAndStop: async (options) => {
        events.push(["stop", options]);
        return { state: "stopped", running: false, port: null };
      },
    }),
    log: (message) => events.push(["log", message]),
    stopTimeoutMs: 1234,
  });

  assert.equal((await lifecycle.start()).port, 43123);
  assert.deepEqual(await lifecycle.stop(), { state: "stopped", running: false, port: null });
  assert.deepEqual(events, [
    ["start", { port: 0 }],
    ["log", "OpenCodex shadow engine ready on 127.0.0.1:43123"],
    ["stop", { timeoutMs: 1234 }],
    ["log", "OpenCodex shadow engine stopped"],
  ]);
});

test("shadow 시작 실패는 앱 시작을 막지 않고 failed 진단으로 격리한다", async () => {
  const lifecycle = createOpenCodexShadowLifecycle({
    enabled: true,
    createHost: () => ({
      start: async () => { throw new Error("bundle unavailable"); },
    }),
  });

  const status = await lifecycle.start();
  assert.equal(status.state, "failed");
  assert.equal(status.error, "bundle unavailable");
});

test("Electron main은 shadow를 flag 뒤에서 시작하고 안전 종료 준비 중 drain한다", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const readyLifecycle = mainSource.slice(
    mainSource.indexOf("app.whenReady().then"),
    mainSource.indexOf('app.on("before-quit"')
  );
  const coordinator = mainSource.slice(
    mainSource.indexOf("new CodexProxyShutdownCoordinator("),
    mainSource.indexOf("codexProxy.onIdle(")
  );

  assert.match(mainSource, /process\.env\.CODEPET_OPENCODEX_SHADOW === "1"/);
  assert.match(mainSource, /path\.join\(app\.getPath\("userData"\), "opencodex-shadow"\)/);
  assert.match(mainSource, /workerEnv: openCodexShadowEnvironment\(\)/);
  assert.match(readyLifecycle, /openCodexShadowLifecycle\.start\(\)/);
  assert.match(coordinator, /await openCodexShadowLifecycle\.stop\(\)/);
  assert.doesNotMatch(coordinator, /enableProxyInConfig[^]*openCodexShadowLifecycle/);
});

test("패키징과 macOS Windows CI는 engine build와 smoke를 먼저 실행한다", () => {
  const buildSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "build.js"), "utf8");
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");

  assert.ok(packageJson.build.files.includes("build/generated/opencodex-engine.mjs"));
  assert.ok(packageJson.build.asarUnpack.includes("build/generated/opencodex-engine.mjs"));
  assert.ok(buildSource.indexOf("await buildEngine(") < buildSource.indexOf("await build({"));
  assert.match(workflow, /npm run opencodex:build-engine/);
  assert.match(workflow, /npm run opencodex:engine-smoke/);
  assert.ok(
    workflow.indexOf("npm run opencodex:engine-smoke") < workflow.indexOf("npm run dist")
  );
});
