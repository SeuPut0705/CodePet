const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CodexWatcher,
  classifyShellCommand,
  extractThreadIdFromRolloutPath,
  normalizeReasoningLabel,
  normalizeWorkerLabel,
} = require("../src/codex-watcher");
const { createActivityHeading, formatActivityTitleLabel } = require("../src/activity-title");

const THREAD_ID = "019f4a30-b0a7-73f1-8080-2ba11b4e5d25";
const ROLLOUT_PATH = path.join(
  "C:\\Users\\tester\\.codex\\sessions\\2026\\07\\10",
  `rollout-2026-07-10T13-02-17-${THREAD_ID}.jsonl`
);

test("rollout 파일명에서 Codex thread id를 추출한다", () => {
  assert.equal(extractThreadIdFromRolloutPath(ROLLOUT_PATH), THREAD_ID);
  assert.equal(extractThreadIdFromRolloutPath("rollout-without-thread.jsonl"), null);
  assert.equal(extractThreadIdFromRolloutPath(""), null);
});

test("최근 rollout 목록에서 서브에이전트 thread를 제외한다", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-subagent-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const dayDir = path.join(codexHome, "sessions", "2026", "07", "18");
  fs.mkdirSync(dayDir, { recursive: true });

  const userThreadId = "019f4a31-1111-7222-8333-444444444444";
  const userPath = path.join(dayDir, `rollout-user-${userThreadId}.jsonl`);
  fs.writeFileSync(userPath, `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: userThreadId,
      thread_source: "user",
      base_instructions: { text: '문서 예시: "thread_source":"subagent"' },
      extra: { example: { thread_source: "subagent" } },
    },
  })}\n`, "utf8");
  fs.utimesSync(userPath, new Date(1_000), new Date(1_000));
  for (let index = 0; index < 12; index += 1) {
    const suffix = String(index).padStart(12, "0");
    const subagentThreadId = `019f4a32-1111-7222-8333-${suffix}`;
    const subagentPath = path.join(dayDir, `rollout-subagent-${subagentThreadId}.jsonl`);
    fs.writeFileSync(subagentPath, `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: subagentThreadId,
        parent_thread_id: userThreadId,
        thread_source: "subagent",
        source: { subagent: { thread_spawn: { parent_thread_id: userThreadId } } },
      },
    })}\n`, "utf8");
    fs.utimesSync(subagentPath, new Date(2_000 + index), new Date(2_000 + index));
  }

  const watcher = new CodexWatcher({ getCodexHomes: () => [codexHome] });
  assert.deepEqual(
    watcher.listRecentRolloutFiles(10).map((file) => file.filePath),
    [userPath]
  );
});

test("session_meta가 덜 기록된 rollout은 다음 poll까지 보류한다", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-partial-meta-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const dayDir = path.join(codexHome, "sessions", "2026", "07", "18");
  fs.mkdirSync(dayDir, { recursive: true });
  const threadId = "019f4a33-1111-7222-8333-444444444444";
  const filePath = path.join(dayDir, `rollout-partial-${threadId}.jsonl`);
  fs.writeFileSync(filePath, '{"type":"session_meta","payload":', "utf8");

  const watcher = new CodexWatcher({ getCodexHomes: () => [codexHome] });
  assert.deepEqual(watcher.listRecentRolloutFiles(10), []);

  fs.writeFileSync(filePath, `${JSON.stringify({
    type: "session_meta",
    payload: { id: threadId, thread_source: "user" },
  })}\n`, "utf8");
  assert.deepEqual(
    watcher.listRecentRolloutFiles(10).map((file) => file.filePath),
    [filePath]
  );
});

test("shell 명령을 테스트, 빌드, 일반 명령으로 분류한다", () => {
  assert.equal(classifyShellCommand("npm test").kind, "test");
  assert.equal(classifyShellCommand("node --test test/codex-watcher.test.js").kind, "test");
  assert.equal(classifyShellCommand("npm run dist").kind, "build");
  assert.equal(classifyShellCommand("git status --short").kind, "read");
  assert.equal(classifyShellCommand("Get-Content src/main.js").kind, "read");
  assert.equal(classifyShellCommand("node scripts/update.js").kind, "command");
});

test("세션별 완료 이벤트에 정확한 thread id를 포함한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const finished = [];
  watcher.on("task-finished", (result) => finished.push(result));

  watcher.handleLine(
    ROLLOUT_PATH,
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })
  );
  watcher.handleLine(
    ROLLOUT_PATH,
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "완료" },
    })
  );

  assert.deepEqual(finished, [
    {
      reason: "complete",
      message: "완료",
      threadId: THREAD_ID,
      otherTasksWorking: false,
      workerLabel: null,
      activeTaskCount: 0,
    },
  ]);
});

