const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildActivityUsageBadges,
  decorateActivityBubbleWithUsage,
} = require("../src/activity-usage");

test("rate limit 순서와 무관하게 5h·7d 남은 퍼센트를 만든다", () => {
  const usage = {
    rateLimits: {
      windows: [
        { window_minutes: 10080, used_percent: 32, resets_at: 500 },
        { window_minutes: 300, used_percent: 58.4, resets_at: 500 },
      ],
    },
  };

  assert.deepEqual(buildActivityUsageBadges(usage, 1_000), [
    { key: "5h", remainingPercent: 42, ariaLabel: "5시간 42% 남음" },
    { key: "7d", remainingPercent: 68, ariaLabel: "7일 68% 남음" },
  ]);
});

test("초기화·범위 보정·잘못된 창을 안전하게 처리한다", () => {
  const usage = {
    rateLimits: {
      primary: { window_minutes: 300, used_percent: 94, resets_at: 1 },
      secondary: { window_minutes: 10080, used_percent: -20, resets_at: 500 },
      windows: [
        { window_minutes: 300, used_percent: 94, resets_at: 1 },
        { window_minutes: 10080, used_percent: -20, resets_at: 500 },
        { window_minutes: 60, used_percent: 10 },
        { window_minutes: 300, used_percent: "unknown", scope: "추가" },
      ],
    },
  };

  assert.deepEqual(buildActivityUsageBadges(usage, 2_000), [
    { key: "5h", remainingPercent: 100, ariaLabel: "5시간 100% 남음" },
    { key: "7d", remainingPercent: 100, ariaLabel: "7일 100% 남음" },
  ]);
  assert.deepEqual(buildActivityUsageBadges(null, 2_000), []);
});

test("Codex가 작업 중인 다중 활동에만 사용량 배지를 붙인다", () => {
  const badges = [
    { key: "5h", remainingPercent: 42, ariaLabel: "5시간 42% 남음" },
  ];
  const multi = { title: "총 2개 작업 중", sections: [{}, {}] };
  const single = { title: "작업 중" };

  const decorated = decorateActivityBubbleWithUsage(multi, badges, { codexWorking: true });
  assert.notEqual(decorated, multi);
  assert.deepEqual(decorated.usageBadges, badges);
  assert.equal(decorateActivityBubbleWithUsage(multi, badges, { codexWorking: false }), multi);
  assert.equal(decorateActivityBubbleWithUsage(single, badges, { codexWorking: true }), single);
  assert.equal(decorateActivityBubbleWithUsage(multi, [], { codexWorking: true }), multi);
});
