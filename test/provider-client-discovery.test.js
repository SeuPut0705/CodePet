const test = require("node:test");
const assert = require("node:assert/strict");

const {
  cliCandidates,
  cliNames,
  discoverProviderClients,
  geminiUserDir,
  openCodeStoragePaths,
} = require("../src/provider-client-discovery");

test("macOS의 앱과 셸 PATH 밖 CLI를 공급자별로 함께 감지한다", () => {
  const existing = new Set([
    "/Applications/Claude.app",
    "/Applications/Cursor.app",
    "/opt/homebrew/bin/claude",
    "/opt/homebrew/bin/opencode",
  ]);
  const detected = discoverProviderClients({
    platform: "darwin",
    homeDir: "/Users/tester",
    exists: (candidate) => existing.has(candidate),
    resolveCommand: (name, candidates) => candidates.find((candidate) => existing.has(candidate)) || null,
  });

  assert.deepEqual(detected.claude.clients, [
    { kind: "app", label: "앱", detected: true },
    { kind: "cli", label: "CLI", detected: true },
  ]);
  assert.deepEqual(detected.cursor.clients, [
    { kind: "app", label: "앱", detected: true },
  ]);
  assert.deepEqual(detected.opencode.clients, [
    { kind: "cli", label: "CLI", detected: true },
  ]);
  assert.equal(detected.gemini.detected, false);
});

test("Windows는 .cmd 래퍼와 설치 앱 경로를 각각 인식한다", () => {
  const existing = new Set([
    "C:\\Users\\tester\\AppData\\Local\\Programs\\cursor\\Cursor.exe",
    "C:\\Users\\tester\\AppData\\Roaming\\npm\\gemini.cmd",
  ]);
  const detected = discoverProviderClients({
    platform: "win32",
    homeDir: "C:\\Users\\tester",
    env: {
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
      ProgramFiles: "C:\\Program Files",
    },
    exists: (candidate) => existing.has(candidate),
    resolveCommand: (name, candidates) => candidates.find((candidate) => existing.has(candidate)) || null,
  });

  assert.equal(detected.cursor.detected, true);
  assert.equal(detected.gemini.detected, true);
  assert.deepEqual(detected.gemini.clients, [
    { kind: "cli", label: "CLI", detected: true },
  ]);
});

test("OpenCode 저장 경로는 운영체제별 데이터 홈을 따른다", () => {
  assert.deepEqual(openCodeStoragePaths({
    platform: "linux",
    homeDir: "/home/dev",
    env: { XDG_DATA_HOME: "/var/data" },
  }), {
    database: "/var/data/opencode/opencode.db",
    auth: "/var/data/opencode/auth.json",
  });
  assert.deepEqual(openCodeStoragePaths({
    platform: "win32",
    homeDir: "C:\\Users\\dev",
    env: { LOCALAPPDATA: "D:\\Local" },
  }), {
    database: "C:\\Users\\dev\\.local\\share\\opencode\\opencode.db",
    auth: "C:\\Users\\dev\\.local\\share\\opencode\\auth.json",
  });
});

test("GUI 앱에서도 npm·pnpm·Bun·OpenCode 설치 경로의 CLI를 찾을 수 있다", () => {
  const common = cliCandidates("codex", {
    platform: "darwin",
    homeDir: "/Users/dev",
    env: {},
  });
  assert.ok(common.includes("/Users/dev/.npm-global/bin/codex"));
  assert.ok(common.includes("/Users/dev/Library/pnpm/codex"));
  assert.ok(common.includes("/Users/dev/.bun/bin/codex"));

  const opencode = cliCandidates("opencode", {
    platform: "darwin",
    homeDir: "/Users/dev",
    env: { OPENCODE_INSTALL_DIR: "/custom/bin" },
  });
  assert.ok(opencode.includes("/custom/bin/opencode"));
  assert.ok(opencode.includes("/Users/dev/.opencode/bin/opencode"));
});

test("Cursor 최신 agent 명령과 legacy cursor-agent를 모두 감지한다", () => {
  assert.deepEqual(cliNames("cursor"), ["agent", "cursor-agent"]);
  const existing = new Set(["/Users/dev/.local/bin/agent"]);
  const detected = discoverProviderClients({
    platform: "darwin",
    homeDir: "/Users/dev",
    env: {},
    exists: (candidate) => existing.has(candidate),
    resolveCommand: (_name, candidates) => candidates.find((candidate) => existing.has(candidate)) || null,
  });
  assert.deepEqual(detected.cursor.clients, [{ kind: "cli", label: "CLI", detected: true }]);
});

test("Gemini 사용자 저장소는 GEMINI_CLI_HOME 아래 .gemini를 따른다", () => {
  assert.equal(
    geminiUserDir({ homeDir: "/Users/dev", env: { GEMINI_CLI_HOME: "/isolated/job" } }),
    "/isolated/job/.gemini"
  );
  assert.equal(geminiUserDir({ homeDir: "/Users/dev", env: {} }), "/Users/dev/.gemini");
});
