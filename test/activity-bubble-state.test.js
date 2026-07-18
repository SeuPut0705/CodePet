const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActivityBubbleState,
  applyActivityPrivacy,
  shouldRestoreActiveActivityBubble,
} = require("../src/activity-bubble-state");

const THREADS = [
  "019f4a30-b0a7-73f1-8080-2ba11b4e5d25",
  "019f4a31-1111-7222-8333-444444444444",
  "019f4a32-2222-7333-8444-555555555555",
  "agy:session-1",
  "claude:session-1",
  "agy:session-2",
];

function activity(title, text, statusText) {
  return { kind: "activity", title, busy: true, text, statusText };
}

function startedAt(seconds) {
  return `2026-07-10T13:02:${String(seconds).padStart(2, "0")}.000Z`;
}

test("대화는 실제 시작 시각 순서를 유지하고 각 제목 아래 자기 내용을 가진다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("테스트 중", "terra detail", "terra status"), {
    workerLabel: "Terra",
    reasoningLabel: "High",
    taskStartedAt: startedAt(30),
  });
  state.upsert(THREADS[3], activity("AGY 응답 작성 중", "agy detail", "agy status"), {
    taskStartedAt: startedAt(10),
  });
  state.upsert(THREADS[4], activity("Claude 명령 실행 중", "claude detail", "claude status"), {
    taskStartedAt: startedAt(20),
  });
  state.upsert(THREADS[0], activity("빌드 중", "new terra detail", "terra status"), {
    workerLabel: "Terra",
    reasoningLabel: "High",
    taskStartedAt: startedAt(1),
  });

  const bubble = state.toBubbleData();
  assert.equal(bubble.title, "총 3개 작업 중");
  assert.deepEqual(bubble.sections.map((section) => section.title), [
    "AGY 응답 작성 중",
    "Claude 명령 실행 중",
    "빌드 중 · Terra · High",
  ]);
  assert.deepEqual(bubble.sections.map((section) => section.statusIcon), [
    "writing",
    "terminal",
    "build",
  ]);
  assert.deepEqual(bubble.sections.map((section) => section.text), [
    "agy detail",
    "claude detail",
    "new terra detail",
  ]);
  assert.deepEqual(bubble.sections.map((section) => section.titleLabel), [
    "AGY 응답 작성 중",
    "Claude 명령 실행 중",
    "빌드 중 · Terra · High",
  ]);
});

test("Codex·AGY·Claude를 합쳐 최대 다섯 대화를 표시하고 빈자리에 다음 대화를 올린다", () => {
  const state = new ActivityBubbleState();
  THREADS.forEach((threadId, index) => {
    state.upsert(threadId, activity(`대화 ${index + 1}`, `내용 ${index + 1}`, `상태 ${index + 1}`), {
      taskStartedAt: startedAt(index + 1),
    });
  });

  assert.equal(state.size, 6);
  assert.deepEqual(state.getVisibleThreadIds(), THREADS.slice(0, 5));
  assert.equal(state.toBubbleData().sections.length, 5);
  assert.equal(state.toBubbleData().title, "총 6개 작업 중");
  state.remove(THREADS[1]);
  assert.deepEqual(state.getVisibleThreadIds(), [THREADS[0], ...THREADS.slice(2, 6)]);
});

test("한 대화만 남으면 기존 단일 말풍선 형태를 유지한다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("테스트 중", "terra detail", "terra status"), {
    workerLabel: "Terra",
    reasoningLabel: "XHigh",
    taskStartedAt: startedAt(10),
  });

  const bubble = state.toBubbleData();
  assert.equal(bubble.sections, undefined);
  assert.equal(bubble.title, "테스트 중 · Terra · XHigh");
  assert.equal(bubble.statusIcon, "test");
  assert.equal(bubble.text, "terra detail");
});

test("새 턴에 추론 강도가 없으면 이전 턴의 강도를 제목에서 제거한다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("응답 작성 중", "detail", "status"), {
    workerLabel: "Sol",
    reasoningLabel: "High",
  });
  state.refresh(THREADS[0], { workerLabel: "Sol", reasoningLabel: null });

  assert.equal(state.toBubbleData().title, "응답 작성 중 · Sol");
  assert.equal(state.toBubbleData().statusIcon, "writing");
});

