const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildCopilotHooks,
  installProviderIntegration,
  mergeProviderHooks,
  providerIntegrationStatus,
  integrationPath,
} = require("../src/provider-integrations");

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-integrations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const bridge = { port: 43721, token: "safe-token" };

test("Cursor 연결은 기존 hooks를 보존하고 CodePet 항목을 중복 없이 병합한다", () => {
  const existing = {
    version: 1,
    hooks: { beforeSubmitPrompt: [{ command: "/usr/local/bin/existing-hook" }] },
  };
  const once = mergeProviderHooks(existing, "cursor", bridge, "darwin");
  const twice = mergeProviderHooks(once, "cursor", bridge, "darwin");

  assert.equal(twice.hooks.beforeSubmitPrompt[0].command, "/usr/local/bin/existing-hook");
  assert.equal(twice.hooks.beforeSubmitPrompt.length, 2);
  assert.match(twice.hooks.beforeSubmitPrompt[1].command, /127\.0\.0\.1:43721/);
  assert.match(twice.hooks.subagentStart[0].command, /subagentStart/);
});

test("Copilot 개인 hook은 공식 version 1 형식과 main-agent 이벤트를 사용한다", () => {
  const hooks = buildCopilotHooks(bridge);
  assert.equal(hooks.version, 1);
  assert.ok(hooks.hooks.userPromptSubmitted.length > 0);
  assert.ok(hooks.hooks.agentStop.length > 0);
  assert.ok(hooks.hooks.subagentStart.length > 0);
  assert.ok(hooks.hooks.subagentStop.length > 0);
  assert.match(hooks.hooks.agentStop[0].bash, /agentStop/);
});

test("연결 설치는 사용자 설정을 원자적으로 쓰고 다시 실행해도 동일하다", () => {
  const homeDir = tempDir({ after: () => {} });
  fs.mkdirSync(path.join(homeDir, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".cursor", "hooks.json"), JSON.stringify({
    version: 1,
    hooks: { stop: [{ command: "existing" }] },
  }));

  installProviderIntegration("cursor", { homeDir, bridge, platform: "darwin" });
  const first = fs.readFileSync(path.join(homeDir, ".cursor", "hooks.json"), "utf8");
  installProviderIntegration("cursor", { homeDir, bridge, platform: "darwin" });
  const second = fs.readFileSync(path.join(homeDir, ".cursor", "hooks.json"), "utf8");

  assert.equal(second, first);
  assert.equal(providerIntegrationStatus("cursor", { homeDir }), true);
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test("손상된 기존 Cursor hook 설정은 덮어쓰지 않는다", (t) => {
  const homeDir = tempDir(t);
  const file = path.join(homeDir, ".cursor", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"hooks":');

  assert.throws(
    () => installProviderIntegration("cursor", { homeDir, bridge, platform: "darwin" }),
    /덮어쓰지 않았습니다/
  );
  assert.equal(fs.readFileSync(file, "utf8"), '{"hooks":');
});

test("Copilot hook 경로는 COPILOT_HOME을 따른다", (t) => {
  const homeDir = tempDir(t);
  const copilotHome = path.join(homeDir, "custom-copilot");
  const env = { COPILOT_HOME: copilotHome };

  assert.equal(
    integrationPath("copilot", homeDir, env),
    path.join(copilotHome, "hooks", "codepet.json")
  );
  installProviderIntegration("copilot", { homeDir, env, bridge });
  assert.equal(providerIntegrationStatus("copilot", { homeDir, env }), true);
});
