const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  HookProviderWatcher,
  parseProviderHookEvent,
  readCopilotVisibleResponse,
} = require("../src/provider-hook-watcher");

test("Copilot hook은 사용자 요청과 도구의 안전한 입력만 표시한다", () => {
  const user = parseProviderHookEvent("copilot", "userPromptSubmitted", {
    sessionId: "copilot-1",
    cwd: "/work/CodePet",
    prompt: "테스트해줘",
    timestamp: 1,
  });
  const tool = parseProviderHookEvent("copilot", "preToolUse", {
    sessionId: "copilot-1",
    cwd: "/work/CodePet",
    toolName: "bash",
    toolArgs: { command: "npm test", content: "숨김" },
    toolResult: "비밀 출력",
    timestamp: 2,
  });

  assert.equal(user.type, "user");
  assert.equal(user.text, "테스트해줘");
  assert.equal(user.sectionLabel, "CodePet");
  assert.equal(tool.type, "tool");
  assert.equal(tool.text, "bash: npm test");
  assert.doesNotMatch(tool.text, /비밀 출력|숨김/);
});

test("Cursor hook은 응답과 모델을 표시하고 stop에서 작업을 끝낸다", () => {
  const response = parseProviderHookEvent("cursor", "afterAgentResponse", {
    conversation_id: "cursor-1",
    workspace_roots: ["/work/ShortPut"],
    text: "확인했습니다.",
    model: "Claude 4 Sonnet",
    generation_id: "generation-1",
  });
  const stop = parseProviderHookEvent("cursor", "stop", {
    conversation_id: "cursor-1",
    workspace_roots: ["/work/ShortPut"],
    generation_id: "generation-1",
  });

  assert.equal(response.type, "assistant");
  assert.equal(response.text, "확인했습니다.");
  assert.equal(response.workerLabel, "Claude 4 Sonnet");
  assert.equal(response.finished, false);
  assert.equal(stop.type, "lifecycle");
  assert.equal(stop.finished, true);
});

test("Windsurf는 마지막 Planner Response만 표시하고 도구 출력은 섞지 않는다", () => {
  const response = parseProviderHookEvent("windsurf", "post_cascade_response", {
    trajectory_id: "wind-1",
    execution_id: "turn-1",
    tool_info: {
      response: [
        "### Planner Response",
        "파일을 확인할게요.",
        "*Read file `/secret`*",
        "### Planner Response",
        "수정이 끝났습니다.",
      ].join("\n\n"),
    },
  });

  assert.equal(response.type, "assistant");
  assert.equal(response.text, "수정이 끝났습니다.");
  assert.equal(response.finished, true);
  assert.doesNotMatch(response.text, /secret|Read file/);
});

test("Windsurf 복합 응답에 Planner Response가 없으면 본문을 노출하지 않는다", () => {
  const response = parseProviderHookEvent("windsurf", "post_cascade_response", {
    trajectory_id: "wind-private",
    execution_id: "turn-private",
    tool_info: {
      response: "Read /secret/token.txt\nraw tool output\ninternal chain",
    },
  });

  assert.equal(response.type, "lifecycle");
  assert.equal(response.finished, true);
  assert.equal(response.text, "");
});

test("서브에이전트 본문은 숨기고 개수만 main 작업 context에 반영한다", () => {
  const watcher = new HookProviderWatcher({ provider: "cursor", quietMs: 60_000 });
  const messages = [];
  const contexts = [];
  watcher.on("agent-message", (message) => messages.push(message));
  watcher.on("context-changed", (context) => contexts.push(context));

  watcher.ingest("beforeSubmitPrompt", {
    conversation_id: "parent-1",
    prompt: "진행",
  }, 1);
  watcher.ingest("subagentStart", {
    conversation_id: "child-1",
    parent_conversation_id: "parent-1",
    prompt: "서브에이전트 프롬프트",
  }, 2);
  watcher.ingest("afterAgentResponse", {
    conversation_id: "child-1",
    parent_conversation_id: "parent-1",
    is_subagent: true,
    text: "서브에이전트 응답",
  }, 3);
  watcher.ingest("subagentStop", {
    conversation_id: "child-1",
    parent_conversation_id: "parent-1",
  }, 4);

  assert.deepEqual(messages, []);
  assert.deepEqual(contexts.map((context) => context.subagentCount), [1, 0]);
});

