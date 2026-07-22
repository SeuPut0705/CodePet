const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActivityUsageController,
  ActivityUsageState,
  buildActivityUsageBadges,
  decorateActivityBubbleWithProviderUsage,
} = require("../src/activity-usage");

function createFakeTimerClock(startMs) {
  let nowMs = startMs;
  let nextId = 1;
  const timers = new Map();
  const clearedIds = [];
  const scheduledDelays = [];

  return {
    now: () => nowMs,
    timers,
    clearedIds,
    scheduledDelays,
    setTimer(callback, delayMs) {
      const id = nextId++;
      scheduledDelays.push(delayMs);
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimer(id) {
      clearedIds.push(id);
      timers.delete(id);
    },
    runNext() {
      const [id, timer] = [...timers.entries()]
        .sort((left, right) => left[1].delayMs - right[1].delayMs)[0] || [];
      if (!timer) return false;
      timers.delete(id);
      nowMs += timer.delayMs;
      timer.callback();
      return true;
    },
  };
}

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
    { key: "5h", remainingPercent: 42, ariaLabel: "Codex 5시간 42% 남음" },
    { key: "7d", remainingPercent: 68, ariaLabel: "Codex 7일 68% 남음" },
  ]);
});

test("월간 창만 제공돼도 남은 사용량 배지를 만든다", () => {
  const usage = {
    rateLimits: {
      windows: [
        { window_minutes: 43800, used_percent: 24, resets_at: 500 },
      ],
    },
  };

  assert.deepEqual(buildActivityUsageBadges(usage, 1_000), [
    { key: "1mo", remainingPercent: 76, ariaLabel: "Codex 월간 76% 남음" },
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
    { key: "5h", remainingPercent: 100, ariaLabel: "Codex 5시간 100% 남음" },
    { key: "7d", remainingPercent: 100, ariaLabel: "Codex 7일 100% 남음" },
  ]);
  assert.deepEqual(buildActivityUsageBadges(null, 2_000), []);
});

test("scope 없는 비숫자 사용률 대상 창은 숨긴다", () => {
  const usage = {
    rateLimits: {
      windows: [{ window_minutes: 300, used_percent: "unknown", resets_at: 500 }],
    },
  };

  assert.deepEqual(buildActivityUsageBadges(usage, 1_000), []);
});

test("초기화 시각이 없는 대상 창은 숨긴다", () => {
  const usage = {
    rateLimits: {
      windows: [{ window_minutes: 300, used_percent: 40 }],
    },
  };

  assert.deepEqual(buildActivityUsageBadges(usage, 1_000), []);
});

test("숫자가 아닌 초기화 시각의 대상 창은 숨긴다", () => {
  const usage = {
    rateLimits: {
      windows: [{ window_minutes: 10080, used_percent: 40, resets_at: "not-a-timestamp" }],
    },
  };

  assert.deepEqual(buildActivityUsageBadges(usage, 1_000), []);
});

const INVALID_NUMERIC_VALUES = [
  ["빈 문자열", ""],
  ["공백 문자열", "   "],
  ["boolean", false],
  ["배열", []],
];

for (const [label, resetsAt] of INVALID_NUMERIC_VALUES) {
  test(`${label} 초기화 시각의 대상 창은 숨긴다`, () => {
    const usage = {
      rateLimits: {
        windows: [{ window_minutes: 300, used_percent: 40, resets_at: resetsAt }],
      },
    };

    assert.deepEqual(buildActivityUsageBadges(usage, 1_000), []);
  });
}

for (const [label, usedPercent] of INVALID_NUMERIC_VALUES) {
  test(`${label} 사용률의 대상 창은 숨긴다`, () => {
    const usage = {
      rateLimits: {
        windows: [{ window_minutes: 300, used_percent: usedPercent, resets_at: 500 }],
      },
    };

    assert.deepEqual(buildActivityUsageBadges(usage, 1_000), []);
  });
}

test("배열 기간은 숨기고 다음 유효 숫자 문자열 창을 사용한다", () => {
  const usage = {
    rateLimits: {
      windows: [
        { window_minutes: [300], used_percent: 40, resets_at: 500 },
        { window_minutes: "300", used_percent: "58.4", resets_at: "500" },
      ],
    },
  };

  assert.deepEqual(buildActivityUsageBadges(usage, 1_000), [
    { key: "5h", remainingPercent: 42, ariaLabel: "Codex 5시간 42% 남음" },
  ]);
});

