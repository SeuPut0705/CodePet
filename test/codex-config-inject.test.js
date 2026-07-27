const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CODEPET_PROVIDER_MARKER,
  CONFIG_MARKER,
  buildBaseUrlLine,
  disableProxyInConfig,
  enableProxyInConfig,
  injectCodePetProvider,
  injectBaseUrl,
  stripCodePetProvider,
  stripCodePetProxyLines,
} = require("../src/codex-config-inject");

test("config 주입은 루트 영역의 첫 테이블 앞에 marker와 base_url을 넣는다", () => {
  const content = ['model = "gpt-5"', "", "[plugins.chrome]", 'x = "y"'].join("\n");
  const result = injectBaseUrl(content, 10161);
  const lines = result.content.split("\n");
  const markerIndex = lines.indexOf(CONFIG_MARKER);

  assert.equal(result.keptUserBaseUrl, false);
  assert.ok(markerIndex >= 0);
  assert.equal(lines[markerIndex + 1], buildBaseUrlLine(10161));
  assert.ok(markerIndex < lines.indexOf("[plugins.chrome]"));
});

test("config 주입은 멱등이고 사용자 소유 openai_base_url은 존중한다", () => {
  const first = injectBaseUrl("", 10161).content;
  const second = injectBaseUrl(first, 10162).content;
  assert.equal(second.split("\n").filter((line) => line === CONFIG_MARKER).length, 1);
  assert.match(second, /10162/);
  assert.doesNotMatch(second, /10161/);

  const userOwned = injectBaseUrl('openai_base_url = "http://127.0.0.1:9/v1"', 10161);
  assert.equal(userOwned.keptUserBaseUrl, true);
  assert.doesNotMatch(userOwned.content, /10161/);
});

test("config 제거는 marker와 그 다음 base_url 줄만 걷어낸다", () => {
  const injected = injectBaseUrl(['model = "gpt-5"', "[a]", 'b = "c"'].join("\n"), 10161).content;
  const stripped = stripCodePetProxyLines(injected);
  assert.doesNotMatch(stripped, /codepet-codex-proxy|openai_base_url/);
  assert.match(stripped, /model = "gpt-5"/);
  assert.match(stripped, /\[a\]/);
});

test("CodePet 공급자 설정은 카탈로그와 built-in openai 프록시 주소만 소유 블록으로 넣는다", () => {
  const result = injectCodePetProvider(
    ['model = "gpt-5"', "", "[plugins.chrome]", 'x = "y"'].join("\n"),
    { port: 10161, catalogPath: "/tmp/codepet models.json" }
  );

  assert.equal(result.conflict, null);
  assert.match(result.content, new RegExp(CODEPET_PROVIDER_MARKER));
  assert.match(result.content, /model_catalog_json = "\/tmp\/codepet models\.json"/);
  assert.match(result.content, /openai_base_url = "http:\/\/127\.0\.0\.1:10161\/v1"/);
  assert.doesNotMatch(result.content, /^model_provider\s*=/m);
  assert.doesNotMatch(result.content, /^\[model_providers\.codepet\]$/m);
  assert.ok(result.content.indexOf('model_catalog_json = "/tmp/codepet models.json"') < result.content.indexOf("[plugins.chrome]"));
});

test("Kimi 카탈로그를 연결해도 기존 openai 세션 공급자를 유지한다", () => {
  const result = injectCodePetProvider('model = "gpt-5"\n', {
    port: 10161,
    catalogPath: "/tmp/codepet-models.json",
  });

  assert.equal(result.conflict, null);
  assert.match(result.content, /openai_base_url = "http:\/\/127\.0\.0\.1:10161\/v1"/);
  assert.match(result.content, /model_catalog_json = "\/tmp\/codepet-models\.json"/);
  assert.doesNotMatch(result.content, /^model_provider\s*=/m);
  assert.doesNotMatch(result.content, /^\[model_providers\.codepet\]$/m);
});

test("CodePet 공급자 설정은 멱등이고 제거 시 자기 블록만 걷어낸다", () => {
  const original = ['model = "gpt-5"', "[plugins.chrome]", 'x = "y"'].join("\n");
  const first = injectCodePetProvider(original, {
    port: 10161,
    catalogPath: "/tmp/one.json",
  }).content;
  const second = injectCodePetProvider(first, {
    port: 10162,
    catalogPath: "/tmp/two.json",
  }).content;

  assert.equal(second.split(CODEPET_PROVIDER_MARKER).length - 1, 1);
  assert.match(second, /10162/);
  assert.match(second, /\/tmp\/two\.json/);
  assert.doesNotMatch(second, /10161|\/tmp\/one\.json/);
  assert.equal(stripCodePetProvider(second).trim(), original.trim());
});

test("끝 마커가 없는 손상된 CodePet 공급자 블록은 사용자 설정과 함께 보존한다", () => {
  const damaged = [
    'model = "gpt-test"',
    CODEPET_PROVIDER_MARKER,
    'model_provider = "codepet"',
    "[plugins.chrome]",
    'enabled = true',
  ].join("\n");
  assert.equal(stripCodePetProvider(damaged), damaged);
});