test("shell function call을 실시간 도구 상태로 변환한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const activities = [];
  watcher.on("tool-activity", (activity) => activities.push(activity));

  watcher.handleLine(
    ROLLOUT_PATH,
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        arguments: JSON.stringify({ command: "npm test" }),
      },
    })
  );

  assert.equal(activities.length, 1);
  assert.equal(activities[0].kind, "test");
  assert.equal(activities[0].threadId, THREAD_ID);
});

test("동시 작업 중 먼저 끝난 세션의 thread id를 유지한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const secondThreadId = "019f4a31-1111-7222-8333-444444444444";
  const secondPath = ROLLOUT_PATH.replace(THREAD_ID, secondThreadId);
  const finished = [];
  watcher.on("task-finished", (result) => finished.push(result));

  for (const filePath of [ROLLOUT_PATH, secondPath]) {
    watcher.handleLine(
      filePath,
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })
    );
  }

  watcher.handleLine(
    ROLLOUT_PATH,
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })
  );

  assert.equal(finished[0].threadId, THREAD_ID);
  assert.equal(finished[0].otherTasksWorking, true);
  assert.equal(watcher.working, true);
});

test("구조화된 사용자 입력 요청을 대기 상태로 변환한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const waiting = [];
  watcher.on("waiting", (state) => waiting.push(state));

  watcher.handleLine(
    ROLLOUT_PATH,
    JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call", name: "request_user_input", input: "{}" },
    })
  );

  assert.deepEqual(waiting, [{ kind: "user-input", threadId: THREAD_ID, workerLabel: null, activeTaskCount: 1 }]);
});

test("허용된 rollout 모델만 작업자 이름으로 정규화한다", () => {
  assert.equal(normalizeWorkerLabel("gpt-5.6-sol"), "Sol");
  assert.equal(normalizeWorkerLabel("gpt-5.6-terra"), "Terra");
  assert.equal(normalizeWorkerLabel("gpt-5.6-luna"), "Luna");
  assert.equal(normalizeWorkerLabel("gpt-5.6-sol-preview"), null);
  assert.equal(normalizeWorkerLabel("gpt-4.1"), null);
  assert.equal(normalizeWorkerLabel(null), null);
});

test("허용된 추론 강도만 표시용 이름으로 정규화한다", () => {
  assert.equal(normalizeReasoningLabel("low"), "Low");
  assert.equal(normalizeReasoningLabel("medium"), "Medium");
  assert.equal(normalizeReasoningLabel("high"), "High");
  assert.equal(normalizeReasoningLabel("xhigh"), "XHigh");
  assert.equal(normalizeReasoningLabel("max"), "Max");
  assert.equal(normalizeReasoningLabel("ultra"), "Ultra");
  assert.equal(normalizeReasoningLabel("unknown"), null);
  assert.equal(normalizeReasoningLabel("constructor"), null);
});

test("동시 rollout은 각자의 작업자 이름과 활성 수를 유지한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const secondPath = ROLLOUT_PATH.replace(THREAD_ID, "019f4a31-1111-7222-8333-444444444444");
  const messages = [];
  watcher.on("agent-message", (message, context) => messages.push({ message, context }));

  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({
    type: "turn_context",
    payload: { model: "gpt-5.6-terra", effort: "high" },
  }));
  watcher.handleLine(secondPath, JSON.stringify({
    type: "turn_context",
    payload: { model: "gpt-5.6-luna", effort: "medium" },
  }));
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "a" } }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "b" } }));

  assert.deepEqual(messages.map((item) => item.context), [
    { threadId: THREAD_ID, workerLabel: "Terra", reasoningLabel: "High", activeTaskCount: 2 },
    { threadId: "019f4a31-1111-7222-8333-444444444444", workerLabel: "Luna", reasoningLabel: "Medium", activeTaskCount: 2 },
  ]);
});

test("작업 시작은 파일별로 멱등이고 완료와 중단에서 활성 수를 줄인다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const secondPath = ROLLOUT_PATH.replace(THREAD_ID, "019f4a31-1111-7222-8333-444444444444");
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  assert.equal(watcher.workingFiles.size, 2);
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }));
  assert.equal(watcher.workingFiles.size, 1);
  watcher.handleLine(secondPath, JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted" } }));
  assert.equal(watcher.workingFiles.size, 0);
});

