"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CODEPET_ENDPOINT_MARKER = "/codepet/v1/events/";

const PROVIDER_EVENTS = Object.freeze({
  cursor: [
    "sessionStart",
    "beforeSubmitPrompt",
    "preToolUse",
    "postToolUse",
    "afterAgentResponse",
    "stop",
    "sessionEnd",
    "subagentStart",
    "subagentStop",
  ],
  windsurf: [
    "pre_user_prompt",
    "pre_read_code",
    "post_read_code",
    "pre_write_code",
    "post_write_code",
    "pre_run_command",
    "post_run_command",
    "pre_mcp_tool_use",
    "post_mcp_tool_use",
    "post_cascade_response",
  ],
  copilot: [
    "sessionStart",
    "userPromptSubmitted",
    "preToolUse",
    "postToolUse",
    "agentStop",
    "sessionEnd",
    "subagentStart",
    "subagentStop",
    "errorOccurred",
  ],
});

function endpoint(provider, eventName, bridge) {
  return `http://127.0.0.1:${Number(bridge.port)}/codepet/v1/events/${provider}/${eventName}`;
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function bashHookCommand(provider, eventName, bridge) {
  const url = shellSingleQuote(endpoint(provider, eventName, bridge));
  const header = shellSingleQuote(`X-CodePet-Token: ${bridge.token}`);
  return `/usr/bin/curl -fsS --max-time 0.4 -H ${header} -H 'Content-Type: application/json' --data-binary @- ${url} >/dev/null 2>&1 || true`;
}

function powerShellHookCommand(provider, eventName, bridge) {
  const url = endpoint(provider, eventName, bridge).replace(/'/g, "''");
  const token = String(bridge.token).replace(/'/g, "''");
  const script = [
    "$body=[Console]::In.ReadToEnd()",
    `try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri '${url}' -Method Post -Headers @{'X-CodePet-Token'='${token}'} -ContentType 'application/json' -Body $body | Out-Null } catch {}`,
    "exit 0",
  ].join("; ");
  return `powershell.exe -NoProfile -NonInteractive -Command \"${script.replace(/"/g, '\\"')}\"`;
}

function hookCommand(provider, eventName, bridge, platform) {
  return platform === "win32"
    ? powerShellHookCommand(provider, eventName, bridge)
    : bashHookCommand(provider, eventName, bridge);
}

function isCodePetHook(hook) {
  return [hook?.command, hook?.bash, hook?.powershell, hook?.url]
    .some((value) => typeof value === "string" && value.includes(CODEPET_ENDPOINT_MARKER));
}

function mergeProviderHooks(existing, provider, bridge, platform = process.platform) {
  if (!PROVIDER_EVENTS[provider] || provider === "copilot") {
    throw new Error("지원하지 않는 hook 공급자입니다.");
  }
  const source = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const hooks = source.hooks && typeof source.hooks === "object" && !Array.isArray(source.hooks)
    ? { ...source.hooks }
    : {};
  for (const eventName of PROVIDER_EVENTS[provider]) {
    const current = Array.isArray(hooks[eventName])
      ? hooks[eventName].filter((hook) => !isCodePetHook(hook))
      : [];
    const item = {
      command: hookCommand(provider, eventName, bridge, platform),
      ...(provider === "windsurf" ? { show_output: false } : {}),
    };
    hooks[eventName] = [...current, item];
  }
  return { ...source, ...(provider === "cursor" ? { version: 1 } : {}), hooks };
}

function buildCopilotHooks(bridge) {
  const hooks = {};
  for (const eventName of PROVIDER_EVENTS.copilot) {
    hooks[eventName] = [{
      type: "command",
      bash: bashHookCommand("copilot", eventName, bridge),
      powershell: powerShellHookCommand("copilot", eventName, bridge),
      timeoutSec: 2,
    }];
  }
  return { version: 1, hooks };
}

function integrationPath(provider, homeDir = os.homedir(), env = process.env) {
  if (provider === "cursor") return path.join(homeDir, ".cursor", "hooks.json");
  if (provider === "windsurf") return path.join(homeDir, ".codeium", "windsurf", "hooks.json");
  if (provider === "copilot") {
    return path.join(env.COPILOT_HOME || path.join(homeDir, ".copilot"), "hooks", "codepet.json");
  }
  return null;
}

function readJson(file, { strict = false } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    if (strict) throw new Error("object-required");
    return {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (!strict) return {};
    throw new Error(`기존 hook 설정 JSON이 올바르지 않아 덮어쓰지 않았습니다: ${file}`);
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.codepet-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempFile, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows ACL은 chmod와 의미가 달라 실패해도 설치 자체는 유지합니다.
    }
  } finally {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {
      // 임시 파일 정리 실패는 원본 설정을 손상시키지 않습니다.
    }
  }
}

function installProviderIntegration(provider, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const bridge = options.bridge;
  if (!bridge?.port || !bridge?.token) throw new Error("CodePet 이벤트 브리지가 준비되지 않았습니다.");
  const file = integrationPath(provider, homeDir, env);
  if (!file) throw new Error("이 공급자는 hook 연결을 지원하지 않습니다.");
  const next = provider === "copilot"
    ? buildCopilotHooks(bridge)
    : mergeProviderHooks(readJson(file, { strict: true }), provider, bridge, options.platform || process.platform);
  writeJsonAtomic(file, next);
  return { file, connected: true };
}

function providerIntegrationStatus(provider, options = {}) {
  const file = integrationPath(
    provider,
    options.homeDir || os.homedir(),
    options.env || process.env
  );
  if (!file) return false;
  const config = readJson(file);
  return Object.values(config.hooks || {}).some((entries) =>
    Array.isArray(entries) && entries.some(isCodePetHook)
  );
}

module.exports = {
  CODEPET_ENDPOINT_MARKER,
  PROVIDER_EVENTS,
  bashHookCommand,
  buildCopilotHooks,
  hookCommand,
  installProviderIntegration,
  integrationPath,
  isCodePetHook,
  mergeProviderHooks,
  powerShellHookCommand,
  providerIntegrationStatus,
  writeJsonAtomic,
};
