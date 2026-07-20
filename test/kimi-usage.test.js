const test = require("node:test");
const assert = require("node:assert/strict");
const { buildKimiUsageBadges, parseKimiUsageWindows } = require("../src/kimi-usage");

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