test("오래된 작업은 stale 처리에서 활성 수를 0으로 되돌린다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const changes = [];
  watcher.on("working-changed", (working, _result, context) => changes.push({ working, context }));
  watcher.setWorking(ROLLOUT_PATH);
  watcher.lastEventAtByFile.set(ROLLOUT_PATH, 0);
  watcher.listRecentRolloutFiles = () => [];
  watcher.poll();

  assert.equal(watcher.workingFiles.size, 0);
  assert.deepEqual(changes.at(-1), {
    working: false,
    context: { threadId: THREAD_ID, workerLabel: null, activeTaskCount: 0, activityChange: "removed" },
  });
});

test("동시 작업 하나만 stale이면 그 파일만 활성 수에서 제거한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const secondPath = ROLLOUT_PATH.replace(THREAD_ID, "019f4a31-1111-7222-8333-444444444444");
  const changes = [];
  watcher.activityLabels.set(ROLLOUT_PATH, { workerLabel: "Terra", reasoningLabel: "High" });
  watcher.activityLabels.set(secondPath, { workerLabel: "Luna", reasoningLabel: "Medium" });
  watcher.on("working-changed", (working, _result, context) => changes.push({ working, context }));
  watcher.setWorking(ROLLOUT_PATH);
  watcher.setWorking(secondPath);
  watcher.lastEventAtByFile.set(ROLLOUT_PATH, 0);
  watcher.listRecentRolloutFiles = () => [];
  watcher.poll();

  assert.equal(watcher.workingFiles.size, 1);
  assert.equal(watcher.workingFiles.has(secondPath), true);
  assert.equal(watcher.activityLabels.has(ROLLOUT_PATH), false);
  assert.equal(watcher.activityLabels.get(secondPath).workerLabel, "Luna");
  assert.deepEqual(changes.at(-1), {
    working: true,
    context: { threadId: THREAD_ID, workerLabel: null, activeTaskCount: 1, activityChange: "removed" },
  });
});

