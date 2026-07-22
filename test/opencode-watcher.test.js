const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { OpenCodeWatcher, parseOpenCodeRow, rowsSql } = require("../src/opencode-watcher");

function row(part, message = {}, session = {}) {
  return {
    part_id: part.id || "part-1",
    part_updated: part.updated || 100,
    part_data: JSON.stringify(part),
    message_id: "message-1",
    message_data: JSON.stringify({ role: "assistant", ...message }),
    session_id: "session-1",
    parent_id: null,
    directory: "/work/CodePet",
    title: "Internal generated title",
    ...session,
  };
}

test("OpenCode는 사용자·응답·모델·추론 강도를 작업별 context로 만든다", () => {
  const user = parseOpenCodeRow(row(
    { id: "user-part", type: "text", text: "진행" },
    { role: "user", agent: "build" }
  ));
  const assistant = parseOpenCodeRow(row(
    { id: "answer-part", type: "text", text: "완료" },
    {
      role: "assistant",
      agent: "build",
      providerID: "opencode-go",
      modelID: "kimi-k3",
      variant: "max",
      finish: "stop",
    }
  ));

  assert.equal(user.type, "user");
  assert.equal(user.text, "진행");
  assert.equal(user.sectionLabel, "CodePet");
  assert.equal(assistant.type, "assistant");
  assert.equal(assistant.text, "완료");
  assert.equal(assistant.workerLabel, "Kimi K3");
  assert.equal(assistant.reasoningLabel, "Max");
  assert.equal(assistant.finished, false);
});

test("OpenCode 도구는 입력의 안전한 요약만 보이고 reasoning·출력·서브세션 본문은 숨긴다", () => {
  const tool = parseOpenCodeRow(row({
    id: "tool-part",
    type: "tool",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: "npm test", content: "숨겨야 할 입력 본문" },
      output: "비밀 출력",
      title: "Tests",
    },
  }));
  const reasoning = parseOpenCodeRow(row({
    id: "reason-part",
    type: "reasoning",
    text: "숨겨진 추론",
  }));
  const child = parseOpenCodeRow(row(
    { id: "child-part", type: "text", text: "서브에이전트 응답" },
    {},
    { parent_id: "parent-session" }
  ));

  assert.equal(tool.type, "tool");
  assert.equal(tool.text, "bash: npm test");
  assert.doesNotMatch(tool.text, /비밀 출력|숨겨야 할/);
  assert.equal(reasoning, null);
  assert.equal(child.type, "subagent");
  assert.equal(child.sessionId, "parent-session");
  assert.equal(Object.hasOwn(child, "text"), false);
});

