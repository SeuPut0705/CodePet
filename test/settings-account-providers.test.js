const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  accountProviderMenuItems,
  buildSettingsAccountProviders,
  connectedAccountProviders,
} = require("../src/settings-account-providers");

const settingsHtml = fs.readFileSync(path.join(__dirname, "..", "src", "settings.html"), "utf8");

test("계정 목록은 인식된 계정이 하나 이상 있는 provider만 보여준다", () => {
  const codex = { id: "codex", label: "Codex", accounts: [{ key: "main" }] };
  const future = { id: "future", label: "Future", accounts: [{ key: "detected" }] };

  assert.deepEqual(connectedAccountProviders([
    codex,
    { id: "agy", label: "AGY", accounts: [] },
    { id: "claude", label: "Claude" },
    future,
    null,
  ]), [codex, future]);
  assert.deepEqual(connectedAccountProviders(null), []);

  assert.ok(
    settingsHtml.indexOf("./settings-account-providers.js") <
      settingsHtml.indexOf("./settings.js")
  );
});

test("계정 추가 버튼은 지원하는 전체 공급자 선택 메뉴를 연다", () => {
  const providers = buildSettingsAccountProviders({
    codex: [{ key: "main" }],
    agy: [],
    claude: [],
  });
  assert.deepEqual(accountProviderMenuItems([
    ...providers,
    { id: "future", label: "Future", accounts: [], canAddAccount: false },
  ]).map((item) => item.id), [
    "codex", "agy", "claude", "kimi", "gemini", "copilot", "cursor", "opencode", "windsurf",
  ]);
  assert.match(accountProviderMenuItems(providers)[0].icon, /provider-icons\/codex\.svg$/);
  assert.equal(providers.every((provider) => provider.canAddAccount === true), true);

  assert.match(
    settingsHtml,
    /id="add-account"[^>]+aria-haspopup="menu"[^>]+aria-expanded="false"/
  );
  assert.match(settingsHtml, /id="account-provider-menu"[^>]+role="menu"[^>]+hidden/);
});

test("공급자 연결 상태와 아이콘은 계정 카드까지 유지된다", () => {
  const providers = buildSettingsAccountProviders(
    { cursor: [] },
    {
      cursor: {
        detected: true,
        connected: true,
        clients: [{ kind: "app", label: "앱", detected: true }],
      },
    }
  );
  const cursor = providers.find((provider) => provider.id === "cursor");

  assert.match(cursor.icon, /provider-icons\/cursor\.svg$/);
  assert.equal(cursor.connected, true);
  assert.deepEqual(cursor.clients, [{ kind: "app", label: "앱", detected: true }]);
});

test("계정이 없어도 설치된 앱이나 CLI는 연결 대상으로 보여준다", () => {
  const providers = buildSettingsAccountProviders(
    { codex: [], cursor: [], opencode: [] },
    {
      codex: { detected: false, clients: [] },
      cursor: { detected: true, clients: [{ kind: "app", label: "앱", detected: true }] },
      opencode: { detected: true, clients: [{ kind: "cli", label: "CLI", detected: true }] },
    }
  );

  assert.deepEqual(
    connectedAccountProviders(providers).map((provider) => provider.id),
    ["cursor", "opencode"]
  );
  assert.equal(accountProviderMenuItems(providers).length, 9);
});
