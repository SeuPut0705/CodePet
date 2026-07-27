const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const {
  CodexProxyShutdownCoordinator,
  prepareCodexProxyForQuit,
} = require("../src/codex-proxy-shutdown");

function shutdownHarness({
  working = true,
  prepareError = null,
  waitForIdleConfirmation,
} = {}) {
  let codexWorking = working;
  const events = [];
  const coordinator = new CodexProxyShutdownCoordinator({
    isCodexWorking: () => codexWorking,
    prepareForQuit: async () => {
      events.push("prepare");
      if (prepareError) throw prepareError;
    },
    finishQuit: () => events.push("quit"),
    notifyWaiting: () => events.push("waiting"),
    notifyError: (error) => events.push(`error:${error.message}`),
    waitForIdleConfirmation,
  });

  return {
    coordinator,
    events,
    startWork() {
      codexWorking = true;
      return coordinator.handleWorkingChanged(true);
    },
    finishWork() {
      codexWorking = false;
      return coordinator.handleWorkingChanged(false);
    },
  };
}

test("Codex 작업 중 완전 종료는 작업 완료까지 프록시와 앱을 유지한다", async () => {
  const harness = shutdownHarness({ working: true });

  assert.equal(await harness.coordinator.requestQuit(), false);
  assert.deepEqual(harness.events, ["waiting"]);
  assert.equal(harness.coordinator.waiting, true);

  assert.equal(await harness.finishWork(), true);
  assert.deepEqual(harness.events, ["waiting", "prepare", "quit"]);
  assert.equal(harness.coordinator.readyToQuit, true);
});

test("Codex 작업이 없으면 프록시 정리 뒤 앱을 종료한다", async () => {
  const harness = shutdownHarness({ working: false });

  assert.equal(await harness.coordinator.requestQuit(), true);
  assert.deepEqual(harness.events, ["prepare", "quit"]);
  assert.equal(harness.coordinator.readyToQuit, true);
});

test("Codex 직접 연결 복구 실패 시 CodePet 종료를 취소한다", async () => {
  const harness = shutdownHarness({
    working: false,
    prepareError: new Error("Codex 재실행 실패"),
  });

  assert.equal(await harness.coordinator.requestQuit(), false);
  assert.deepEqual(harness.events, ["prepare", "error:Codex 재실행 실패"]);
  assert.equal(harness.coordinator.readyToQuit, false);
  assert.equal(harness.coordinator.waiting, false);
});

test("종료 확정 대기 중 새 작업이 시작되면 정리를 미루고 다시 완료를 기다린다", async () => {
  let releaseConfirmation;
  const confirmation = new Promise((resolve) => {
    releaseConfirmation = resolve;
  });
  const harness = shutdownHarness({
    working: false,
    waitForIdleConfirmation: () => confirmation,
  });

  const quitting = harness.coordinator.requestQuit();
  harness.startWork();
  releaseConfirmation();

  assert.equal(await quitting, false);
  assert.deepEqual(harness.events, ["waiting"]);
  assert.equal(harness.coordinator.waiting, true);

  assert.equal(await harness.finishWork(), true);
  assert.deepEqual(harness.events, ["waiting", "prepare", "quit"]);
});

test("프록시 종료 전 Codex Desktop을 직접 연결 설정으로 재실행한다", async () => {
  const events = [];

  await prepareCodexProxyForQuit({
    proxyActive: true,
    isDesktopRunning: async () => true,
    disableProxyConfig: () => events.push("config-disabled"),
    stopDesktop: async () => events.push("desktop-stop"),
    waitForDesktopExit: async () => events.push("desktop-exited"),
    launchDesktop: async () => events.push("desktop-launched"),
    stopProxy: () => events.push("proxy-stop"),
    restoreProxyConfig: () => events.push("config-restored"),
  });

  assert.deepEqual(events, [
    "config-disabled",
    "desktop-stop",
    "desktop-exited",
    "desktop-launched",
    "proxy-stop",
  ]);
});

test("Codex Desktop 직접 연결 복구 실패 시 프록시 설정과 실행 상태를 보존한다", async () => {
  const events = [];

  await assert.rejects(
    prepareCodexProxyForQuit({
      proxyActive: true,
      isDesktopRunning: async () => true,
      disableProxyConfig: () => events.push("config-disabled"),
      stopDesktop: async () => {
        events.push("desktop-stop");
        throw new Error("quit denied");
      },
      waitForDesktopExit: async () => events.push("desktop-exited"),
      launchDesktop: async () => events.push("desktop-launched"),
      stopProxy: () => events.push("proxy-stop"),
      restoreProxyConfig: () => events.push("config-restored"),
    }),
    /quit denied/
  );

  assert.deepEqual(events, [
    "config-disabled",
    "desktop-stop",
    "config-restored",
  ]);
});

test("main 종료 수명주기는 coordinator를 거쳐 작업 완료 뒤 before-quit을 허용한다", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

  assert.match(mainSource, /new CodexProxyShutdownCoordinator\(/);
  assert.match(mainSource, /servingBackend\.isWorking\(\)/);
  assert.match(mainSource, /servingBackend\.onIdle\(/);
  assert.match(mainSource, /codexProxyShutdownCoordinator\.requestQuit\(\)/);
  assert.match(mainSource, /codexProxyShutdownCoordinator\.handleWorkingChanged\(isWorking\)/);
  assert.match(
    mainSource,
    /if \(!codexProxyShutdownCoordinator\.readyToQuit\)\s*\{\s*event\.preventDefault\(\)/
  );
});

