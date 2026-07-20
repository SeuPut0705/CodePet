const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExternalWatcher } = require("../src/external-watcher");
const { projectLabelFromCwd } = require("../src/activity-labels");
const { parseAntigravityRow } = require("../src/antigravity-watcher");
const { ClaudeWatcher, parseClaudeRow } = require("../src/claude-watcher");

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-watcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("AGY는 thinking을 노출하지 않고 단계 DONE을 전체 완료로 오인하지 않는다", () => {
  const file = "C:\\brain\\session-1\\.system_generated\\logs\\transcript.jsonl";
  const tool = parseAntigravityRow(
    {
      step_index: 1,
      type: "RUN_COMMAND",
      status: "DONE",
      created_at: "2026-01-01T00:00:00Z",
      content: "npm test",
      thinking: "보이면 안 됨",
    },
    file
  );
  const response = parseAntigravityRow(
    {
      step_index: 2,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-01-01T00:00:01Z",
      content: "진행 중",
    },
    file
  );
  assert.equal(tool.type, "tool");
  assert.equal(tool.text, "npm test");
  assert.equal(tool.finished, false);
  assert.equal(response.type, "assistant");
  assert.equal(response.finished, false);
});

test("Claude는 tool_result와 thinking-only 행을 숨기고 보이는 end_turn에서 완료한다", () => {
  const tool = parseClaudeRow({
    type: "assistant",
    sessionId: "session-1",
    message: {
      content: [{ type: "tool_use", name: "Read", input: { file_path: "C:\\work\\app.js" } }],
      stop_reason: "tool_use",
    },
  });
  const toolResult = parseClaudeRow({
    type: "user",
    sessionId: "session-1",
    message: { content: [{ type: "tool_result", content: "result" }] },
  });
  const thinkingOnly = parseClaudeRow({
    type: "assistant",
    sessionId: "session-1",
    message: { content: [{ type: "thinking", thinking: "hidden" }], stop_reason: "end_turn" },
  });
  const complete = parseClaudeRow({
    type: "assistant",
    sessionId: "session-1",
    message: { content: [{ type: "text", text: "완료" }], stop_reason: "end_turn" },
  });

  assert.equal(tool.type, "tool");
  assert.match(tool.text, /Read: C:\\work\\app\.js/);
  assert.equal(toolResult.type, null);
  assert.equal(thinkingOnly.type, null);
  assert.equal(thinkingOnly.finished, false);
  assert.equal(complete.type, "assistant");
  assert.equal(complete.finished, true);
});

test("CLI 프로젝트 라벨은 경로 구분자와 빈 경로를 안전하게 처리한다", () => {
  assert.equal(projectLabelFromCwd("/work/shortput/", "Claude"), "shortput");
  assert.equal(projectLabelFromCwd("C:\\work\\CodePet\\", "Claude"), "CodePet");
  assert.equal(projectLabelFromCwd("C:\\", "Claude"), "Claude");
  assert.equal(projectLabelFromCwd("/work/\u0000\u001f", "Claude"), "Claude");
  assert.equal(projectLabelFromCwd(" ", "Claude"), "Claude");
});

test("Claude CLI는 cwd 프로젝트명을 activity context로 전달한다", () => {
  const event = parseClaudeRow(
    { type: "user", sessionId: "a", cwd: "/work/mowda-one", message: { content: "진행" } },
    "/tmp/a.jsonl"
  );
  assert.equal(event.sectionLabel, "mowda-one");
  assert.equal(event.clientKind, "cli");
});

test("Claude CLI는 후속 행에 cwd가 없어도 세션 프로젝트명을 유지한다", () => {
  const watcher = new ClaudeWatcher({ roots: [], findFiles: () => [], quietMs: 60_000 });
  const messages = [];
  watcher.on("agent-message", (message, context) => messages.push({ message, context }));

  watcher.accept(parseClaudeRow({
    type: "user",
    sessionId: "stable-project",
    cwd: "/work/mowda-one",
    message: { content: "진행" },
  }), 1);
  watcher.accept(parseClaudeRow({
    type: "assistant",
    sessionId: "stable-project",
    message: { content: [{ type: "text", text: "확인 중" }] },
  }), 2);

  assert.equal(messages.at(-1).context.cwd, "/work/mowda-one");
  assert.equal(messages.at(-1).context.sectionLabel, "mowda-one");
});