test("공급자별 첫 visible section에만 사용량 배지를 붙인다", () => {
  const data = {
    title: "총 4개 작업 중",
    sections: [
      { threadId: "codex:a", provider: "codex" },
      { threadId: "kimi:custom", provider: "kimi", managedUsageEligible: false },
      { threadId: "kimi:managed", provider: "kimi", managedUsageEligible: true },
      { threadId: "codex:b", provider: "codex" },
    ],
  };
  const usageByProvider = {
    codex: [{ key: "7d", remainingPercent: 30, ariaLabel: "7일 30% 남음" }],
    kimi: [{ key: "5h", remainingPercent: 70, ariaLabel: "Kimi 5시간 70% 남음" }],
  };
  const result = decorateActivityBubbleWithProviderUsage(data, usageByProvider);

  assert.deepEqual(result.sections.map((section) => section.usageBadges || []), [
    [{ key: "7d", remainingPercent: 30, ariaLabel: "7일 30% 남음" }],
    [],
    [{ key: "5h", remainingPercent: 70, ariaLabel: "Kimi 5시간 70% 남음" }],
    [],
  ]);
  assert.notEqual(result, data);
  assert.notEqual(result.sections[0].usageBadges[0], usageByProvider.codex[0]);

  const reordered = decorateActivityBubbleWithProviderUsage({
    ...data,
    sections: [data.sections[2], data.sections[3], data.sections[0]],
  }, usageByProvider);
  assert.deepEqual(reordered.sections.map((section) => section.usageBadges || []), [
    [{ key: "5h", remainingPercent: 70, ariaLabel: "Kimi 5시간 70% 남음" }],
    [{ key: "7d", remainingPercent: 30, ariaLabel: "7일 30% 남음" }],
    [],
  ]);
});

test("단일 Kimi section은 managed eligibility가 명시된 경우에만 사용량 배지를 붙인다", () => {
  const badges = [
    { key: "5h", remainingPercent: 70, ariaLabel: "Kimi 5시간 70% 남음" },
  ];
  const single = {
    kind: "activity",
    provider: "kimi",
    managedUsageEligible: true,
    title: "CodePet · K3 · Max",
  };
  const result = decorateActivityBubbleWithProviderUsage(single, { kimi: badges });

  assert.deepEqual(result.usageBadges, badges);
  assert.notEqual(result.usageBadges, badges);
  assert.deepEqual(
    decorateActivityBubbleWithProviderUsage(
      { ...single, managedUsageEligible: false },
      { kimi: badges }
    ).usageBadges,
    []
  );
  assert.deepEqual(
    decorateActivityBubbleWithProviderUsage(
      { kind: "activity", provider: "kimi", title: "unknown" },
      { kimi: badges }
    ).usageBadges,
    []
  );
});

test("가장 최근 활성 세션 사용량을 표시하고 종료 시 이전 활성 세션 값을 복원한다", () => {
  const state = new ActivityUsageState();
  const usageA = {
    rateLimits: {
      windows: [{ window_minutes: 300, used_percent: 70, resets_at: 500 }],
    },
  };
  const usageB = {
    rateLimits: {
      windows: [{ window_minutes: 300, used_percent: 20, resets_at: 500 }],
    },
  };

  state.update("thread-a", usageA, 1_000);
  state.update("thread-b", usageB, 1_000);
  assert.equal(state.buildBadges(1_000)[0].remainingPercent, 80);

  state.remove("thread-b", 1_000);
  assert.equal(state.buildBadges(1_000)[0].remainingPercent, 30);

  state.remove("thread-a", 1_000);
  assert.deepEqual(state.buildBadges(1_000), []);
  assert.equal(state.update("", usageB, 1_000), false);
  assert.deepEqual(state.buildBadges(1_000), []);
});

test("raw usage를 보존해 reset 이후 다시 계산하고 idle에서는 과거 값을 비운다", () => {
  const state = new ActivityUsageState();
  state.update("thread-a", {
    rateLimits: {
      windows: [{ window_minutes: 300, used_percent: 60, resets_at: 2 }],
    },
  }, 1_000);

  assert.equal(state.buildBadges(1_000)[0].remainingPercent, 40);
  assert.equal(state.buildBadges(2_000)[0].remainingPercent, 100);

  state.clear();
  assert.deepEqual(state.buildBadges(3_000), []);
});

test("표시 배지가 같은 usage 갱신은 변경으로 보고하지 않는다", () => {
  const state = new ActivityUsageState();
  const usage = (usedPercent, resetsAt) => ({
    rateLimits: {
      windows: [{
        window_minutes: 300,
        used_percent: usedPercent,
        resets_at: resetsAt,
      }],
    },
  });

  assert.equal(state.update("thread-a", usage(60, 500), 1_000), true);
  assert.equal(state.update("thread-b", usage(60, 600), 1_000), false);
  assert.equal(state.update("thread-b", usage(61, 600), 1_000), true);
});

test("가장 가까운 target reset을 선택하고 reset 시점에 표시 변경을 감지한다", () => {
  const state = new ActivityUsageState();
  state.update("thread-a", {
    rateLimits: {
      windows: [
        { window_minutes: 10080, used_percent: 20, resets_at: 5 },
        { window_minutes: 300, used_percent: 60, resets_at: 2 },
        { window_minutes: 60, used_percent: 10, resets_at: 1.5 },
      ],
    },
  }, 1_000);

  assert.equal(state.nextResetAt(1_000), 2_000);
  assert.equal(state.refresh(1_000), false);
  assert.equal(state.refresh(2_000), true);
  assert.equal(state.refresh(2_000), false);
  assert.equal(state.nextResetAt(2_000), 5_000);
  assert.deepEqual(
    state.buildBadges(2_000).map((badge) => badge.remainingPercent),
    [100, 80]
  );
});