test("이미 끝난 세션의 중복 종료 hook은 유령 작업을 만들지 않는다", () => {
  const watcher = new HookProviderWatcher({ provider: "cursor", quietMs: 60_000 });
  const working = [];
  watcher.on("working-changed", (value) => working.push(value));

  watcher.ingest("stop", { conversation_id: "already-finished" }, 1);

  assert.deepEqual(working, []);
  assert.equal(watcher.working, false);
});

test("중복 subagentStart와 늦은 subagentStop은 개수나 유령 작업을 만들지 않는다", () => {
  const watcher = new HookProviderWatcher({ provider: "copilot", quietMs: 60_000 });
  const counts = [];
  watcher.on("context-changed", (context) => counts.push(context.subagentCount));
  watcher.ingest("userPromptSubmitted", { sessionId: "main", prompt: "진행", timestamp: 1 }, 1);
  const start = { sessionId: "main", agentName: "task", timestamp: 2 };
  watcher.ingest("subagentStart", start, 2);
  watcher.ingest("subagentStart", start, 3);
  watcher.ingest("subagentStop", { sessionId: "main", agentName: "task", timestamp: 4 }, 4);
  watcher.ingest("agentStop", { sessionId: "main", timestamp: 5 }, 5);
  watcher.ingest("subagentStop", { sessionId: "main", agentName: "late", timestamp: 6 }, 6);

  assert.deepEqual(counts, [1, 0]);
  assert.equal(watcher.working, false);
  assert.equal(watcher.subagents.size, 0);
});

test("sessionStart만으로 작업을 만들지 않고 오류 종료는 실패로 보존한다", () => {
  const watcher = new HookProviderWatcher({ provider: "copilot", quietMs: 60_000 });
  const finished = [];
  watcher.on("task-finished", (result) => finished.push(result));
  watcher.ingest("sessionStart", { sessionId: "idle", cwd: "/work" }, 1);
  assert.equal(watcher.working, false);

  watcher.ingest("userPromptSubmitted", { sessionId: "failed", prompt: "진행" }, 2);
  watcher.ingest("errorOccurred", {
    sessionId: "failed",
    error: { message: "network failed" },
  }, 3);
  assert.equal(finished[0].reason, "error");
  assert.equal(finished[0].message, "network failed");
});

test("Copilot transcript는 main agent의 마지막 visible assistant 응답만 읽는다", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-copilot-transcript-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "events.jsonl");
  const rows = [
    { type: "assistant.message", agentId: "sub-1", data: { content: "서브 응답" } },
    { type: "assistant.reasoning", data: { content: "숨겨진 추론" } },
    { type: "assistant.message", data: { content: "최종 응답" } },
    { type: "assistant.usage", data: { model: "gpt-5.4" } },
  ];
  fs.writeFileSync(file, `${rows.map(JSON.stringify).join("\n")}\n`);

  assert.deepEqual(readCopilotVisibleResponse(file), { text: "최종 응답", model: "gpt-5.4" });

  const watcher = new HookProviderWatcher({ provider: "copilot", quietMs: 60_000 });
  const messages = [];
  watcher.on("agent-message", (message, context) => messages.push({ message, model: context.workerLabel }));
  watcher.ingest("userPromptSubmitted", { sessionId: "copilot-main", prompt: "진행" }, 1);
  watcher.ingest("agentStop", { sessionId: "copilot-main", transcriptPath: file }, 2);
  assert.deepEqual(messages, [{ message: "최종 응답", model: "GPT 5.4" }]);
});

test("도구 활동의 인증 값은 말풍선 전에 마스킹한다", () => {
  const event = parseProviderHookEvent("copilot", "preToolUse", {
    sessionId: "secret",
    toolName: "bash",
    toolArgs: { command: 'curl -H "Authorization: Bearer TOPSECRET" https://example.test' },
  });
  assert.doesNotMatch(event.text, /TOPSECRET/);
  assert.match(event.text, /\[redacted\]/);
});