test("Claude와 AGY 응답은 펫 말풍선에 전달할 문단과 목록을 보존한다", () => {
  const claude = parseClaudeRow({
    type: "assistant",
    sessionId: "session-1",
    message: {
      content: [{ type: "text", text: "첫 문단\n\n- Claude 목록" }],
      stop_reason: "end_turn",
    },
  });
  const agy = parseAntigravityRow(
    {
      step_index: 3,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-01-01T00:00:02Z",
      content: "첫 문단\n\n- AGY 목록",
    },
    "/brain/session-1/.system_generated/logs/transcript.jsonl"
  );

  assert.equal(claude.text, "첫 문단\n\n- Claude 목록");
  assert.equal(agy.text, "첫 문단\n\n- AGY 목록");
});

test("Claude text와 tool_use가 섞인 행은 보이는 메시지를 우선한다", () => {
  const mixed = parseClaudeRow({
    type: "assistant",
    sessionId: "session-1",
    message: {
      content: [
        { type: "text", text: "먼저 확인할게요." },
        { type: "tool_use", name: "Read", input: { file_path: "/tmp/app.js" } },
      ],
      stop_reason: "tool_use",
    },
  });

  assert.equal(mixed.type, "assistant");
  assert.equal(mixed.text, "먼저 확인할게요.");
  assert.equal(mixed.finished, false);
});

test("EOF watcher는 시작 전 기록은 건너뛰고 새 파일의 첫 한글 이벤트부터 읽는다", (t) => {
  const root = tempDir(t);
  const existing = path.join(root, "existing.jsonl");
  fs.writeFileSync(existing, `${JSON.stringify({ id: "old", sessionId: "s", type: "user", text: "과거" })}\n`);
  const watcher = new ExternalWatcher({
    provider: "test",
    roots: [root],
    findFiles: (directory) =>
      fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(directory, name)),
    parseRow: (row) => row,
    quietMs: 60_000,
  });
  const messages = [];
  watcher.on("user-message", (message) => messages.push(message));
  watcher.seed();

  fs.appendFileSync(
    existing,
    `${JSON.stringify({ id: "new-1", sessionId: "s", type: "user", text: "한글 요청" })}\n`
  );
  const created = path.join(root, "created.jsonl");
  fs.writeFileSync(
    created,
    `${JSON.stringify({ id: "new-2", sessionId: "n", type: "user", text: "첫 이벤트" })}\n`
  );
  watcher.poll();

  assert.deepEqual(messages.sort((left, right) => left.localeCompare(right, "ko")), ["첫 이벤트", "한글 요청"]);
  assert.equal(watcher.offsets.get(existing), fs.statSync(existing).size);
  assert.equal(watcher.offsets.get(created), fs.statSync(created).size);
});

test("같은 provider 이벤트 id가 반복 기록돼도 한 번만 발행한다", (t) => {
  const root = tempDir(t);
  const file = path.join(root, "events.jsonl");
  fs.writeFileSync(file, "");
  const watcher = new ExternalWatcher({
    provider: "test",
    roots: [root],
    findFiles: () => [file],
    parseRow: (row) => row,
    quietMs: 60_000,
  });
  let count = 0;
  watcher.on("agent-message", () => {
    count += 1;
  });
  watcher.seed();
  const row = JSON.stringify({ id: "same", eventId: "same", sessionId: "s", type: "assistant", text: "응답" });
  fs.appendFileSync(file, `${row}\n${row}\n`);
  watcher.poll();
  assert.equal(count, 1);
});

test("외부 watcher는 작업별 표시 context를 누적하고 0개 서브에이전트도 갱신한다", () => {
  const watcher = new ExternalWatcher({
    provider: "test",
    roots: [],
    findFiles: () => [],
    parseRow: (row) => row,
    quietMs: 60_000,
  });
  const changed = [];
  const messages = [];
  watcher.on("context-changed", (context) => changed.push(context));
  watcher.on("agent-message", (_message, context) => messages.push(context));

  watcher.accept({
    sessionId: "one",
    eventId: "one",
    type: "user",
    text: "시작",
    cwd: "/work/app",
    sectionLabel: "App",
    subagentCount: 2,
  }, 1);
  watcher.accept({
    sessionId: "one",
    eventId: "two",
    type: "context",
    workerLabel: "K3",
    reasoningLabel: "Max",
    subagentCount: 0,
  }, 2);
  watcher.accept({
    sessionId: "one",
    eventId: "three",
    type: "assistant",
    text: "완료",
  }, 3);

  assert.deepEqual(changed.at(-1), {
    threadId: "test:one",
    cwd: "/work/app",
    provider: "test",
    sectionLabel: "App",
    workerLabel: "K3",
    reasoningLabel: "Max",
    subagentCount: 0,
  });
  assert.deepEqual(messages.at(-1), changed.at(-1));
});
