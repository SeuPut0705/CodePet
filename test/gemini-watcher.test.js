const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  GeminiWatcher,
  findGeminiSessionFiles,
  parseGeminiRow,
  readGeminiSessionMetadata,
} = require("../src/gemini-watcher");

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-gemini-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Gemini CLI는 사용자·응답·도구만 노출하고 thoughts와 도구 결과는 숨긴다", () => {
  const metadata = { sessionId: "main-1", cwd: "/work/CodePet", kind: "main" };
  const user = parseGeminiRow({ id: "u1", type: "user", content: [{ text: "진행" }] }, "", metadata);
  const assistant = parseGeminiRow({
    id: "a1",
    type: "gemini",
    model: "gemini-2.5-pro",
    content: [{ text: "완료" }],
    thoughts: [{ subject: "숨김", description: "노출 금지" }],
  }, "", metadata);
  const tool = parseGeminiRow({
    id: "a2",
    type: "gemini",
    model: "gemini-2.5-pro",
    content: "",
    toolCalls: [{
      id: "call-1",
      name: "read_file",
      args: { file_path: "/work/CodePet/src/main.js" },
      result: [{ text: "민감한 파일 내용" }],
      status: "success",
    }],
  }, "", metadata);

  assert.equal(user.type, "user");
  assert.equal(user.text, "진행");
  assert.equal(assistant.type, "assistant");
  assert.equal(assistant.text, "완료");
  assert.equal(assistant.finished, false);
  assert.equal(assistant.completionCandidate, true);
  assert.equal(assistant.workerLabel, "Gemini 2.5 Pro");
  assert.equal(tool.type, "tool");
  assert.match(tool.text, /read_file.*src\/main\.js/);
  assert.doesNotMatch(tool.text, /민감한 파일 내용|노출 금지/);
});

test("Gemini가 응답과 도구 호출을 함께 기록하면 응답과 도구 활동을 모두 만든다", () => {
  const event = parseGeminiRow({
    id: "a-tool",
    type: "gemini",
    model: "gemini-3-pro-preview",
    content: [{ text: "파일을 먼저 확인할게요." }],
    toolCalls: [{ id: "call", name: "read_file", args: { file_path: "/work/app.js" } }],
  }, "", { sessionId: "main", cwd: "/work", kind: "main" });

  assert.equal(event.type, "assistant");
  assert.equal(event.text, "파일을 먼저 확인할게요.");
  assert.equal(event.workerLabel, "Gemini 3 Pro");
  assert.equal(event.finished, false);
  assert.equal(event.completionCandidate, false);
  assert.equal(event.toolEvents[0].type, "tool");
  assert.match(event.toolEvents[0].text, /read_file.*app\.js/);
});

test("Gemini subagent 세션은 본문 없이 개수용 이벤트만 만든다", () => {
  const event = parseGeminiRow(
    { id: "s1", type: "gemini", content: [{ text: "서브에이전트 답변" }] },
    "/tmp/chats/parent/subagent.jsonl",
    {
      sessionId: "sub-1",
      parentSessionId: "parent-1",
      childSessionId: "sub-1",
      cwd: "/work/app",
      kind: "subagent",
    }
  );
  assert.equal(event.type, "subagent");
  assert.equal(event.action, "finish-candidate");
  assert.equal(Object.hasOwn(event, "text"), false);
});

