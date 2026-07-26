"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MANAGED_PROVIDER = "managed:kimi-code";
const MANAGED_BASE_URL = "https://api.kimi.com/coding/v1";

const KIMI_CODEX_MODELS = Object.freeze([
  Object.freeze({
    slug: "codepet-kimi-k3",
    displayName: "Kimi K3",
    upstreamModel: "k3",
    contextWindow: 1048576,
    reasoningEfforts: Object.freeze(["low", "high", "max"]),
    defaultReasoningEffort: "high",
  }),
  Object.freeze({
    slug: "codepet-kimi-k3-256k",
    displayName: "Kimi K3 256K",
    upstreamModel: "k3-256k",
    contextWindow: 262144,
    reasoningEfforts: Object.freeze(["low", "high", "max"]),
    defaultReasoningEffort: "high",
  }),
  Object.freeze({
    slug: "codepet-kimi-k2-7-coding",
    displayName: "Kimi K2.7 Coding",
    upstreamModel: "kimi-for-coding",
    contextWindow: 262144,
    reasoningEfforts: Object.freeze([]),
    defaultReasoningEffort: null,
  }),
  Object.freeze({
    slug: "codepet-kimi-k2-7-coding-fast",
    displayName: "Kimi K2.7 Coding Fast",
    upstreamModel: "kimi-for-coding-highspeed",
    contextWindow: 262144,
    reasoningEfforts: Object.freeze([]),
    defaultReasoningEffort: null,
  }),
]);

function cloneModel(model) {
  return {
    ...model,
    reasoningEfforts: [...model.reasoningEfforts],
  };
}

function resolveKimiCodexModel(slug) {
  const model = KIMI_CODEX_MODELS.find((candidate) => candidate.slug === slug);
  return model ? cloneModel(model) : null;
}

function parseTomlScalar(value) {
  const trimmed = String(value ?? "").trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

function safeTomlSections(content) {
  const sections = new Map();
  let current = null;
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const section = line.trim().match(/^\[([^\]]+)]$/);
    if (section) {
      current = section[1];
      if (!sections.has(current)) sections.set(current, {});
      continue;
    }
    if (!current) continue;
    const pair = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (!pair) continue;
    const key = pair[1];
    if (!["type", "base_url", "provider", "model", "max_context_size"].includes(key)) continue;
    sections.get(current)[key] = parseTomlScalar(pair[2]);
  }
  return sections;
}

function discoverManagedKimiModels({
  configPath = path.join(process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"), "config.toml"),
  readFileSync = fs.readFileSync,
} = {}) {
  let content;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }

  const sections = safeTomlSections(content);
  const provider = sections.get('providers."managed:kimi-code"');
  if (provider?.type !== "kimi" || provider?.base_url !== MANAGED_BASE_URL) return [];

  const configuredModels = new Set();
  for (const [section, values] of sections) {
    if (!section.startsWith('models."')) continue;
    if (values.provider !== MANAGED_PROVIDER || typeof values.model !== "string") continue;
    configuredModels.add(values.model);
  }

  return KIMI_CODEX_MODELS
    .filter((model) => configuredModels.has(model.upstreamModel))
    .map(cloneModel);
}

module.exports = {
  KIMI_CODEX_MODELS,
  MANAGED_BASE_URL,
  discoverManagedKimiModels,
  resolveKimiCodexModel,
};
