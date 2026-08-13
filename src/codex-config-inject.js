const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { atomicWriteText } = require("./provider-profile-store");

// CodePet-owned ~/.codex/config.toml injection for the local serving backend.
//
// Codex CLI/Desktop reads the root block: model_catalog_json (merged model
// catalog with CodePet Kimi slugs) and openai_base_url pointing at the local
// engine. Injection/removal happens only at mode toggle/startup/quit and only
// touches the marker-delimited block. Unknown root keys are treated as
// user-owned and block injection instead of being overwritten.

const CONFIG_MARKER = "# codepet-codex-proxy";
const CODEPET_PROVIDER_MARKER = "# codepet-codex-provider";
const CODEPET_PROVIDER_END_MARKER = "# /codepet-codex-provider";

function buildBaseUrlLine(port) {
  return `openai_base_url = "http://127.0.0.1:${port}/v1"`;
}

function stripCodePetProxyLines(content) {
  const lines = String(content ?? "").split("\n");
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === CONFIG_MARKER) {
      // Drop the legacy marker plus the single openai_base_url line after it.
      if (/^\s*openai_base_url\s*=/.test(lines[index + 1] || "")) index += 1;
      continue;
    }
    kept.push(lines[index]);
  }
  return kept.join("\n");
}

function knownLegacyProviderBlockEnd(lines, start) {
  const providerTable = lines.findIndex(
    (line, index) => index > start && /^\s*\[model_providers\.codepet]\s*$/.test(line)
  );
  if (providerTable === -1) return -1;

  const rootLines = lines.slice(start + 1, providerTable);
  const rootAllowed = rootLines.every((line) =>
    /^\s*$/.test(line) ||
    /^\s*model_provider\s*=\s*"codepet"\s*$/.test(line) ||
    /^\s*model_catalog_json\s*=\s*"[^"]+"\s*$/.test(line)
  );
  if (
    !rootAllowed ||
    rootLines.filter((line) => /^\s*model_provider\s*=/.test(line)).length !== 1 ||
    rootLines.filter((line) => /^\s*model_catalog_json\s*=/.test(line)).length !== 1
  ) {
    return -1;
  }

  const nextTableOffset = lines
    .slice(providerTable + 1)
    .findIndex((line) => /^\s*\[/.test(line));
  const end = nextTableOffset === -1 ? lines.length : providerTable + 1 + nextTableOffset;
  const providerLines = lines.slice(providerTable + 1, end);
  const required = [
    /^\s*name\s*=\s*"CodePet OpenAI \+ Kimi"\s*$/,
    /^\s*base_url\s*=\s*"http:\/\/127\.0\.0\.1:\d+\/v1"\s*$/,
    /^\s*wire_api\s*=\s*"responses"\s*$/,
    /^\s*requires_openai_auth\s*=\s*true\s*$/,
    /^\s*supports_websockets\s*=\s*false\s*$/,
  ];
  if (!providerLines.every((line) => /^\s*$/.test(line) || required.some((pattern) => pattern.test(line)))) {
    return -1;
  }
  if (!required.every((pattern) => providerLines.some((line) => pattern.test(line)))) return -1;
  return end;
}

function stripCodePetProvider(content) {
  const lines = String(content ?? "").split("\n");
  const kept = [...lines];
  while (true) {
    const start = kept.findIndex((line) => line.trim() === CODEPET_PROVIDER_MARKER);
    if (start === -1) break;
    const relativeEnd = kept
      .slice(start + 1)
      .findIndex((line) => line.trim() === CODEPET_PROVIDER_END_MARKER);
    if (relativeEnd === -1) {
      const legacyEnd = knownLegacyProviderBlockEnd(kept, start);
      const knownEnd = legacyEnd !== -1 ? legacyEnd : knownInjectedProviderBlockEnd(kept, start);
      if (knownEnd === -1) return String(content ?? "");
      kept.splice(start, knownEnd - start);
      continue;
    }
    kept.splice(start, relativeEnd + 2);
  }
  return kept.join("\n");
}

// The Codex app rewrites config.toml and drops the end-marker comment.
// When the lines between the start marker and the next [table] exactly match
// the current injected shape (model_catalog_json + loopback openai_base_url),
// they are CodePet-owned leftovers and safe to strip. Unknown lines mean
// user-owned content: preserve the whole file instead.
function knownInjectedProviderBlockEnd(lines, start) {
  const nextTableOffset = lines
    .slice(start + 1)
    .findIndex((line) => /^\s*\[/.test(line));
  const end = nextTableOffset === -1 ? lines.length : start + 1 + nextTableOffset;
  const blockLines = lines.slice(start + 1, end);
  const required = [
    /^\s*model_catalog_json\s*=\s*"[^"]+"\s*$/,
    /^\s*openai_base_url\s*=\s*"http:\/\/127\.0\.0\.1:\d+\/v1"\s*$/,
  ];
  if (!blockLines.every((line) => /^\s*$/.test(line) || required.some((pattern) => pattern.test(line)))) {
    return -1;
  }
  if (!required.every((pattern) => blockLines.some((line) => pattern.test(line)))) return -1;
  return end;
}

