const test = require("node:test");
const assert = require("node:assert/strict");
const { KimiUsageController } = require("../src/kimi-usage-controller");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function fakeTimerClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();

  return {
    setTimer(callback, delayMs) {
      const id = ++nextId;
      timers.set(id, { callback, dueAt: now + delayMs, delayMs });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    get size() {
      return timers.size;
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort(([, left], [, right]) => left.dueAt - right.dueAt)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.dueAt;
        timer.callback();
        await Promise.resolve();
      }
      now = target;
      await Promise.resolve();
    },
  };
}

test("Kimi 첫 작업에서 즉시 조회하고 60초마다 하나의 요청만 유지한다", async () => {
  const pending = deferred();
  let calls = 0;
  const clock = fakeTimerClock();
  const controller = new KimiUsageController({
    client: { fetchBadges: () => { calls += 1; return pending.promise; } },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  controller.setWorking(true);
  controller.setWorking(true);
  assert.equal(calls, 1);
  await clock.advance(60_000);
  assert.equal(calls, 1);

  pending.resolve([{ key: "5h", remainingPercent: 70, ariaLabel: "Kimi 5시간 70% 남음" }]);
  await controller.whenIdle();
  await clock.advance(60_000);
  assert.equal(calls, 2);
});

test("Kimi 마지막 작업 종료는 timer와 배지를 제거한다", async () => {
  const changes = [];
  const clock = fakeTimerClock();
  const controller = new KimiUsageController({
    client: {
      fetchBadges: async () => [
        { key: "7d", remainingPercent: 40, ariaLabel: "Kimi 7일 40% 남음" },
      ],
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onBadgesChanged: (badges) => changes.push(badges),
  });

  controller.setWorking(true);
  await controller.whenIdle();
  controller.setWorking(false);

  assert.deepEqual(controller.buildBadges(), []);
  assert.deepEqual(changes.at(-1), []);
  assert.equal(clock.size, 0);
});

test("Kimi 일시 오류는 기존 배지를 유지하고 다음 주기에 재시도한다", async () => {
  let fail = false;
  const clock = fakeTimerClock();
  let calls = 0;
  const controller = new KimiUsageController({
    client: {
      fetchBadges: async () => {
        calls += 1;
        if (fail) throw new Error("temporary");
        return [{ key: "5h", remainingPercent: 55, ariaLabel: "Kimi 5시간 55% 남음" }];
      },
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  controller.setWorking(true);
  await controller.whenIdle();
  fail = true;
  await controller.refresh();

  assert.equal(controller.buildBadges()[0].remainingPercent, 55);
  await clock.advance(60_000);
  assert.equal(calls, 3);
});

test("동일한 정규화 badge 값은 callback을 다시 호출하지 않는다", async () => {
  const changes = [];
  let remainingPercent = 70;
  const clock = fakeTimerClock();
  const controller = new KimiUsageController({
    client: {
      fetchBadges: async () => [
        { key: "5h", remainingPercent, ariaLabel: `Kimi 5시간 ${remainingPercent}% 남음` },
      ],
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onBadgesChanged: (badges) => changes.push(badges),
  });

  controller.setWorking(true);
  await controller.whenIdle();
  await controller.refresh();
  assert.equal(changes.length, 1);

  remainingPercent = 65;
  await controller.refresh();
  assert.equal(changes.length, 2);
});

test("종료 또는 dispose 뒤 늦게 완료된 조회는 배지를 복원하지 않는다", async () => {
  const pending = deferred();
  const changes = [];
  const controller = new KimiUsageController({
    client: { fetchBadges: () => pending.promise },
    onBadgesChanged: (badges) => changes.push(badges),
  });

  controller.setWorking(true);
  controller.setWorking(false);
  pending.resolve([{ key: "5h", remainingPercent: 20, ariaLabel: "Kimi 5시간 20% 남음" }]);
  await Promise.resolve();

  assert.deepEqual(controller.buildBadges(), []);
  assert.deepEqual(changes, []);
  controller.dispose();
  assert.deepEqual(controller.buildBadges(), []);
  assert.equal(controller.setWorking(true), false);
});

test("dispose 뒤 늦게 완료된 조회는 callback이나 timer를 복원하지 않는다", async () => {
  const pending = deferred();
  const changes = [];
  const clock = fakeTimerClock();
  const controller = new KimiUsageController({
    client: { fetchBadges: () => pending.promise },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onBadgesChanged: (badges) => changes.push(badges),
  });

  controller.setWorking(true);
  const inFlight = controller.whenIdle();
  controller.dispose();
  pending.resolve([{ key: "5h", remainingPercent: 20, ariaLabel: "Kimi 5시간 20% 남음" }]);
  await inFlight;

  assert.deepEqual(controller.buildBadges(), []);
  assert.deepEqual(changes, []);
  assert.equal(clock.size, 0);
});

test("진행 중인 Kimi 조회에서 직접 refresh는 같은 request를 공유한다", async () => {
  const pending = deferred();
  let calls = 0;
  const clock = fakeTimerClock();
  const controller = new KimiUsageController({
    client: { fetchBadges: () => { calls += 1; return pending.promise; } },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  controller.setWorking(true);
  const inFlight = controller.whenIdle();
  const firstRefresh = controller.refresh();
  const secondRefresh = controller.refresh();

  assert.strictEqual(firstRefresh, inFlight);
  assert.strictEqual(secondRefresh, inFlight);
  assert.equal(calls, 1);

  pending.resolve([{ key: "7d", remainingPercent: 40, ariaLabel: "Kimi 7일 40% 남음" }]);
  await secondRefresh;
  assert.equal(controller.buildBadges()[0].remainingPercent, 40);
  assert.equal(clock.size, 1);
});