test("비동기로 확인한 사이드바 작업 제목을 활성 section에 갱신한다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("응답 작성 중", "detail", "status"), {
    workerLabel: "Sol",
    reasoningLabel: "Medium",
  });

  state.refresh(THREADS[0], { sectionLabel: "CodePet" });

  assert.equal(state.toBubbleData().title, "CodePet · Sol · Medium");
  assert.equal(state.toBubbleData().titleLabel, "응답 작성 중 · CodePet · Sol · Medium");
});

test("서브에이전트 수를 작업별 section에만 저장하고 접근성 이름에만 더한다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("응답 작성 중", "a", "status"), {
    sectionLabel: "CodePet",
    workerLabel: "Sol",
    reasoningLabel: "Medium",
  });
  state.upsert(THREADS[1], activity("테스트 중", "b", "status"), {
    sectionLabel: "ShortPut",
  });

  state.refresh(THREADS[0], { subagentCount: 3 });
  let sections = state.toBubbleData().sections;
  assert.deepEqual(sections.map((section) => section.subagentCount), [3, 0]);
  assert.deepEqual(sections.map((section) => section.title), [
    "CodePet · Sol · Medium",
    "ShortPut",
  ]);
  assert.match(sections[0].titleLabel, /활성 서브에이전트 3개/);
  assert.doesNotMatch(sections[1].titleLabel, /활성 서브에이전트/);

  state.refresh(THREADS[0], { subagentCount: 0 });
  sections = state.toBubbleData().sections;
  assert.deepEqual(sections.map((section) => section.subagentCount), [0, 0]);
  assert.doesNotMatch(sections[0].titleLabel, /활성 서브에이전트/);
});

test("서브에이전트 수는 upsert에서 안전한 양의 정수만 보존한다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("응답 작성 중", "a", "status"), { subagentCount: "2" });
  assert.equal(state.toBubbleData().subagentCount, 2);

  for (const subagentCount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "not-a-number"]) {
    state.refresh(THREADS[0], { subagentCount });
    assert.equal(state.toBubbleData().subagentCount, 0);
  }
});

test("사이드바 작업 제목 재조회가 실패하면 기존 상태 제목으로 돌아간다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("응답 작성 중", "detail", "status"), {
    sectionLabel: "Old title",
    workerLabel: "Sol",
  });

  state.refresh(THREADS[0], { sectionLabel: null });

  assert.equal(state.toBubbleData().title, "응답 작성 중 · Sol");
});

test("full/status/off 모드는 각 대화 section의 내용에 적용된다", () => {
  const data = {
    kind: "activity",
    title: "총 2개 작업 중",
    sections: [
      activity("AGY 응답 작성 중", "agy detail", "AGY 작업 중"),
      activity("Claude 응답 작성 중", "claude detail", "Claude 작업 중"),
    ],
  };

  const full = applyActivityPrivacy(data, "full");
  assert.deepEqual(full.sections.map((section) => section.text), ["agy detail", "claude detail"]);
  assert.equal(full.sections[0].statusText, undefined);
  const status = applyActivityPrivacy(data, "status");
  assert.deepEqual(status.sections.map((section) => section.text), ["AGY 작업 중", "Claude 작업 중"]);
  assert.equal(applyActivityPrivacy(data, "off"), null);
});

test("허용된 Sol/Terra/Luna 라벨만 붙이고 외부 provider 제목은 그대로 유지한다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("첫 작업", "detail", "status"), {
    workerLabel: "gpt-5.6-terra-internal",
  });
  state.upsert(THREADS[1], activity("둘째 작업", "detail", "status"), { workerLabel: "Luna" });
  state.upsert(THREADS[3], activity("AGY 작업", "detail", "status"), {});
  const bubble = state.toBubbleData();
  assert.deepEqual(bubble.sections.map((section) => section.title), [
    "첫 작업",
    "둘째 작업 · Luna",
    "AGY 작업",
  ]);
});

test("Codex 없이 AGY나 Claude만 작업 중이어도 활성 말풍선을 복원한다", () => {
  assert.equal(
    shouldRestoreActiveActivityBubble({ activeActivityCount: 1, anyProviderWorking: true }),
    true
  );
  assert.equal(
    shouldRestoreActiveActivityBubble({ activeActivityCount: 1, anyProviderWorking: false }),
    false
  );
  assert.equal(
    shouldRestoreActiveActivityBubble({ activeActivityCount: 0, anyProviderWorking: true }),
    false
  );
});
