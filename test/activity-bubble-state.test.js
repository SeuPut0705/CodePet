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

test("활동 section에는 허용된 provider만 보존한다", () => {
  const providers = ["codex", "kimi", "claude", "agy", "gemini", "copilot", "cursor", "opencode", "windsurf"];
  for (const provider of providers) {
    const state = new ActivityBubbleState();
    state.upsert("thread", activity(`${provider} 작업`, "detail", "status"), { provider });
    assert.equal(state.toBubbleData().provider, provider);
  }

  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("Codex", "detail", "status"), {
    provider: "codex",
  });
  state.refresh(THREADS[0], { provider: "<script>secret</script>" });
  assert.equal(state.toBubbleData().provider, null);
});

test("Kimi section은 main session별 managed 사용량 eligibility를 보존하고 unknown은 닫는다", () => {
  const state = new ActivityBubbleState();
  state.upsert("kimi:custom", activity("custom", "detail", "status"), {
    provider: "kimi",
    managedUsageEligible: false,
  });
  state.upsert("kimi:managed", activity("managed", "detail", "status"), {
    provider: "kimi",
    managedUsageEligible: true,
  });
  state.upsert("kimi:unknown", activity("unknown", "detail", "status"), {
    provider: "kimi",
  });

  assert.deepEqual(
    state.toBubbleData().sections.map(({ managedUsageEligible }) => managedUsageEligible),
    [false, true, false]
  );
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

test("활성 section은 같은 thread의 provider와 client 종류를 재검증한다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("응답 작성 중", "detail", "status"), {
    provider: "codex",
    clientKind: "desktop",
  });

  assert.equal(
    state.matchesContext(THREADS[0], { provider: "codex", clientKind: "desktop" }),
    true
  );
  assert.equal(
    state.matchesContext(THREADS[0], { provider: "codex", clientKind: "cli" }),
    false
  );

  state.refresh(THREADS[0], { provider: "codex", clientKind: "cli" });
  assert.equal(
    state.matchesContext(THREADS[0], { provider: "codex", clientKind: "desktop" }),
    false
  );
  assert.equal(
    state.matchesContext(THREADS[0], { provider: "codex", clientKind: "cli" }),
    true
  );
});

test("서브에이전트 수는 작업별 badge에만 두고 제목 접근성 이름에 중복하지 않는다", () => {
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
  assert.equal(sections[0].titleLabel, "응답 작성 중 · CodePet · Sol · Medium");
  assert.equal(sections[1].titleLabel, "테스트 중 · ShortPut");

  state.refresh(THREADS[0], { subagentCount: 0 });
  sections = state.toBubbleData().sections;
  assert.deepEqual(sections.map((section) => section.subagentCount), [0, 0]);
  assert.equal(sections[0].titleLabel, "응답 작성 중 · CodePet · Sol · Medium");
});

test("종료된 작업의 서브에이전트 수는 같은 thread id의 다음 작업에 남지 않는다", () => {
  const state = new ActivityBubbleState();
  state.upsert("cursor:same", activity("작업 중", "첫 작업", "상태"), {
    provider: "cursor",
    subagentCount: 2,
  });
  state.remove("cursor:same");
  state.upsert("cursor:same", activity("작업 중", "다음 작업", "상태"), {
    provider: "cursor",
  });

  assert.equal(state.toBubbleData().subagentCount, 0);
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

test("child-count가 parent-working보다 먼저 오면 첫 section에 서브에이전트 수를 적용한다", () => {
  const state = new ActivityBubbleState();

  assert.equal(state.refresh(THREADS[0], { subagentCount: 3 }), false);
  state.upsert(THREADS[0], activity("응답 작성 중", "a", "status"));

  assert.equal(state.toBubbleData().subagentCount, 3);
});

test("잘못된 작업 ID에는 선행 서브에이전트 수를 보류하지 않는다", () => {
  const state = new ActivityBubbleState();

  for (const threadId of [undefined, null, "", false, 0, 42, {}, []]) {
    assert.equal(state.refresh(threadId, { subagentCount: 3 }), false);
  }

  assert.equal(state.subagentCounts.size, 0);
});

test("section 전의 0개 서브에이전트 수는 보류한 양의 수를 지운다", () => {
  const state = new ActivityBubbleState();

  assert.equal(state.refresh(THREADS[0], { subagentCount: 3 }), false);
  assert.equal(state.refresh(THREADS[0], { subagentCount: 0 }), false);
  state.upsert(THREADS[0], activity("응답 작성 중", "a", "status"));

  assert.equal(state.toBubbleData().subagentCount, 0);
});

test("활동을 제거하면 같은 ID로 재생성돼도 이전 서브에이전트 수를 지운다", () => {
  const state = new ActivityBubbleState();

  state.upsert(THREADS[0], activity("작업 중", "a", "status"), { subagentCount: 3 });
  assert.equal(state.remove(THREADS[0]), true);
  state.upsert(THREADS[0], activity("새 작업", "a", "status"));
  assert.equal(state.toBubbleData().subagentCount, 0);

  state.remove(THREADS[0]);
  state.refresh(THREADS[0], { subagentCount: 0 });
  state.upsert(THREADS[0], activity("개수 종료 후 작업", "a", "status"));
  assert.equal(state.toBubbleData().subagentCount, 0);
});

test("모두 비우면 보류한 서브에이전트 수를 다음 작업에 재사용하지 않는다", () => {
  const state = new ActivityBubbleState();

  state.refresh(THREADS[1], { subagentCount: 4 });
  state.clear();
  state.upsert(THREADS[1], activity("다음 작업", "b", "status"));
  assert.equal(state.toBubbleData().subagentCount, 0);
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

test("허용된 모델 라벨만 붙이고 내부 모델 id는 숨긴다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("첫 작업", "detail", "status"), {
    workerLabel: "gpt-5.6-terra-internal",
  });
  state.upsert(THREADS[1], activity("둘째 작업", "detail", "status"), { workerLabel: "Luna" });
  state.upsert(THREADS[3], activity("AGY 작업", "detail", "status"), {});
  state.upsert("gemini:main", activity("Gemini 작업", "detail", "status"), {
    workerLabel: "Gemini 2.5 Pro",
  });
  const bubble = state.toBubbleData();
  assert.deepEqual(bubble.sections.map((section) => section.title), [
    "첫 작업",
    "둘째 작업 · Luna",
    "AGY 작업",
    "Gemini 작업 · Gemini 2.5 Pro",
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