function rootConfigConflict(content) {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootLines = lines.slice(0, firstTable === -1 ? lines.length : firstTable);
  if (rootLines.some((line) => /^\s*model_provider\s*=/.test(line))) return "model_provider";
  if (rootLines.some((line) => /^\s*model_catalog_json\s*=/.test(line))) return "model_catalog_json";
  if (rootLines.some((line) => /^\s*openai_base_url\s*=/.test(line))) return "openai_base_url";
  if (lines.some((line) => /^\s*\[model_providers\.codepet]\s*$/.test(line))) {
    return "model_providers.codepet";
  }
  return null;
}

function injectCodePetProvider(content, { port, catalogPath } = {}) {
  const original = String(content ?? "");
  const cleaned = stripCodePetProxyLines(stripCodePetProvider(original));
  const conflict = rootConfigConflict(cleaned);
  if (conflict) return { content: original, conflict };
  if (!Number.isInteger(port) || port <= 0 || !catalogPath) {
    throw new Error("CodePet Codex 공급자 설정값이 올바르지 않습니다.");
  }

  const lines = cleaned.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const block = [
    CODEPET_PROVIDER_MARKER,
    `model_catalog_json = ${JSON.stringify(String(catalogPath))}`,
    buildBaseUrlLine(port),
    CODEPET_PROVIDER_END_MARKER,
  ];
  return {
    content: [...lines.slice(0, rootEnd), ...block, ...lines.slice(rootEnd)].join("\n"),
    conflict: null,
  };
}

// Root keys must precede the first [table] header. A user-set openai_base_url
// is respected: nothing is written.
function injectBaseUrl(content, port) {
  const cleaned = stripCodePetProxyLines(content);
  const lines = cleaned.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const userLine = lines
    .slice(0, rootEnd)
    .some((line) => /^\s*openai_base_url\s*=/.test(line));
  if (userLine) return { content: cleaned, keptUserBaseUrl: true };

  const block = [CONFIG_MARKER, buildBaseUrlLine(port)];
  const next = [...lines.slice(0, rootEnd), ...block, ...lines.slice(rootEnd)];
  return { content: next.join("\n"), keptUserBaseUrl: false };
}

function defaultConfigPath(codexHome = path.join(os.homedir(), ".codex")) {
  return path.join(codexHome, "config.toml");
}

function enableProxyInConfig(port, configPathOrOptions = defaultConfigPath()) {
  const options = configPathOrOptions && typeof configPathOrOptions === "object"
    ? configPathOrOptions
    : { configPath: configPathOrOptions };
  const configPath = options.configPath || defaultConfigPath();
  let content = "";
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch {
    // config.toml is created when missing.
  }
  const result = options.catalogPath
    ? injectCodePetProvider(content, { port, catalogPath: options.catalogPath })
    : injectBaseUrl(content, port);
  if (result.conflict) {
    throw new Error(
      `config.toml의 사용자 설정과 충돌합니다: ${result.conflict}. CodePet 공급자 모드를 사용하려면 해당 설정을 먼저 정리해 주세요.`
    );
  }
  if (result.keptUserBaseUrl) {
    throw new Error(
      "config.toml에 사용자가 설정한 openai_base_url이 이미 있습니다. 프록시 모드를 켜려면 그 줄을 먼저 정리해 주세요."
    );
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // atomicWriteText: temp file + rename. A crash mid-write never truncates the
  // user's config.toml.
  atomicWriteText(configPath, result.content);
}

// Rewrites config.toml only when marker lines are actually present.
function disableProxyInConfig(configPath = defaultConfigPath()) {
  let content;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch {
    return;
  }
  const stripped = stripCodePetProxyLines(stripCodePetProvider(content));
  if (stripped === content) return;
  atomicWriteText(configPath, stripped);
}

module.exports = {
  CODEPET_PROVIDER_MARKER,
  CONFIG_MARKER,
  buildBaseUrlLine,
  defaultConfigPath,
  disableProxyInConfig,
  enableProxyInConfig,
  injectCodePetProvider,
  injectBaseUrl,
  stripCodePetProvider,
  stripCodePetProxyLines,
};
