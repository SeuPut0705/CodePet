"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildMergedModelCatalog,
  prepareCodexModelCatalog,
} = require("../src/codex-model-catalog");

const OPENAI_MODEL = {
  slug: "gpt-test",
  display_name: "GPT Test",
  description: "OpenAI fixture",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [
    { effort: "low", description: "Low" },
    { effort: "medium", description: "Medium" },
    { effort: "high", description: "High" },
  ],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  service_tiers: [{ id: "priority", name: "Fast", description: "Fast tier" }],
  base_instructions: "fixture instructions",
  model_messages: { instructions_template: "fixture instructions" },
  context_window: 200000,
  max_context_window: 200000,
  supports_parallel_tool_calls: true,
  input_modalities: ["text", "image"],
  supports_search_tool: true,
  tool_mode: "code_mode_only",
};

const KIMI_MODEL = {
  slug: "codepet-kimi-k3",
  displayName: "Kimi K3",
  upstreamModel: "k3",
  contextWindow: 1048576,
  reasoningEfforts: ["low", "high", "max"],
  defaultReasoningEffort: "high",
};

test("병합 카탈로그는 OpenAI 모델을 보존하고 Kimi 모델 메타데이터를 추가한다", () => {
  const bundled = { models: [structuredClone(OPENAI_MODEL)] };
  const merged = buildMergedModelCatalog(bundled, [KIMI_MODEL]);

  assert.deepEqual(merged.models[0], OPENAI_MODEL);
  assert.deepEqual(merged.models[1].supported_reasoning_levels, [
    { effort: "low", description: "빠른 응답" },
    { effort: "high", description: "깊은 추론" },
    { effort: "max", description: "최대 추론" },
  ]);
  assert.equal(merged.models[1].slug, "codepet-kimi-k3");
  assert.equal(merged.models[1].display_name, "Kimi K3");
  assert.equal(merged.models[1].default_reasoning_level, "high");
  assert.equal(merged.models[1].context_window, 1048576);
  assert.equal(merged.models[1].max_context_window, 1048576);
  assert.equal(merged.models[1].supports_search_tool, false);
  assert.deepEqual(merged.models[1].service_tiers, []);
});

test("이미 존재하는 Kimi slug는 중복으로 추가하지 않는다", () => {
  const existing = { ...OPENAI_MODEL, slug: "codepet-kimi-k3" };
  const merged = buildMergedModelCatalog({ models: [existing] }, [KIMI_MODEL]);
  assert.equal(merged.models.length, 1);
  assert.deepEqual(merged.models[0], existing);
});

test("Codex 내장 카탈로그를 읽어 userData에 원자적으로 준비한다", (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-catalog-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  let invocation = null;

  const result = prepareCodexModelCatalog({
    codexCommand: "/virtual/codex",
    userDataDir,
    kimiModels: [KIMI_MODEL],
    spawnSyncImpl: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: JSON.stringify({ models: [OPENAI_MODEL] }), stderr: "" };
    },
  });

  assert.equal(invocation.command, "/virtual/codex");
  assert.deepEqual(invocation.args, ["debug", "models", "--bundled"]);
  assert.equal(invocation.options.timeout, 10000);
  assert.equal(result.kimiModelCount, 1);
  assert.equal(result.catalogPath, path.join(userDataDir, "codepet-codex-models.json"));
  const saved = JSON.parse(fs.readFileSync(result.catalogPath, "utf8"));
  assert.deepEqual(saved.models.map((model) => model.slug), ["gpt-test", "codepet-kimi-k3"]);
  assert.equal(fs.statSync(result.catalogPath).mode & 0o777, 0o600);
});

test("Codex 내장 카탈로그가 잘못되면 기존 카탈로그 파일을 보존한다", (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-catalog-invalid-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const catalogPath = path.join(userDataDir, "codepet-codex-models.json");
  fs.writeFileSync(catalogPath, '{"models":[{"slug":"preserved"}]}', { mode: 0o600 });

  assert.throws(() => prepareCodexModelCatalog({
    codexCommand: "/virtual/codex",
    userDataDir,
    kimiModels: [KIMI_MODEL],
    spawnSyncImpl: () => ({ status: 0, stdout: "not-json", stderr: "" }),
  }), /모델 카탈로그/);
  assert.deepEqual(JSON.parse(fs.readFileSync(catalogPath, "utf8")), {
    models: [{ slug: "preserved" }],
  });
});
