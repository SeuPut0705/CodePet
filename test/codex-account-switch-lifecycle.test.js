const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

function mainFunctionSource(name, nextMarker) {
  const start = mainSource.indexOf(`async function ${name}(`);
  const end = mainSource.indexOf(nextMarker, start);
  assert.notEqual(start, -1, `${name} 함수를 찾지 못했습니다.`);
  assert.notEqual(end, -1, `${name} 함수 끝을 찾지 못했습니다.`);
  return mainSource.slice(start, end).trim();
}

function switchHarness({
  proxyModeRequested = false,
  proxyActive = false,
  running = true,
  stopCompletesBeforeExit = false,
  stopError = null,
  switchError = null,
} = {}) {
  let codexRunning = running;
  const events = [];
  const switchCodexAccount = vm.runInNewContext(
    `(${mainFunctionSource("switchCodexAccount", "// 트레이/우클릭 메뉴에서도")})`,
    {
      isCodexProxyModeEnabled: () => proxyModeRequested,
      codexProxyStartupPromise: null,
      codexProxyActive: proxyActive,
      codexProxyLastError: proxyActive ? null : new Error("proxy unavailable"),
      isCodexDesktopAppRunning: async () => codexRunning,
      stopCodexDesktopApp: async () => {
        events.push("quit-requested");
        if (stopError) throw stopError;
        const exit = () => {
          codexRunning = false;
          events.push("exited");
        };
        if (stopCompletesBeforeExit) setImmediate(exit);
        else {
          await new Promise((resolve) => setImmediate(resolve));
          exit();
        }
        return { ok: true, skipped: false };
      },
      waitForCodexDesktopExit: async () => {
        while (codexRunning) await new Promise((resolve) => setImmediate(resolve));
      },
      codexAccountSwitcher: {
        switchToProfile: () => {
          if (switchError) {
            events.push("auth-switch-failed");
            throw switchError;
          }
          events.push(codexRunning ? "auth-switched-while-running" : "auth-switched-after-exit");
          return { profile: { label: "두 번째 계정" } };
        },
      },
      servingBackend: {
        async selectAccount() {
          return true;
        },
      },
      launchCodexDesktopApp: async () => {
        events.push(codexRunning ? "launch-while-running" : "launch-after-exit");
        codexRunning = true;
        return { ok: true, skipped: false };
      },
      invalidateProxyAccountsCache() {},
      refreshTrayMenu() {},
      showCodexAccountBubble() {},
      appendDebugLog() {},
    }
  );

  return { events, switchCodexAccount };
}

test("Codex 계정 전환은 Desktop 종료 완료 뒤 auth를 교체하고 다시 실행한다", async () => {
  const harness = switchHarness({ stopCompletesBeforeExit: true });

  assert.equal(await harness.switchCodexAccount("second"), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.events, [
    "quit-requested",
    "exited",
    "auth-switched-after-exit",
    "launch-after-exit",
  ]);
});

test("프록시가 활성화돼도 실행 중인 Codex Desktop은 자동 재시작한다", async () => {
  const harness = switchHarness({ proxyModeRequested: true, proxyActive: true });

  assert.equal(await harness.switchCodexAccount("second"), true);

  assert.deepEqual(harness.events, [
    "quit-requested",
    "exited",
    "auth-switched-after-exit",
    "launch-after-exit",
  ]);
});

test("Codex Desktop 종료 실패 시 auth를 바꾸거나 성공으로 표시하지 않는다", async () => {
  const harness = switchHarness({ stopError: new Error("quit denied") });

  assert.equal(await harness.switchCodexAccount("second"), false);
  assert.deepEqual(harness.events, ["quit-requested"]);
});

test("Codex Desktop이 꺼져 있으면 auth만 바꾸고 앱을 임의로 실행하지 않는다", async () => {
  const harness = switchHarness({ proxyModeRequested: true, proxyActive: true, running: false });

  assert.equal(await harness.switchCodexAccount("second"), true);
  assert.deepEqual(harness.events, ["auth-switched-after-exit"]);
});

test("auth 교체 실패 시 종료했던 Codex Desktop을 기존 계정으로 복구 실행한다", async () => {
  const harness = switchHarness({ switchError: new Error("copy failed") });

  assert.equal(await harness.switchCodexAccount("second"), false);
  assert.deepEqual(harness.events, [
    "quit-requested",
    "exited",
    "auth-switch-failed",
    "launch-after-exit",
  ]);
});

test("프록시 시작 실패도 안전한 Desktop 재시작 방식으로 전환을 계속한다", async () => {
  const harness = switchHarness({ proxyModeRequested: true, proxyActive: false });

  assert.equal(await harness.switchCodexAccount("second"), true);
  assert.deepEqual(harness.events, [
    "quit-requested",
    "exited",
    "auth-switched-after-exit",
    "launch-after-exit",
  ]);
});

test("macOS Codex Desktop 제어는 표시 이름이나 CLI가 아닌 번들 ID를 사용한다", () => {
  assert.match(mainSource, /macBundleId: "com\.openai\.codex"/);
  assert.ok(mainSource.includes('`tell application id "${bundleId}" to quit`'));
  assert.match(mainSource, /\["-b", CODEX_DESKTOP_RESTART_CONFIG\.macBundleId\]/);
  const launchSource =
    mainSource.match(/function launchCodexDesktopApp\(\)[\s\S]*?\n}\n\nasync function restartCodexDesktopApp/)?.[0] || "";
  const macLaunchSource = launchSource.slice(0, launchSource.indexOf('if (process.platform !== "win32")'));
  assert.doesNotMatch(
    macLaunchSource,
    /resolveCommand\("codex"|\["app"\]/
  );
});

test("Codex Desktop 종료 대기는 실제 비실행 상태까지 polling한다", async () => {
  let now = 0;
  const states = [true, true, false];
  const waitForCodexDesktopState = vm.runInNewContext(
    `(${mainFunctionSource("waitForCodexDesktopState", "function waitForCodexDesktopExit")})`,
    {
      CODEX_DESKTOP_RESTART_CONFIG: { timeoutMs: 100, statePollMs: 10 },
      Date: { now: () => now },
      isCodexDesktopAppRunning: async () => states.shift(),
      setTimeout: (callback, delayMs) => {
        now += delayMs;
        callback();
      },
    }
  );

  assert.equal(await waitForCodexDesktopState(false), true);
  assert.deepEqual(states, []);
});

test("Codex Desktop 종료가 제한 시간을 넘으면 auth 교체 전에 실패한다", async () => {
  let now = 0;
  const waitForCodexDesktopState = vm.runInNewContext(
    `(${mainFunctionSource("waitForCodexDesktopState", "function waitForCodexDesktopExit")})`,
    {
      CODEX_DESKTOP_RESTART_CONFIG: { timeoutMs: 25, statePollMs: 10 },
      Date: { now: () => now },
      isCodexDesktopAppRunning: async () => true,
      setTimeout: (callback, delayMs) => {
        now += delayMs;
        callback();
      },
    }
  );

  await assert.rejects(
    waitForCodexDesktopState(false),
    /Codex Desktop이 제한 시간 안에 종료되지 않았습니다/
  );
});
