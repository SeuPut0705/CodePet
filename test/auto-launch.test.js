const test = require("node:test");
const assert = require("node:assert/strict");

const {
  clearUnsupportedAutoLaunch,
  getLoginItemOptions,
  isAutoLaunchSupported,
} = require("../src/auto-launch");

test("macOS 개발 모드는 Electron.app 자동 실행을 등록하지 않는다", () => {
  const context = {
    platform: "darwin",
    isPackaged: false,
    execPath: "/project/node_modules/electron/Electron",
    appPath: "/project/CodePet",
  };

  assert.equal(isAutoLaunchSupported(context), false);
  assert.deepEqual(getLoginItemOptions(context), {});
});

test("macOS 개발 모드 시작 시 기존 Electron 로그인 항목을 제거한다", () => {
  const calls = [];
  const app = {
    getLoginItemSettings: () => ({ openAtLogin: true, status: "enabled" }),
    setLoginItemSettings: (settings) => calls.push(settings),
  };

  const removed = clearUnsupportedAutoLaunch(app, {
    platform: "darwin",
    isPackaged: false,
  });

  assert.equal(removed, true);
  assert.deepEqual(calls, [{ openAtLogin: false }]);
});

test("패키징된 macOS 앱과 Windows 개발 실행의 자동 실행 경로를 보존한다", () => {
  assert.equal(isAutoLaunchSupported({ platform: "darwin", isPackaged: true }), true);
  assert.deepEqual(getLoginItemOptions({ platform: "darwin", isPackaged: true }), {});

  const windows = {
    platform: "win32",
    isPackaged: false,
    execPath: "C:\\project\\electron.exe",
    appPath: "C:\\project\\CodePet",
  };
  assert.equal(isAutoLaunchSupported(windows), true);
  assert.deepEqual(getLoginItemOptions(windows), {
    path: windows.execPath,
    args: [windows.appPath],
  });
});