test("첫 poll에서 이미 실행 중인 여러 rollout의 작업자와 활성 수를 복원한다", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-watcher-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const secondThreadId = "019f4a31-1111-7222-8333-444444444444";
  const firstPath = path.join(tempDir, `rollout-test-${THREAD_ID}.jsonl`);
  const secondPath = path.join(tempDir, `rollout-test-${secondThreadId}.jsonl`);

  for (const [filePath, model, effort, timestamp] of [
    [firstPath, "gpt-5.6-terra", "high", "2026-07-10T13:02:30.000Z"],
    [secondPath, "gpt-5.6-luna", "medium", "2026-07-10T13:02:10.000Z"],
  ]) {
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ type: "turn_context", payload: { model, effort } })}\n${JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: { type: "task_started" },
      })}\n`,
      "utf8"
    );
  }

  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const restored = [];
  watcher.on("working-changed", (working, _result, context) => {
    if (working && context?.activityChange === "started") restored.push(context);
  });
  watcher.listRecentRolloutFiles = () => [firstPath, secondPath].map((filePath) => {
    const stat = fs.statSync(filePath);
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  watcher.poll();

  assert.equal(watcher.workingFiles.size, 2);
  assert.deepEqual(watcher.activityLabels.get(firstPath), {
    workerLabel: "Terra",
    reasoningLabel: "High",
  });
  assert.deepEqual(watcher.activityLabels.get(secondPath), {
    workerLabel: "Luna",
    reasoningLabel: "Medium",
  });
  // 목록 입력은 최신순(first, second)이므로 복원 이벤트는 오래된 second부터, 최신 first가 마지막입니다.
  assert.deepEqual(restored.map((context) => context.threadId), [secondThreadId, THREAD_ID]);
  assert.deepEqual(restored.map((context) => context.taskStartedAt), [
    "2026-07-10T13:02:10.000Z",
    "2026-07-10T13:02:30.000Z",
  ]);
  assert.deepEqual(restored.map((context) => context.reasoningLabel), ["Medium", "High"]);
});

test("두 번째 작업 시작은 즉시 활성 수 변경 문맥을 발행한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const secondPath = ROLLOUT_PATH.replace(THREAD_ID, "019f4a31-1111-7222-8333-444444444444");
  const changes = [];
  watcher.on("working-changed", (working, _result, context) => changes.push({ working, context }));
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  assert.deepEqual(changes, [
    { working: true, context: { threadId: THREAD_ID, workerLabel: null, activeTaskCount: 1, activityChange: "started" } },
    { working: true, context: { threadId: "019f4a31-1111-7222-8333-444444444444", workerLabel: null, activeTaskCount: 2, activityChange: "started" } },
  ]);
});

test("활동 제목은 상태를 먼저 쓰고 모델을 뒤에 표시한다", () => {
  assert.deepEqual(
    createActivityHeading("작업 중", { workerLabel: "Terra", reasoningLabel: "High" }),
    {
      statusIcon: "working",
      title: "작업 중 · Terra · High",
      titleLabel: "작업 중 · Terra · High",
    }
  );
  assert.deepEqual(createActivityHeading("작업 중"), {
    statusIcon: "working",
    title: "작업 중",
    titleLabel: "작업 중",
  });
});

test("사이드바 작업 제목이 있으면 상태 대신 섹션 제목과 모델 정보를 표시한다", () => {
  assert.deepEqual(
    createActivityHeading("응답 작성 중", {
      sectionLabel: "CodePet",
      workerLabel: "Sol",
      reasoningLabel: "Medium",
    }),
    {
      statusIcon: "writing",
      title: "CodePet · Sol · Medium",
      titleLabel: "응답 작성 중 · CodePet · Sol · Medium",
    }
  );
});

test("모든 활동 상태를 안정적인 SVG 아이콘 ID로 표시한다", () => {
  const cases = [
    ["요청 확인 중", "review"],
    ["응답 작성 중", "writing"],
    ["파일 수정 중", "edit"],
    ["자료 확인 중", "inspect"],
    ["파일 확인 중", "inspect"],
    ["이미지 생성 중", "image"],
    ["테스트 중", "test"],
    ["빌드 중", "build"],
    ["명령 실행 중", "terminal"],
    ["승인 대기", "waiting"],
    ["입력 대기", "waiting"],
    ["작업 완료", "success"],
    ["작업 실패", "error"],
  ];

  for (const [title, icon] of cases) {
    assert.deepEqual(createActivityHeading(title, { workerLabel: "Sol" }), {
      statusIcon: icon,
      title: `${title} · Sol`,
      titleLabel: `${title} · Sol`,
    });
  }
  assert.deepEqual(createActivityHeading("Claude 응답 작성 중"), {
    statusIcon: "writing",
    title: "Claude 응답 작성 중",
    titleLabel: "Claude 응답 작성 중",
  });
});

test("아이콘 제목의 접근성 이름에는 기존 상태 문구를 보존한다", () => {
  assert.equal(
    formatActivityTitleLabel("응답 작성 중", { workerLabel: "Sol", reasoningLabel: "High" }),
    "응답 작성 중 · Sol · High"
  );
  assert.equal(formatActivityTitleLabel("Claude 명령 실행 중"), "Claude 명령 실행 중");
});

test("runtime task_started의 구조화 timestamp를 작업 문맥에 전달한다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const changes = [];
  watcher.on("working-changed", (_working, _result, context) => changes.push(context));
  watcher.handleLine(
    ROLLOUT_PATH,
    JSON.stringify({
      timestamp: "2026-07-10T13:02:17.000Z",
      type: "event_msg",
      payload: { type: "task_started" },
    })
  );
  assert.equal(changes[0].taskStartedAt, "2026-07-10T13:02:17.000Z");
});

test("동시 작업 하나가 끝나면 완료 작업자 이름을 남은 작업 문맥에 재사용하지 않는다", () => {
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const secondPath = ROLLOUT_PATH.replace(THREAD_ID, "019f4a31-1111-7222-8333-444444444444");
  const changes = [];
  const finished = [];
  watcher.on("working-changed", (working, _result, context) => changes.push({ working, context }));
  watcher.on("task-finished", (result) => finished.push(result));

  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({
    type: "turn_context",
    payload: { model: "gpt-5.6-terra", effort: "high" },
  }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna" } }));
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(secondPath, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(ROLLOUT_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }));

  assert.deepEqual(changes.at(-1), {
    working: true,
    context: { threadId: THREAD_ID, workerLabel: null, activeTaskCount: 1, activityChange: "removed" },
  });
  assert.equal(finished.at(-1).workerLabel, "Terra");
  assert.equal(finished.at(-1).reasoningLabel, "High");
  assert.equal(finished.at(-1).activeTaskCount, 1);
  assert.equal(watcher.activityLabels.has(ROLLOUT_PATH), false);
  assert.equal(watcher.activityLabels.get(secondPath).workerLabel, "Luna");
});
