const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const {
  SUPPORTED,
  STRINGS,
  resolveLanguage,
  translate,
  dateLocale,
} = require("../src/settings-i18n");

test("4개 언어 사전은 동일한 키 집합을 가진다", () => {
  const base = Object.keys(STRINGS.ko).sort();
  assert.ok(base.length > 50);
  for (const lang of SUPPORTED) {
    assert.deepEqual(Object.keys(STRINGS[lang]).sort(), base, lang);
  }
});

test("settings.html의 data-i18n 키는 모두 한국어 사전에 있다", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "settings.html"), "utf8");
  const keys = new Set();
  for (const match of html.matchAll(/data-i18n(?:-placeholder|-aria)?="([^"]+)"/g)) {
    keys.add(match[1]);
  }
  assert.ok(keys.size > 30);
  for (const key of keys) assert.ok(key in STRINGS.ko, key);
});

test("언어 해석은 명시 선택을 우선하고 시스템 로케일을 4개 언어로 매핑한다", () => {
  assert.equal(resolveLanguage("en", "ko-KR"), "en");
  assert.equal(resolveLanguage("system", "ko-KR"), "ko");
  assert.equal(resolveLanguage("system", "en-US"), "en");
  assert.equal(resolveLanguage("system", "ja-JP"), "ja");
  assert.equal(resolveLanguage("system", "zh-CN"), "zh-CN");
  assert.equal(resolveLanguage("system", "zh-TW"), "zh-CN");
  assert.equal(resolveLanguage("system", "fr-FR"), "ko");
});

test("translate는 변수를 치환하고 누락 키는 한국어로 폴백한다", () => {
  assert.equal(translate("en", "font.count", { count: 3 }), "3 fonts");
  assert.equal(translate("ja", "accounts.current"), "現在");
  assert.equal(translate("en", "없는 키"), translate("ko", "없는 키"));
  assert.equal(dateLocale("ja"), "ja-JP");
  assert.equal(dateLocale("zh-CN"), "zh-CN");
});
