"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { atomicWrite } = require("./provider-profile-store");

const REASONING_DESCRIPTIONS = Object.freeze({
  low: "빠른 응답",
  high: "깊은 추론",
  max: "최대 추론",
});

function assertBundledCatalog(value) {
  if (!value || !Array.isArray(value.models) || value.models.length === 0) {
    throw new Error("Codex 내장 모델 카탈로그 형식이 올바르지 않습니다.");
  }
  if (value.models.some((model) => !model || typeof model.slug !== "string")) {
    throw new Error("Codex 내장 모델 카탈로그 항목이 올바르지 않습니다.");
  }
}

function modelTemplate(models) {
  return models.find((model) =>
    model.visibility === "list" &&
    model.supported_in_api !== false &&
    typeof model.base_instructions === "string"
  ) || models[0];
}

function kimiCatalogEntry(template, model, priority) {
  const cloned = structuredClone(template);
  return {
    ...cloned,
    slug: model.slug,
    display_name: model.displayName,
    description: `${model.displayName} via the existing Kimi Code account.`,
    default_reasoning_level: model.defaultReasoningEffort || model.reasoningEfforts[0] || null,
    supported_reasoning_levels: model.reasoningEfforts.map((effort) => ({
      effort,
      description: REASONING_DESCRIPTIONS[effort] || effort,
    })),
    visibility: "list",
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    effective_context_window_percent: 95,
    supports_search_tool: false,
    input_modalities: ["text", "image"],
  };
}

function buildMergedModelCatalog(bundled, kimiModels) {
  assertBundledCatalog(bundled);
  const models = bundled.models.map((model) => structuredClone(model));
  const existingSlugs = new Set(models.map((model) => model.slug));
  const template = modelTemplate(models);
  const maxPriority = Math.max(0, ...models.map((model) => Number(model.priority) || 0));

  for (const [index, model] of (kimiModels || []).entries()) {
    if (!model || existingSlugs.has(model.slug)) continue;
    models.push(kimiCatalogEntry(template, model, maxPriority + index + 1));
    existingSlugs.add(model.slug);
  }

  return { ...structuredClone(bundled), models };
}

function prepareCodexModelCatalog({
  codexCommand,
  userDataDir,
  kimiModels,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!codexCommand || !userDataDir) {
    throw new Error("Codex 모델 카탈로그 준비 경로가 올바르지 않습니다.");
  }
  const result = spawnSyncImpl(codexCommand, ["debug", "models", "--bundled"], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  if (result?.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("Codex 내장 모델 카탈로그를 읽지 못했습니다.");
  }

  let bundled;
  try {
    bundled = JSON.parse(result.stdout);
    assertBundledCatalog(bundled);
  } catch {
    throw new Error("Codex 내장 모델 카탈로그를 처리하지 못했습니다.");
  }

  const merged = buildMergedModelCatalog(bundled, kimiModels || []);
  const catalogPath = path.join(userDataDir, "codepet-codex-models.json");
  atomicWrite(catalogPath, merged);
  return {
    catalogPath,
    kimiModelCount: merged.models.length - bundled.models.length,
  };
}

module.exports = {
  buildMergedModelCatalog,
  prepareCodexModelCatalog,
};
