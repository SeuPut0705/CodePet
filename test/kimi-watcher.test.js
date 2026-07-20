const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  KimiWatcher,
  findKimiWireFiles,
  parseKimiRow,
  readKimiSessionMetadata,
} = require("../src/kimi-watcher");

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-kimi-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sessionFixture(root, id = "session_one", workDir = "/work/toolflowy") {
  const session = path.join(root, "wd_toolflowy", id);
  const main = path.join(session, "agents", "main");
  fs.mkdirSync(main, { recursive: true });
  const wire = path.join(main, "wire.jsonl");
  fs.writeFileSync(wire, "");
  fs.writeFileSync(
    path.join(session, "state.json"),
    JSON.stringify({
      title: "ToolFlowy",
      workDir,
      agents: { main: { type: "main", homedir: main, parentAgentId: null } },
    })
  );
  return { session, main, wire };
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function append(file, row) {
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

test("Kimi metadata는 자동 title 대신 작업 폴더명을 section으로 사용한다", (t) => {
  const fixture = sessionFixture(tempDir(t), "session_one", "/work/shortput");
  fs.writeFileSync(
    path.join(fixture.session, "state.json"),
    JSON.stringify({ title: "자동 생성 제목", workDir: "/work/shortput" })
  );
  assert.deepEqual(readKimiSessionMetadata(fixture.wire), {
    sessionId: "session_one",
    sectionLabel: "shortput",
    cwd: "/work/shortput",
    clientKind: "cli",
  });
});

test("Kimi 프로젝트명은 완료 말풍선에서도 길이 제한을 지킨다", (t) => {
  const fixture = sessionFixture(tempDir(t));
  fs.writeFileSync(
    path.join(fixture.session, "state.json"),
    JSON.stringify({ title: "무시할 제목", workDir: `/work/${"긴".repeat(100)}` })
  );

  const metadata = readKimiSessionMetadata(fixture.wire);
  assert.equal(metadata.sectionLabel.includes("\n"), false);
  assert.equal(Array.from(metadata.sectionLabel).length, 80);
});

test("Kimi 파서는 요청·모델·보이는 응답·도구·완료만 정규화한다", () => {
  const file = "/tmp/session_one/agents/main/wire.jsonl";
  const metadata = {
    sessionId: "session_one",
    sectionLabel: "ToolFlowy",
    cwd: "/work/toolflowy",
  };

  const user = parseKimiRow(
    {
      type: "turn.prompt",
      origin: { kind: "user" },
      input: [{ type: "text", text: "고쳐줘" }],
      time: 1,
    },
    file,
    metadata
  );
  assert.deepEqual(pick(user, ["type", "text", "sectionLabel"]), {
    type: "user",
    text: "고쳐줘",
    sectionLabel: "ToolFlowy",
  });

  const model = parseKimiRow(
    { type: "llm.request", modelAlias: "kimi-code/k3", thinkingEffort: "max", time: 2 },
    file,
    metadata
  );
  assert.deepEqual(pick(model, ["type", "workerLabel", "reasoningLabel"]), {
    type: "context",
    workerLabel: "K3",
    reasoningLabel: "Max",
  });

  const response = parseKimiRow(
    {
      type: "context.append_loop_event",
      event: {
        type: "content.part",
        uuid: "text-1",
        turnId: "0",
        step: 1,
        part: { type: "text", text: "확인 중" },
      },
      time: 3,
    },
    file,
    metadata
  );
  assert.deepEqual(pick(response, ["type", "text", "turnId", "step"]), {
    type: "assistant",
    text: "확인 중",
    turnId: "0",
    step: 1,
  });

  const thinking = parseKimiRow(
    {
      type: "context.append_loop_event",
      event: {
        type: "content.part",
        uuid: "think-1",
        part: { type: "think", think: "비공개" },
      },
      time: 4,
    },
    file,
    metadata
  );
  assert.equal(thinking, null);

  const tool = parseKimiRow(
    {
      type: "context.append_loop_event",
      event: { type: "tool.call", uuid: "tool-1", name: "Edit", description: "파일 수정" },
      time: 5,
    },
    file,
    metadata
  );
  assert.deepEqual(pick(tool, ["type", "kind", "text"]), {
    type: "tool",
    kind: "patch",
    text: "파일 수정",
  });

  const toolResult = parseKimiRow(
    {
      type: "context.append_loop_event",
      event: { type: "tool.result", toolCallId: "tool-1", result: { output: "비공개" } },
      time: 6,
    },
    file,
    metadata
  );
  assert.equal(toolResult, null);

  const done = parseKimiRow(
    {
      type: "context.append_loop_event",
      event: {
        type: "step.end",
        uuid: "step-1",
        turnId: "0",
        step: 1,
        finishReason: "end_turn",
      },
      time: 7,
    },
    file,
    metadata
  );
  assert.deepEqual(pick(done, ["type", "finished"]), { type: "lifecycle", finished: true });
});

test("Kimi 파일 탐색은 최근 20개 세션의 wire만 반환한다", (t) => {
  const root = tempDir(t);
  for (let index = 0; index < 21; index += 1) {
    const fixture = sessionFixture(root, `session_${index}`);
    fs.utimesSync(fixture.wire, index + 1, index + 1);
  }

  const files = findKimiWireFiles(root, 20);
  assert.equal(new Set(files.map((file) => readKimiSessionMetadata(file).sessionId)).size, 20);
  assert.equal(files.some((file) => file.includes(`${path.sep}session_0${path.sep}`)), false);
});

test("KimiWatcher는 text를 누적하고 end_turn에서 마지막 응답으로 완료한다", (t) => {
  const root = tempDir(t);
  const fixture = sessionFixture(root);
  const watcher = new KimiWatcher({ roots: [root], quietMs: 60_000 });
  const messages = [];
  const finished = [];
  watcher.on("agent-message", (message, context) => messages.push({ message, context }));
  watcher.on("task-finished", (result) => finished.push(result));
  watcher.seed();

  append(fixture.wire, {
    type: "turn.prompt",
    origin: { kind: "user" },
    input: [{ type: "text", text: "진행" }],
    time: 1,
  });
  append(fixture.wire, {
    type: "llm.request",
    modelAlias: "kimi-code/k3",
    thinkingEffort: "max",
    time: 2,
  });
  append(fixture.wire, {
    type: "context.append_loop_event",
    event: {
      type: "content.part",
      uuid: "a",
      turnId: "0",
      step: 1,
      part: { type: "text", text: "첫 문장" },
    },
    time: 3,
  });
  append(fixture.wire, {
    type: "context.append_loop_event",
    event: {
      type: "content.part",
      uuid: "b",
      turnId: "0",
      step: 1,
      part: { type: "text", text: "둘째 문장" },
    },
    time: 4,
  });
  append(fixture.wire, {
    type: "context.append_loop_event",
    event: {
      type: "step.end",
      uuid: "c",
      turnId: "0",
      step: 1,
      finishReason: "end_turn",
    },
    time: 5,
  });
  watcher.poll();

  assert.equal(messages.at(-1).message, "첫 문장\n\n둘째 문장");
  assert.equal(messages.at(-1).context.workerLabel, "K3");
  assert.equal(messages.at(-1).context.reasoningLabel, "Max");
  assert.equal(finished.at(-1).message, "첫 문장\n\n둘째 문장");
  assert.equal(finished.at(-1).sectionLabel, "toolflowy");
});

test("KimiWatcher는 서브에이전트 메시지를 숨기고 활성 개수만 갱신한다", (t) => {
  const root = tempDir(t);
  const fixture = sessionFixture(root);
  const sub = path.join(fixture.session, "agents", "agent-0");
  fs.mkdirSync(sub, { recursive: true });
  const subWire = path.join(sub, "wire.jsonl");
  fs.writeFileSync(subWire, "");
  const watcher = new KimiWatcher({ roots: [root], quietMs: 60_000 });
  const contexts = [];
  const leaked = [];
  watcher.on("context-changed", (context) => contexts.push(context));
  watcher.on("working-changed", (working, _result, context) => {
    if (working) contexts.push(context);
  });
  watcher.on("agent-message", (message) => leaked.push(message));
  watcher.seed();

  append(fixture.wire, {
    type: "turn.prompt",
    origin: { kind: "user" },
    input: [{ type: "text", text: "메인" }],
    time: 1,
  });
  append(subWire, {
    type: "context.append_loop_event",
    event: { type: "step.begin", uuid: "sub-start", turnId: "0", step: 1 },
    time: 2,
  });
  append(subWire, {
    type: "context.append_loop_event",
    event: {
      type: "content.part",
      uuid: "sub-secret",
      turnId: "0",
      step: 1,
      part: { type: "text", text: "노출 금지" },
    },
    time: 3,
  });
  watcher.poll();
  assert.equal(contexts.at(-1).subagentCount, 1);
  assert.equal(leaked.includes("노출 금지"), false);

  append(subWire, {
    type: "context.append_loop_event",
    event: {
      type: "step.end",
      uuid: "sub-tool",
      turnId: "0",
      step: 1,
      finishReason: "tool_use",
    },
    time: 4,
  });
  watcher.poll();
  assert.equal(contexts.at(-1).subagentCount, 1);

  append(subWire, {
    type: "context.append_loop_event",
    event: {
      type: "step.end",
      uuid: "sub-done",
      turnId: "0",
      step: 2,
      finishReason: "end_turn",
    },
    time: 5,
  });
  watcher.poll();
  assert.equal(contexts.at(-1).subagentCount, 0);
});

test("KimiWatcher는 시작 전 활성 서브에이전트 수만 복원하고 메시지는 재생하지 않는다", (t) => {
  const root = tempDir(t);
  const fixture = sessionFixture(root);
  const sub = path.join(fixture.session, "agents", "agent-0");
  fs.mkdirSync(sub, { recursive: true });
  const subWire = path.join(sub, "wire.jsonl");
  fs.writeFileSync(subWire, "");
  append(subWire, {
    type: "context.append_loop_event",
    event: { type: "step.begin", uuid: "old-start", turnId: "0", step: 1 },
    time: 1,
  });
  append(subWire, {
    type: "context.append_loop_event",
    event: {
      type: "content.part",
      uuid: "old-message",
      turnId: "0",
      step: 1,
      part: { type: "text", text: "과거 메시지" },
    },
    time: 2,
  });

  const watcher = new KimiWatcher({ roots: [root], quietMs: 60_000 });
  const started = [];
  const leaked = [];
  watcher.on("working-changed", (working, _result, context) => {
    if (working) started.push(context);
  });
  watcher.on("agent-message", (message) => leaked.push(message));
  watcher.seed();
  append(fixture.wire, {
    type: "turn.prompt",
    origin: { kind: "user" },
    input: [{ type: "text", text: "새 요청" }],
    time: 3,
  });
  watcher.poll();

  assert.equal(started.at(-1).subagentCount, 1);
  assert.deepEqual(leaked, []);
});

test("KimiWatcher는 여러 메인 세션의 메시지와 제목을 분리한다", (t) => {
  const root = tempDir(t);
  const first = sessionFixture(root, "session_first", "/work/first");
  const second = sessionFixture(root, "session_second", "/work/second");
  const secondState = path.join(second.session, "state.json");
  fs.writeFileSync(secondState, JSON.stringify({ title: "Second", workDir: "/work/second" }));
  const watcher = new KimiWatcher({ roots: [root], quietMs: 60_000 });
  const messages = [];
  watcher.on("agent-message", (message, context) => messages.push({ message, context }));
  watcher.seed();

  for (const [wire, word, time] of [[first.wire, "첫째", 1], [second.wire, "둘째", 2]]) {
    append(wire, {
      type: "turn.prompt",
      origin: { kind: "user" },
      input: [{ type: "text", text: word }],
      time,
    });
    append(wire, {
      type: "context.append_loop_event",
      event: {
        type: "content.part",
        uuid: `answer-${time}`,
        turnId: "0",
        step: 1,
        part: { type: "text", text: `${word} 응답` },
      },
      time: time + 10,
    });
  }
  watcher.poll();

  assert.deepEqual(
    messages.map(({ message, context }) => [message, context.threadId, context.sectionLabel]).sort(),
    [
      ["둘째 응답", "kimi:session_second", "second"],
      ["첫째 응답", "kimi:session_first", "first"],
    ].sort()
  );
});

test("main은 Kimi watcher를 전체 공급자 수명주기에 연결한다", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /const \{ KimiWatcher \} = require\("\.\/kimi-watcher"\)/);
  assert.match(main, /const kimiWatcher = new KimiWatcher\(\)/);
  assert.match(main, /registerExternalWatcher\(kimiWatcher, "Kimi"\)/);
  assert.match(main, /kimiWatcher\.start\(\)/);
  assert.match(main, /kimiWatcher\.stop\(\)/);
  assert.match(main, /claudeWatcher\.working \|\| kimiWatcher\.working/);
  assert.match(main, /watcher\.on\("context-changed"/);
  assert.match(main, /activityHeading\(completionTitle, result\)/);
});

test("제품 설명과 README가 Kimi CLI 지원을 명시한다", () => {
  const packageJson = require("../package.json");
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(packageJson.description, /Kimi/);
  assert.match(readme, /Kimi Code CLI/);
  assert.match(readme, /kimi-watcher\.js/);
});
