const test = require("node:test");
const assert = require("node:assert/strict");
const { buildKimiUsageBadges, buildKimiUsageGauges, parseKimiUsageWindows } = require("../src/kimi-usage");

test("Kimi weekly summary와 5시간 window를 남은 퍼센트로 만든다", () => {
  const payload = {
    usage: { used: 57, limit: 100, name: "Weekly limit" },
    limits: [{
      window: { duration: 5, timeUnit: "HOUR" },
      detail: { used: 28, limit: 100 },
    }],
  };
  assert.deepEqual(buildKimiUsageBadges(payload), [
    { key: "5h", remainingPercent: 72, ariaLabel: "Kimi 5시간 72% 남음" },
    { key: "7d", remainingPercent: 43, ariaLabel: "Kimi 7일 43% 남음" },
  ]);
});

test("Kimi remaining 필드와 숫자 문자열을 안전하게 정규화한다", () => {
  const payload = {
    usage: { remaining: "31", limit: "100" },
    limits: [{ duration: 300, timeUnit: "MINUTE", remaining: 82, limit: 100 }],
  };
  assert.deepEqual(parseKimiUsageWindows(payload), [
    { minutes: 300, used: 18, limit: 100 },
    { minutes: 10080, used: 69, limit: 100 },
  ]);
});

test("잘못된 Kimi window만 제외하고 퍼센트를 0..100으로 제한한다", () => {
  assert.deepEqual(buildKimiUsageBadges({
    usage: { used: -10, limit: 100 },
    limits: [
      { window: { duration: 5, timeUnit: "HOUR" }, detail: { used: 140, limit: 100 } },
      { window: { duration: 3, timeUnit: "HOUR" }, detail: { used: 10, limit: 100 } },
      { window: { duration: 7, timeUnit: "DAY" }, detail: { used: "bad", limit: 100 } },
    ],
  }), [
    { key: "5h", remainingPercent: 0, ariaLabel: "Kimi 5시간 0% 남음" },
    { key: "7d", remainingPercent: 100, ariaLabel: "Kimi 7일 100% 남음" },
  ]);
});

test("Kimi timeUnit은 정확한 enum 값만 허용한다", () => {
  assert.deepEqual(parseKimiUsageWindows({
    usage: { used: 20, limit: 100 },
    limits: [
      { duration: 5, timeUnit: "NOT_HOUR", used: 20, limit: 100 },
      { duration: 300, timeUnit: "MINUTE_SUFFIX", used: 20, limit: 100 },
      { duration: 7, timeUnit: "prefix_day", used: 20, limit: 100 },
    ],
  }), [
    { minutes: 10080, used: 20, limit: 100 },
  ]);
});

test("관리형 Kimi namespaced minute window를 5시간으로 정규화한다", () => {
  assert.deepEqual(buildKimiUsageBadges({
    usage: { used: 57, limit: 100 },
    limits: [{
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { used: 28, limit: 100 },
    }],
  }), [
    { key: "5h", remainingPercent: 72, ariaLabel: "Kimi 5시간 72% 남음" },
    { key: "7d", remainingPercent: 43, ariaLabel: "Kimi 7일 43% 남음" },
  ]);
});

test("Kimi 사용량 window를 설정 카드용 게이지로 변환한다", () => {
  assert.deepEqual(buildKimiUsageGauges([
    { minutes: 300, used: 28, limit: 100 },
    { minutes: 10080, used: 57, limit: 100 },
  ]), [
    { label: "5시간 한도", usedPercent: 28, resetText: "5시간 주기" },
    { label: "7일 한도", usedPercent: 57, resetText: "7일 주기" },
  ]);
});

test("Kimi 게이지는 잘못된 window를 제외하고 퍼센트를 0..100으로 제한한다", () => {
  assert.deepEqual(buildKimiUsageGauges([
    { minutes: 300, used: 140, limit: 100 },
    { minutes: 60, used: 10, limit: 100 },
    { minutes: 10080, used: "bad", limit: 100 },
    { minutes: 10080, used: -10, limit: 100 },
    { minutes: 10080, used: 10, limit: 0 },
    null,
  ]), [
    { label: "5시간 한도", usedPercent: 100, resetText: "5시간 주기" },
    { label: "7일 한도", usedPercent: 0, resetText: "7일 주기" },
  ]);
  assert.deepEqual(buildKimiUsageGauges(null), []);
});