test("OpenCode watcher는 시작 전 DB 기록을 재생하지 않고 이후 행만 발행한다", async (t) => {
  const queries = [];
  let rows = [];
  const watcher = new OpenCodeWatcher({
    command: "/usr/local/bin/opencode",
    pollMs: 60_000,
    query: async (sql) => {
      queries.push(sql);
      if (/ORDER BY time_updated DESC/.test(sql)) return [{ cursor_time: 100, cursor_id: "old" }];
      return rows;
    },
  });
  t.after(() => watcher.stop());
  const messages = [];
  watcher.on("agent-message", (message) => messages.push(message));

  await watcher.start();
  rows = [row(
    { id: "fresh", updated: 101, type: "text", text: "새 응답" },
    { finish: "stop", modelID: "kimi-k3", variant: "max" }
  )];
  await watcher.poll();
  await watcher.poll();

  assert.deepEqual(messages, ["새 응답"]);
  assert.match(queries.at(-1), /json_extract\(p\.part_data/);
  assert.doesNotMatch(queries.at(-1), /m\.data AS message_data/);
});

test("OpenCode 앱 기록은 CLI 프로세스 없이 SQLite에서 직접 감지한다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencode-"));
  const dbFile = path.join(root, "opencode.db");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(dbFile);
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_updated INTEGER, data TEXT);
  `);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("session-1", null, "/work/CodePet", "title");
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
    "message-1", "session-1", 100, JSON.stringify({ role: "assistant", modelID: "kimi-k3", finish: "stop" })
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(
    "old", "message-1", "session-1", 100, JSON.stringify({ type: "text", text: "과거" })
  );

  const watcher = new OpenCodeWatcher({ command: null, dbFile, pollMs: 60_000 });
  t.after(() => watcher.stop());
  const messages = [];
  watcher.on("agent-message", (message) => messages.push(message));
  await watcher.start();
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(
    "new", "message-1", "session-1", 101, JSON.stringify({ type: "text", text: "신규" })
  );
  await watcher.poll();

  assert.deepEqual(messages, ["신규"]);
});

test("OpenCode 초기 DB 잠금 뒤에도 과거 기록을 재생하지 않고 다시 seed한다", async (t) => {
  let seedAttempts = 0;
  const old = row({ id: "old", updated: 100, type: "text", text: "과거" }, { finish: "stop" });
  const watcher = new OpenCodeWatcher({
    command: "/usr/local/bin/opencode",
    pollMs: 60_000,
    query: async (sql) => {
      if (/ORDER BY time_updated DESC/.test(sql)) {
        seedAttempts += 1;
        if (seedAttempts === 1) throw new Error("locked");
        return [{ cursor_time: 100, cursor_id: "old" }];
      }
      return [old];
    },
  });
  t.after(() => watcher.stop());
  const messages = [];
  watcher.on("agent-message", (message) => messages.push(message));

  await watcher.start();
  await watcher.poll();
  await watcher.poll();

  assert.equal(seedAttempts, 2);
  assert.deepEqual(messages, []);
});

test("OpenCode final text 뒤 step-finish가 와도 완료 작업을 다시 만들지 않는다", () => {
  const watcher = new OpenCodeWatcher({ command: "/usr/local/bin/opencode" });
  const finished = [];
  const working = [];
  watcher.on("task-finished", (result) => finished.push(result));
  watcher.on("working-changed", (value) => working.push(value));

  watcher.accept(parseOpenCodeRow(row(
    { id: "answer", updated: 200, type: "text", text: "실제 완료 응답" },
    { role: "assistant", finish: "stop" }
  )), 1);
  watcher.accept(parseOpenCodeRow(row(
    { id: "step", updated: 201, type: "step-finish", reason: "stop" },
    { role: "assistant", finish: "stop" }
  )), 2);

  assert.equal(finished.length, 1);
  assert.equal(finished[0].message, "실제 완료 응답");
  assert.deepEqual(working, [true, false]);
});

test("OpenCode 공유 DB 활동은 앱과 CLI 중 하나로 오분류하지 않는다", () => {
  const event = parseOpenCodeRow(row(
    { id: "answer", type: "text", text: "완료" },
    { role: "assistant", finish: "stop" }
  ));

  assert.equal(event.clientKind, "app-cli");
});

test("OpenCode 복합 cursor는 같은 millisecond의 300개 초과 행도 다음 page로 진행한다", () => {
  const sql = rowsSql(100, "part-0300");
  assert.match(sql, /p\.time_updated > 100/);
  assert.match(sql, /p\.time_updated = 100 AND p\.id > 'part-0300'/);
  assert.match(sql, /LIMIT 300/);
  assert.doesNotMatch(sql, /time_updated >=/);
});

test("OpenCode subagent는 부모 작업에 개수만 반영하고 종료 뒤 정리한다", () => {
  const watcher = new OpenCodeWatcher({ query: async () => [], pollMs: 60_000 });
  const counts = [];
  const messages = [];
  watcher.on("context-changed", (context) => counts.push(context.subagentCount));
  watcher.on("agent-message", (message) => messages.push(message));
  watcher.accept(parseOpenCodeRow(row(
    { id: "parent", type: "step-start" },
    {},
    { session_id: "parent-session" }
  )), 1);
  watcher.accept(parseOpenCodeRow(row(
    { id: "child-start", type: "step-start" },
    {},
    { session_id: "child-session", parent_id: "parent-session" }
  )), 2);
  watcher.accept(parseOpenCodeRow(row(
    { id: "child-secret", type: "text", text: "서브 응답" },
    {},
    { session_id: "child-session", parent_id: "parent-session" }
  )), 3);
  watcher.accept(parseOpenCodeRow(row(
    { id: "child-stop", type: "step-finish", reason: "stop" },
    {},
    { session_id: "child-session", parent_id: "parent-session" }
  )), 4);

  assert.deepEqual(counts, [1, 0]);
  assert.deepEqual(messages, []);
});

test("OpenCode 도구 명령의 비밀값은 마스킹한다", () => {
  const event = parseOpenCodeRow(row({
    id: "secret",
    type: "tool",
    tool: "bash",
    state: { input: { command: "opencode --token TOPSECRET" } },
  }));
  assert.doesNotMatch(event.text, /TOPSECRET/);
  assert.match(event.text, /\[redacted\]/);
});

test("OpenCode를 나중에 설치해 DB가 생겨도 watcher가 재시작 없이 붙는다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencode-late-"));
  const dbFile = path.join(root, "opencode.db");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let seedCalls = 0;
  const dbQuery = {
    query: async (sql) => {
      if (/ORDER BY time_updated DESC/.test(sql)) {
        seedCalls += 1;
        return [{ cursor_time: 0, cursor_id: "" }];
      }
      return [];
    },
    close() {},
  };
  const watcher = new OpenCodeWatcher({ dbFile, dbQuery, pollMs: 60_000 });
  t.after(() => watcher.stop());
  await watcher.start();
  assert.equal(watcher.started, true);
  assert.equal(watcher.seeded, false);

  fs.writeFileSync(dbFile, "placeholder");
  await watcher.poll();
  assert.equal(seedCalls, 1);
  assert.equal(watcher.seeded, true);
});
