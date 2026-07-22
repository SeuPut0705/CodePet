const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  PROVIDER_IDS,
  getProviderDefinition,
  listProviderDefinitions,
} = require("../src/provider-catalog");

test("주요 코딩 공급자는 실제 로컬 아이콘과 지원 기능을 한 레지스트리에서 제공한다", () => {
  assert.deepEqual(PROVIDER_IDS, [
    "codex",
    "agy",
    "claude",
    "kimi",
    "gemini",
    "copilot",
    "cursor",
    "opencode",
    "windsurf",
  ]);

  const providers = listProviderDefinitions();
  assert.equal(providers.length, PROVIDER_IDS.length);
  for (const provider of providers) {
    assert.equal(provider.id, getProviderDefinition(provider.id).id);
    assert.match(provider.icon, /^\.\/provider-icons\/[a-z0-9-]+\.svg$/);
    assert.equal(
      fs.existsSync(path.join(__dirname, "..", "src", provider.icon.slice(2))),
      true,
      `${provider.id} icon is bundled`
    );
    assert.equal(typeof provider.capabilities.activity, "boolean");
    assert.equal(typeof provider.capabilities.accounts, "boolean");
    assert.equal(typeof provider.capabilities.usage, "boolean");
  }
});

test("공식 한도 표면이 없는 공급자는 사용량 지원으로 표시하지 않는다", () => {
  assert.equal(getProviderDefinition("codex").capabilities.usage, true);
  assert.equal(getProviderDefinition("claude").capabilities.usage, true);
  assert.equal(getProviderDefinition("kimi").capabilities.usage, true);
  assert.equal(getProviderDefinition("cursor").capabilities.usage, false);
  assert.equal(getProviderDefinition("opencode").capabilities.usage, false);
  assert.equal(getProviderDefinition("windsurf").capabilities.usage, false);
});

test("공급자 카탈로그는 실제로 감시하는 앱과 CLI 표면만 선언한다", () => {
  assert.deepEqual(getProviderDefinition("agy").clients, ["app"]);
  assert.deepEqual(getProviderDefinition("kimi").clients, ["cli"]);
  assert.deepEqual(getProviderDefinition("cursor").clients, ["app", "cli"]);
});