test("Gemini metadata와 projects.json으로 메인 세션의 프로젝트를 복원한다", (t) => {
  const home = tempDir(t);
  const chatDir = path.join(home, ".gemini", "tmp", "codepet-1234", "chats");
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(
    path.join(home, ".gemini", "projects.json"),
    JSON.stringify({ projects: { "/work/CodePet": "codepet-1234" } })
  );
  const file = path.join(chatDir, "session-2026-07-22-main.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({
    sessionId: "main-session",
    projectHash: "hash",
    startTime: "2026-07-22T00:00:00Z",
    lastUpdated: "2026-07-22T00:00:00Z",
    kind: "main",
  })}\n`);

  assert.deepEqual(readGeminiSessionMetadata(file, path.join(home, ".gemini")), {
    sessionId: "main-session",
    cwd: "/work/CodePet",
    sectionLabel: "CodePet",
    kind: "main",
    parentSessionId: null,
    childSessionId: null,
    clientKind: "cli",
  });

  const watcher = new GeminiWatcher({ homeDir: path.join(home, ".gemini") });
  assert.deepEqual(watcher.files(), [file]);
});

test("Gemini 파일 탐색은 메인과 직접 중첩 subagent 기록만 읽는다", (t) => {
  const root = tempDir(t);
  const main = path.join(root, "project-a", "chats", "session-main.jsonl");
  const child = path.join(root, "project-a", "chats", "session-main", "session-child.jsonl");
  const unrelated = path.join(root, "project-a", "other", "session-other.jsonl");
  fs.mkdirSync(path.dirname(main), { recursive: true });
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.mkdirSync(path.dirname(unrelated), { recursive: true });
  fs.writeFileSync(main, "\n");
  fs.writeFileSync(child, "\n");
  fs.writeFileSync(unrelated, "\n");

  assert.deepEqual(findGeminiSessionFiles(root), [child, main].sort());
});

test("Gemini 실제 2행 갱신 순서는 조기 완료 없이 도구를 표시한 뒤 최종 응답에서 끝난다", async (t) => {
  const watcher = new GeminiWatcher({
    homeDir: tempDir(t),
    completionGraceMs: 15,
    roots: [],
  });
  t.after(() => watcher.stop());
  const metadata = { sessionId: "main", cwd: "/work/CodePet", kind: "main" };
  const messages = [];
  const tools = [];
  const finished = [];
  watcher.on("agent-message", (message) => messages.push(message));
  watcher.on("tool-activity", (tool) => tools.push(tool.command));
  watcher.on("task-finished", (result) => finished.push(result));

  watcher.accept(parseGeminiRow({
    id: "same-id",
    type: "gemini",
    content: [{ text: "파일을 볼게요." }],
  }, "", metadata), 1);
  watcher.accept(parseGeminiRow({
    id: "same-id",
    type: "gemini",
    content: [{ text: "파일을 볼게요." }],
    toolCalls: [{ id: "read-1", name: "read_file", args: { file_path: "/work/a.js" } }],
  }, "", metadata), 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(finished.length, 0);
  assert.deepEqual(messages, ["파일을 볼게요."]);
  assert.deepEqual(tools, ["read_file: /work/a.js"]);

  watcher.accept(parseGeminiRow({
    id: "final-id",
    type: "gemini",
    content: [{ text: "완료했습니다." }],
  }, "", metadata), 3);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(finished.length, 1);
  assert.equal(finished[0].message, "완료했습니다.");
});

test("Gemini subagent는 본문을 숨기고 부모 작업에 개수만 반영한다", async (t) => {
  const watcher = new GeminiWatcher({
    homeDir: tempDir(t),
    completionGraceMs: 15,
    roots: [],
  });
  t.after(() => watcher.stop());
  const counts = [];
  const messages = [];
  watcher.on("context-changed", (context) => counts.push(context.subagentCount));
  watcher.on("agent-message", (message) => messages.push(message));
  watcher.accept({
    sessionId: "parent",
    type: "user",
    text: "진행",
    recordId: "user",
    eventId: "user",
    finished: false,
  }, 1);
  const metadata = {
    sessionId: "child",
    parentSessionId: "parent",
    childSessionId: "child",
    cwd: "/work/CodePet",
    kind: "subagent",
  };
  watcher.accept(parseGeminiRow({ id: "child-u", type: "user", content: "비밀 요청" }, "", metadata), 2);
  watcher.accept(parseGeminiRow({ id: "child-a", type: "gemini", content: "비밀 응답" }, "", metadata), 3);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(counts, [1, 0]);
  assert.deepEqual(messages, []);
});

test("Gemini 도구 명령의 비밀값은 마스킹한다", () => {
  const event = parseGeminiRow({
    id: "secret",
    type: "gemini",
    content: "",
    toolCalls: [{ id: "shell", name: "shell", args: { command: "API_KEY=TOPSECRET npm test" } }],
  }, "", { sessionId: "main", kind: "main" });
  assert.doesNotMatch(event.text, /TOPSECRET/);
  assert.match(event.text, /\[redacted\]/);
});
