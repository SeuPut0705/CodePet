const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
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

test("Kimi metadata는 제목과 작업 경로를 안전하게 읽는다", (t) => {
  const fixture = sessionFixture(tempDir(t));
  assert.deepEqual(readKimiSessionMetadata(fixture.wire), {
    sessionId: "session_one",
    sectionLabel: "ToolFlowy",
    cwd: "/work/toolflowy",
  });
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