test("usage update는 기존 reset timer를 교체하고 하나만 유지한다", () => {
  const clock = createFakeTimerClock(1_000);
  const controller = new ActivityUsageController({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const usage = (resetsAt) => ({
    rateLimits: {
      windows: [{ window_minutes: 300, used_percent: 60, resets_at: resetsAt }],
    },
  });

  controller.update("thread-a", usage(10));
  const firstTimerId = [...clock.timers.keys()][0];
  assert.equal(clock.timers.size, 1);
  assert.equal(clock.timers.get(firstTimerId).delayMs, 9_000);

  controller.update("thread-a", usage(20));
  assert.equal(clock.timers.size, 1);
  assert.equal(clock.timers.has(firstTimerId), false);
  assert.deepEqual(clock.clearedIds, [firstTimerId]);
  assert.equal([...clock.timers.values()][0].delayMs, 19_000);
});

test("마지막 session remove와 clear는 예약된 reset timer를 해제한다", () => {
  const clock = createFakeTimerClock(1_000);
  const controller = new ActivityUsageController({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const usage = {
    rateLimits: {
      windows: [{ window_minutes: 300, used_percent: 60, resets_at: 10 }],
    },
  };

  controller.update("thread-a", usage);
  controller.remove("thread-a");
  assert.equal(clock.timers.size, 0);

  controller.update("thread-a", usage);
  controller.update("thread-b", usage);
  controller.clear();
  assert.equal(clock.timers.size, 0);
});

test("reset timer callback은 배지를 100%로 다시 계산하고 변경 callback을 한 번 호출한다", () => {
  const clock = createFakeTimerClock(1_000);
  const changedBadges = [];
  const controller = new ActivityUsageController({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onBadgesChanged: (badges) => changedBadges.push(badges),
  });

  controller.update("thread-a", {
    rateLimits: {
      windows: [{ window_minutes: 300, used_percent: 60, resets_at: 2 }],
    },
  });
  assert.equal(changedBadges.length, 1);
  changedBadges.length = 0;
  assert.equal(clock.runNext(), true);

  assert.equal(changedBadges.length, 1);
  assert.equal(changedBadges[0][0].remainingPercent, 100);
  assert.equal(controller.buildBadges()[0].remainingPercent, 100);
  assert.equal(clock.timers.size, 0);
});

test("동일 badge update는 callback 없이 최신 source reset을 보존하고 제거 시 이전 source를 복원한다", () => {
  const clock = createFakeTimerClock(1_000);
  const changedBadges = [];
  const controller = new ActivityUsageController({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onBadgesChanged: (badges) => changedBadges.push(badges),
  });
  const usage = (resetsAt) => ({
    rateLimits: {
      windows: [{ window_minutes: 300, used_percent: 60, resets_at: resetsAt }],
    },
  });

  controller.update("thread-a", usage(10));
  assert.equal(changedBadges.length, 1);

  controller.update("thread-b", usage(20));
  assert.equal(changedBadges.length, 1);
  assert.equal([...clock.timers.values()][0].delayMs, 19_000);

  controller.remove("thread-b");
  assert.equal(changedBadges.length, 1);
  assert.equal([...clock.timers.values()][0].delayMs, 9_000);
  assert.equal(controller.buildBadges()[0].remainingPercent, 40);
});

test("dispose는 reset timer와 session 상태를 해제하고 이후 update를 막는다", () => {
  const clock = createFakeTimerClock(1_000);
  const controller = new ActivityUsageController({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const usage = {
    rateLimits: {
      windows: [{ window_minutes: 300, used_percent: 60, resets_at: 10 }],
    },
  };

  controller.update("thread-a", usage);
  assert.equal(clock.timers.size, 1);

  controller.dispose();
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(controller.buildBadges(), []);
  assert.equal(controller.update("thread-b", usage), false);
  assert.equal(clock.timers.size, 0);
});

test("far-future reset은 안전한 최대 delay로 나누고 chunk callback마다 한 번만 재예약한다", () => {
  const maxTimerDelayMs = 2_147_483_647;
  const clock = createFakeTimerClock(1_000);
  const changedBadges = [];
  const controller = new ActivityUsageController({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onBadgesChanged: (badges) => changedBadges.push(badges),
  });
  const farFutureResetAtMs = clock.now() + maxTimerDelayMs * 2 + 5_000;

  controller.update("thread-a", {
    rateLimits: {
      windows: [{
        window_minutes: 300,
        used_percent: 60,
        resets_at: farFutureResetAtMs / 1000,
      }],
    },
  });

  assert.equal(clock.timers.size, 1);
  assert.ok(clock.scheduledDelays[0] <= maxTimerDelayMs);
  changedBadges.length = 0;

  assert.equal(clock.runNext(), true);
  assert.equal(clock.timers.size, 1);
  assert.equal(clock.scheduledDelays.length, 2);
  assert.ok(clock.scheduledDelays[1] <= maxTimerDelayMs);
  assert.equal(changedBadges.length, 0);
});
