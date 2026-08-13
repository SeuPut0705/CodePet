"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  discoverManagedKimiModels,
  resolveKimiCodexModel,
} = require("../src/kimi-codex-models");

const MANAGED_CONFIG = `
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[models."kimi-code/kimi-for-coding-highspeed"]
provider = "managed:kimi-code"
model = "kimi-for-coding-highspeed"
max_context_size = 262144

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576

[models."kimi-code/k3-256k"]
provider = "managed:kimi-code"
model = "k3-256k"
max_context_size = 262144
`;

test("Codex Kimi 식별자는 허용된 네 모델만 업스트림 이름으로 해석한다", () => {
  assert.deepEqual(resolveKimiCodexModel("codepet-kimi-k3"), {
    slug: "codepet-kimi-k3",
    displayName: "Kimi K3",
    upstreamModel: "k3",
    contextWindow: 1048576,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
  });
  assert.equal(resolveKimiCodexModel("codepet-kimi-not-allowed"), null);
  assert.equal(resolveKimiCodexModel("gpt-5.6-sol"), null);
});

test("effort를 지원하지 않는 K2.7 Coding 모델은 추론 강도 목록을 만들지 않는다", () => {
  const model = resolveKimiCodexModel("codepet-kimi-k2-7-coding");
  assert.deepEqual(model.reasoningEfforts, []);
  assert.equal(model.defaultReasoningEffort, null);
});

test("관리형 Kimi 공급자에 실제 등록된 허용 모델만 발견한다", () => {
  const models = discoverManagedKimiModels({
    configPath: "/virtual/config.toml",
    readFileSync: () => MANAGED_CONFIG,
  });

  assert.deepEqual(models.map((model) => [model.slug, model.upstreamModel]), [
    ["codepet-kimi-k3", "k3"],
    ["codepet-kimi-k3-256k", "k3-256k"],
    ["codepet-kimi-k2-7-coding", "kimi-for-coding"],
    ["codepet-kimi-k2-7-coding-fast", "kimi-for-coding-highspeed"],
  ]);
});

test("사용자 지정 공급자나 관리형 URL이 아니면 Kimi 모델을 노출하지 않는다", () => {
  const customProvider = MANAGED_CONFIG.replaceAll("managed:kimi-code", "custom:kimi");
  assert.deepEqual(discoverManagedKimiModels({
    configPath: "/virtual/config.toml",
    readFileSync: () => customProvider,
  }), []);

  const customUrl = MANAGED_CONFIG.replace(
    "https://api.kimi.com/coding/v1",
    "https://example.invalid/v1"
  );
  assert.deepEqual(discoverManagedKimiModels({
    configPath: "/virtual/config.toml",
    readFileSync: () => customUrl,
  }), []);
});

test("설정 파일을 읽을 수 없으면 Kimi 모델 목록은 비어 있다", () => {
  assert.deepEqual(discoverManagedKimiModels({
    configPath: "/missing/config.toml",
    readFileSync: () => {
      throw new Error("ENOENT");
    },
  }), []);
});
