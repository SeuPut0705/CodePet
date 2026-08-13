const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

test("main process는 네이티브·DB·hook watcher를 모두 수명주기에 연결한다", () => {
  for (const name of [
    "geminiWatcher",
    "copilotWatcher",
    "cursorWatcher",
    "opencodeWatcher",
    "windsurfWatcher",
  ]) {
    assert.match(main, new RegExp(`registerExternalWatcher\\(${name},`));
    assert.match(main, new RegExp(`${name}\\.start\\(\\)`));
    assert.match(main, new RegExp(`${name}\\.stop\\(\\)`));
  }
  assert.match(main, /ensureProviderHookBridge\(\)/);
  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
  assert.match(main, /app\.on\("second-instance"/);
});

test("설정 계정 action은 전체 공급자 login과 관리형 계정 switch·delete를 분리한다", () => {
  assert.match(main, /PROVIDER_IDS\.includes\(provider\)/);
  assert.match(main, /succeeded = await startProviderLogin\(provider\)/);
  assert.match(main, /\["kimi", "gemini"\]/);
  assert.match(main, /\["copilot", "cursor", "windsurf"\]/);
  assert.match(main, /installProviderIntegration\(provider, \{ bridge \}\)/);
  assert.match(main, /const command = resolveProviderCommand\(provider\);[\s\S]+const appPath = resolveProviderApp\(provider\);[\s\S]+ensureProviderHookBridge\(\)/);
  assert.match(main, /provider === "opencode"[\s\S]+openProviderApp\(provider\)/);
});

test("설정 공급자 데이터는 앱·CLI와 hook 연결 상태를 함께 합친다", () => {
  assert.match(main, /discoverProviderClients\(\{ resolveCommand \}\)/);
  assert.match(main, /connected: providerIntegrationStatus\(provider\)/);
  assert.match(main, /geminiAccountRows\(\)/);
  assert.match(main, /path\.join\(geminiUserDir\(\), "google_accounts\.json"\)/);
});

test("Gemini 계정 추가는 인증 선택 화면을 바로 연다", () => {
  assert.match(main, /gemini: \{ args: \["--prompt-interactive", "\/auth"\]/);
});