test("끝 마커가 사라진 기존 CodePet 공급자 블록은 안전한 known shape이면 마이그레이션한다", () => {
  const legacy = [
    'model = "gpt-test"',
    CODEPET_PROVIDER_MARKER,
    'model_provider = "codepet"',
    'model_catalog_json = "/tmp/old.json"',
    "",
    "[model_providers.codepet]",
    'name = "CodePet OpenAI + Kimi"',
    'base_url = "http://127.0.0.1:10161/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
    "",
    "[plugins.chrome]",
    "enabled = true",
  ].join("\n");

  const result = injectCodePetProvider(legacy, {
    port: 10162,
    catalogPath: "/tmp/new.json",
  });

  assert.equal(result.conflict, null);
  assert.match(result.content, /model_catalog_json = "\/tmp\/new\.json"/);
  assert.match(result.content, /openai_base_url = "http:\/\/127\.0\.0\.1:10162\/v1"/);
  assert.match(result.content, /\[plugins\.chrome\]\nenabled = true/);
  assert.doesNotMatch(result.content, /^model_provider\s*=/m);
  assert.doesNotMatch(result.content, /^\[model_providers\.codepet\]$/m);
  assert.doesNotMatch(result.content, /\/tmp\/old\.json|10161/);
});

test("끝 마커가 사라진 현재 CodePet 공급자 블록은 안전한 known shape이면 마이그레이션한다", () => {
  const stale = [
    'model = "gpt-test"',
    CODEPET_PROVIDER_MARKER,
    'model_catalog_json = "/tmp/old.json"',
    'openai_base_url = "http://127.0.0.1:10161/v1"',
    "",
    "[plugins.chrome]",
    "enabled = true",
  ].join("\n");

  const result = injectCodePetProvider(stale, {
    port: 10162,
    catalogPath: "/tmp/new.json",
  });

  assert.equal(result.conflict, null);
  assert.match(result.content, /model_catalog_json = "\/tmp\/new\.json"/);
  assert.match(result.content, /openai_base_url = "http:\/\/127\.0\.0\.1:10162\/v1"/);
  assert.match(result.content, /\[plugins\.chrome\]\nenabled = true/);
  assert.doesNotMatch(result.content, /\/tmp\/old\.json|10161/);
});

test("CodePet 공급자 설정은 사용자 소유 충돌을 덮어쓰지 않는다", () => {
  const cases = [
    ['model_provider = "custom"', "model_provider"],
    ['model_catalog_json = "/tmp/custom.json"', "model_catalog_json"],
    ['openai_base_url = "http://127.0.0.1:9/v1"', "openai_base_url"],
    ['[model_providers.codepet]\nbase_url = "http://custom"', "model_providers.codepet"],
  ];

  for (const [content, conflict] of cases) {
    const result = injectCodePetProvider(content, {
      port: 10161,
      catalogPath: "/tmp/codepet.json",
    });
    assert.equal(result.conflict, conflict);
    assert.equal(result.content, content);
  }
});

test("enableProxyInConfig는 카탈로그 경로가 있으면 built-in openai 프록시 설정을 원자 저장한다", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-provider-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.toml");
  fs.writeFileSync(configPath, 'model = "gpt-test"\n', "utf8");

  const { enableProxyInConfig, disableProxyInConfig } = require("../src/codex-config-inject");
  enableProxyInConfig(19401, {
    configPath,
    catalogPath: "/tmp/codepet-catalog.json",
  });
  const enabled = fs.readFileSync(configPath, "utf8");
  assert.match(enabled, /model_catalog_json = "\/tmp\/codepet-catalog\.json"/);
  assert.match(enabled, /openai_base_url = "http:\/\/127\.0\.0\.1:19401\/v1"/);
  assert.doesNotMatch(enabled, /^model_provider\s*=/m);

  disableProxyInConfig(configPath);
  assert.equal(fs.readFileSync(configPath, "utf8").trim(), 'model = "gpt-test"');
});

test("disableProxyInConfig는 마커가 없으면 파일을 건드리지 않는다", () => {
  const { disableProxyInConfig, enableProxyInConfig } = require("../src/codex-config-inject");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-cfg-"));
  const cfg = path.join(dir, "config.toml");
  try {
    fs.writeFileSync(cfg, 'model = "gpt-5"\n');
    const before = fs.statSync(cfg).mtimeMs;
    disableProxyInConfig(cfg);
    // 마커가 없으므로 재기록되지 않아야 함 (내용 동일)
    assert.equal(fs.readFileSync(cfg, "utf8"), 'model = "gpt-5"\n');

    enableProxyInConfig(19999, cfg);
    assert.match(fs.readFileSync(cfg, "utf8"), /codepet-codex-proxy/);
    disableProxyInConfig(cfg);
    assert.doesNotMatch(fs.readFileSync(cfg, "utf8"), /codepet-codex-proxy/);
    assert.match(fs.readFileSync(cfg, "utf8"), /model = "gpt-5"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
