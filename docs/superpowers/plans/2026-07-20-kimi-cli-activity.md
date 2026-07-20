# Kimi CLI Activity Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kimi Code CLI 작업을 CodePet에서 `작업 제목 · 모델 · 추론 강도`와 작업별 활성 서브에이전트 수로 실시간 표시한다.

**Architecture:** 공용 `ExternalWatcher`가 안전한 activity context 갱신을 지원하도록 확장하고, 새 `KimiWatcher`가 `~/.kimi-code/sessions`의 최근 메인·서브에이전트 `wire.jsonl`만 tail한다. 메인 이벤트만 말풍선으로 보내며 서브에이전트 이벤트는 작업별 활성 개수 계산에만 사용한다.

**Tech Stack:** Electron, Node.js CommonJS, `node:fs`, `node:path`, `node:events`, Node test runner (`node --test`)

## Global Constraints

- Kimi Code CLI 0.27.0의 로컬 `wire.jsonl` 형식을 필요한 필드만 선택적으로 파싱한다.
- Kimi 계정·사용량 조회와 Kimi 프로세스 제어는 추가하지 않는다.
- `think`, `tool.result`, 서브에이전트 메시지는 사용자 화면에 노출하지 않는다.
- 시작 전 메인 메시지는 재생하지 않되, 서브에이전트 활성 여부만 복원한다.
- poll 주기 1.8초, 최근 메인 세션 최대 20개, quiet 제한 5분을 사용한다.
- 알 수 없는 모델·추론 값은 원문 대신 배지를 숨긴다.
- 새 런타임 dependency는 추가하지 않는다.

---

## File Map

- Create `src/kimi-watcher.js`: Kimi 세션 탐색, 메타데이터 해석, 행 파싱, 응답 누적, 서브에이전트 수명주기.
- Create `test/kimi-watcher.test.js`: Kimi 파서·다중 세션·재시작·서브에이전트 계약.
- Modify `src/external-watcher.js`: section/model/reasoning/subagent context를 세션별로 병합하고 갱신 이벤트 발행.
- Modify `test/provider-watcher.test.js`: 공용 context 병합·초기화·완료 전달 회귀 테스트.
- Modify `src/activity-labels.js`: Kimi 모델 표시 허용 목록.
- Modify `src/main.js`: Kimi watcher 생성·등록·시작·종료와 외부 watcher 상태 제목 연결.
- Modify `README.md`: 지원 공급자와 watcher 구조 설명.
- Modify `package.json`: 제품 설명에 Kimi 추가.

### Task 1: 공용 watcher activity context 계약

**Files:**
- Modify: `src/external-watcher.js:58-235`
- Modify: `test/provider-watcher.test.js:122-174`

**Interfaces:**
- Consumes: 정규화 이벤트의 `sectionLabel`, `workerLabel`, `reasoningLabel`, `subagentCount` 선택 필드.
- Produces: `ExternalWatcher.contextFor(session)`, `context-changed` 이벤트, 모든 기존 watcher 이벤트에 포함된 최신 context.

- [ ] **Step 1: context 병합 실패 테스트 작성**

`test/provider-watcher.test.js`에 다음 테스트를 추가한다.

```js
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/provider-watcher.test.js`

Expected: FAIL. `context-changed`가 발행되지 않거나 Kimi 표시 필드가 context에 없음.

- [ ] **Step 3: context 병합 최소 구현**

`src/external-watcher.js`에 허용 필드와 helper를 추가한다.

```js
const ACTIVITY_CONTEXT_KEYS = [
  "sectionLabel",
  "workerLabel",
  "reasoningLabel",
  "subagentCount",
];

function mergeActivityContext(session, event) {
  let changed = false;
  for (const key of ACTIVITY_CONTEXT_KEYS) {
    if (!Object.hasOwn(event, key) || session[key] === event[key]) continue;
    session[key] = event[key];
    changed = true;
  }
  return changed;
}
```

`ExternalWatcher`에 다음 method를 추가하고 `accept()`와 `finish()`가 이 context를 재사용하게 한다.

```js
contextFor(session, extra = {}) {
  const context = {
    threadId: session.id,
    cwd: session.cwd,
    provider: this.provider,
    ...extra,
  };
  for (const key of ACTIVITY_CONTEXT_KEYS) {
    if (Object.hasOwn(session, key)) context[key] = session[key];
  }
  return context;
}
```

새 세션 생성 직후와 기존 세션 갱신 때 `mergeActivityContext(session, event)`를 호출한다. 기존 세션의 값이 바뀌면 `this.emit("context-changed", this.contextFor(session))`를 발행한다. `working-changed`, `user-message`, `agent-message`, `tool-activity`, 완료 removal context도 `contextFor()` 결과를 사용한다. `finish()` 결과에는 `...this.contextFor(session)`을 넣어 완료 말풍선도 마지막 section/model/reasoning 값을 유지한다.

- [ ] **Step 4: 공용 watcher 테스트 통과 확인**

Run: `node --test test/provider-watcher.test.js`

Expected: PASS. 기존 AGY·Claude·EOF·중복 테스트 포함 전부 통과.

- [ ] **Step 5: Task 1 커밋**

```bash
git add src/external-watcher.js test/provider-watcher.test.js
git commit -m "feat(activity): 외부 작업 표시 context 확장"
```

### Task 2: Kimi 행 파서와 세션 메타데이터

**Files:**
- Create: `src/kimi-watcher.js`
- Create: `test/kimi-watcher.test.js`
- Modify: `src/activity-labels.js:3-18`

**Interfaces:**
- Consumes: Kimi `turn.prompt`, `llm.request`, `context.append_loop_event`, 세션 `state.json`.
- Produces: `parseKimiRow(row, file, metadata)`, `readKimiSessionMetadata(file)`, `findKimiWireFiles(root, limit)`, `normalizeKimiTool(event)`.

- [ ] **Step 1: 파서·메타데이터 실패 테스트 작성**

`test/kimi-watcher.test.js`를 만들고 다음 계약을 추가한다.

```js
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
  fs.writeFileSync(path.join(main, "wire.jsonl"), "");
  fs.writeFileSync(path.join(session, "state.json"), JSON.stringify({
    title: "ToolFlowy",
    workDir,
    agents: { main: { type: "main", homedir: main, parentAgentId: null } },
  }));
  return { session, main, wire: path.join(main, "wire.jsonl") };
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
  const metadata = { sessionId: "session_one", sectionLabel: "ToolFlowy", cwd: "/work/toolflowy" };
  assert.equal(parseKimiRow({ type: "turn.prompt", origin: { kind: "user" }, input: [{ type: "text", text: "고쳐줘" }], time: 1 }, file, metadata).type, "user");
  const model = parseKimiRow({ type: "llm.request", modelAlias: "kimi-code/k3", thinkingEffort: "max", time: 2 }, file, metadata);
  assert.deepEqual(pick(model, ["type", "workerLabel", "reasoningLabel"]), { type: "context", workerLabel: "K3", reasoningLabel: "Max" });
  assert.equal(parseKimiRow({ type: "context.append_loop_event", event: { type: "content.part", uuid: "text-1", turnId: "0", step: 1, part: { type: "text", text: "확인 중" } }, time: 3 }, file, metadata).type, "assistant");
  assert.equal(parseKimiRow({ type: "context.append_loop_event", event: { type: "content.part", uuid: "think-1", part: { type: "think", think: "비공개" } }, time: 4 }, file, metadata), null);
  const tool = parseKimiRow({ type: "context.append_loop_event", event: { type: "tool.call", uuid: "tool-1", name: "Edit", description: "파일 수정" }, time: 5 }, file, metadata);
  assert.deepEqual(pick(tool, ["type", "kind"]), { type: "tool", kind: "patch" });
  assert.equal(parseKimiRow({ type: "context.append_loop_event", event: { type: "tool.result", toolCallId: "tool-1", result: { output: "비공개" } }, time: 6 }, file, metadata), null);
  const done = parseKimiRow({ type: "context.append_loop_event", event: { type: "step.end", uuid: "step-1", turnId: "0", step: 1, finishReason: "end_turn" }, time: 7 }, file, metadata);
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
  assert.equal(files.some((file) => file.includes("session_0")), false);
});
```

테스트 파일 상단에 다음 helper를 둔다.

```js
function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
```

- [ ] **Step 2: 새 Kimi 테스트 실패 확인**

Run: `node --test test/kimi-watcher.test.js`

Expected: FAIL with `Cannot find module '../src/kimi-watcher'`.

- [ ] **Step 3: Kimi parser와 탐색 helper 최소 구현**

`src/kimi-watcher.js`에 다음 공개 API를 구현한다.

```js
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExternalWatcher, messageText, readBytes, text } = require("./external-watcher");
const { normalizeReasoningLabel, normalizeWorkerLabel } = require("./activity-labels");

const DEFAULT_KIMI_ROOT = path.join(os.homedir(), ".kimi-code", "sessions");
const KIMI_POLL_MS = 1800;
const KIMI_QUIET_MS = 5 * 60 * 1000;
const KIMI_SESSION_LIMIT = 20;

function sessionRootFromWire(file) {
  return path.dirname(path.dirname(path.dirname(file)));
}

function agentIdFromWire(file) {
  return path.basename(path.dirname(file));
}

function readKimiSessionMetadata(file) {
  const sessionRoot = sessionRootFromWire(file);
  const sessionId = path.basename(sessionRoot);
  try {
    const state = JSON.parse(fs.readFileSync(path.join(sessionRoot, "state.json"), "utf8"));
    const cwd = typeof state.workDir === "string" ? state.workDir : null;
    const title = typeof state.title === "string" && state.title.trim()
      ? state.title.trim()
      : cwd ? path.basename(cwd) : null;
    return { sessionId, sectionLabel: title, cwd };
  } catch {
    return { sessionId, sectionLabel: null, cwd: null };
  }
}
```

`findKimiWireFiles()`은 root의 workspace/session directory를 두 단계만 순회하고, 각 세션의 메인 wire mtime으로 최근 세션을 고른 뒤 그 세션의 agent wire만 반환한다.

```js
function directoryEntries(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function findKimiWireFiles(root, limit = KIMI_SESSION_LIMIT) {
  const sessions = [];
  for (const workspace of directoryEntries(root)) {
    if (!workspace.isDirectory()) continue;
    const workspacePath = path.join(root, workspace.name);
    for (const entry of directoryEntries(workspacePath)) {
      if (!entry.isDirectory() || !entry.name.startsWith("session_")) continue;
      const sessionRoot = path.join(workspacePath, entry.name);
      const mainWire = path.join(sessionRoot, "agents", "main", "wire.jsonl");
      try {
        sessions.push({ sessionRoot, mtimeMs: fs.statSync(mainWire).mtimeMs });
      } catch {
        // 아직 main wire가 완성되지 않은 세션은 다음 poll에서 다시 찾습니다.
      }
    }
  }

  return sessions
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .flatMap(({ sessionRoot }) => {
      const agentsRoot = path.join(sessionRoot, "agents");
      return directoryEntries(agentsRoot).flatMap((agent) => {
        if (!agent.isDirectory()) return [];
        const wire = path.join(agentsRoot, agent.name, "wire.jsonl");
        try {
          return fs.statSync(wire).isFile() ? [wire] : [];
        } catch {
          return [];
        }
      });
    });
}
```

`parseKimiRow()`은 사용자 text만 모으고 `think`와 `tool.result`는 즉시 버린다.

```js
const READ_TOOLS = new Set(["Read", "ReadMediaFile"]);
const SEARCH_TOOLS = new Set(["Glob", "Grep"]);
const PATCH_TOOLS = new Set(["Edit", "Write"]);

function normalizeKimiTool(event) {
  const name = String(event?.name || "");
  const detail = text(event?.description || event?.display?.prompt || name);
  const kind = PATCH_TOOLS.has(name)
    ? "patch"
    : SEARCH_TOOLS.has(name)
      ? "search"
      : READ_TOOLS.has(name)
        ? "read"
        : "command";
  return { kind, text: detail || "명령 실행" };
}

function kimiEventId(row, event) {
  const source = event?.uuid || event?.toolCallId || [
    row.time,
    row.type,
    event?.type,
    event?.turnId,
    event?.step,
  ].join("\u0000");
  return crypto.createHash("sha1").update(String(source)).digest("hex").slice(0, 16);
}

function parseKimiRow(row, file, metadata = readKimiSessionMetadata(file)) {
  const agentId = agentIdFromWire(file);
  const common = {
    sessionId: metadata.sessionId,
    cwd: metadata.cwd,
    sectionLabel: metadata.sectionLabel,
    agentId,
    isSubagent: agentId !== "main",
  };

  if (row.type === "turn.prompt" && row.origin?.kind === "user") {
    const visible = Array.isArray(row.input)
      ? row.input.filter((part) => part?.type === "text").map((part) => part.text).join("\n\n")
      : "";
    return visible ? { ...common, type: "user", text: messageText(visible), eventId: kimiEventId(row) } : null;
  }

  if (row.type === "llm.request") {
    return {
      ...common,
      type: "context",
      eventId: kimiEventId(row),
      workerLabel: normalizeWorkerLabel(row.modelAlias || row.model),
      reasoningLabel: normalizeReasoningLabel(row.thinkingEffort),
    };
  }

  if (row.type !== "context.append_loop_event" || !row.event) return null;
  const event = row.event;
  const lifecycle = {
    ...common,
    eventId: kimiEventId(row, event),
    turnId: event.turnId,
    step: event.step,
  };
  if (event.type === "content.part") {
    if (event.part?.type !== "text" || !event.part.text) return null;
    return { ...lifecycle, type: "assistant", text: messageText(event.part.text), chunk: true };
  }
  if (event.type === "tool.call") {
    return { ...lifecycle, type: "tool", ...normalizeKimiTool(event) };
  }
  if (event.type === "step.begin") {
    return { ...lifecycle, type: "lifecycle", active: true, finished: false };
  }
  if (event.type === "step.end") {
    const done = event.finishReason === "end_turn";
    return { ...lifecycle, type: "lifecycle", active: !done, finished: !common.isSubagent && done };
  }
  return null;
}
```

`src/activity-labels.js`의 `MODEL_LABELS`에 다음 항목을 추가한다.

```js
["k3", "K3"],
["kimi-code/k3", "K3"],
["kimi-for-coding", "K2.7 Coding"],
["kimi-code/kimi-for-coding", "K2.7 Coding"],
["kimi-for-coding-highspeed", "K2.7 Coding Highspeed"],
["kimi-code/kimi-for-coding-highspeed", "K2.7 Coding Highspeed"],
```

- [ ] **Step 4: parser 테스트 통과 확인**

Run: `node --test test/kimi-watcher.test.js test/activity-bubble-state.test.js`

Expected: PASS. Kimi parser 테스트와 기존 label 안전성 테스트 전부 통과.

- [ ] **Step 5: Task 2 커밋**

```bash
git add src/kimi-watcher.js src/activity-labels.js test/kimi-watcher.test.js
git commit -m "feat(kimi): CLI 이벤트 파서 추가"
```

### Task 3: 응답 누적·다중 세션·서브에이전트 수명주기

**Files:**
- Modify: `src/kimi-watcher.js`
- Modify: `test/kimi-watcher.test.js`

**Interfaces:**
- Consumes: Task 1 `ExternalWatcher.accept()` context 계약과 Task 2 `parseKimiRow()`.
- Produces: `KimiWatcher`, `inferKimiSubagentActive(file)`, 작업별 최신 누적 응답과 `subagentCount`.

- [ ] **Step 1: lifecycle 실패 테스트 작성**

`test/kimi-watcher.test.js`에 실제 임시 JSONL을 쓰는 다음 테스트들을 추가한다.

```js
function append(file, row) {
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

test("KimiWatcher는 text를 누적하고 end_turn에서 마지막 응답으로 완료한다", (t) => {
  const fixture = sessionFixture(tempDir(t));
  const watcher = new KimiWatcher({ roots: [path.dirname(path.dirname(fixture.session))], quietMs: 60_000 });
  const messages = [];
  const finished = [];
  watcher.on("agent-message", (message, context) => messages.push({ message, context }));
  watcher.on("task-finished", (result) => finished.push(result));
  watcher.seed();

  append(fixture.wire, { type: "turn.prompt", origin: { kind: "user" }, input: [{ type: "text", text: "진행" }], time: 1 });
  append(fixture.wire, { type: "llm.request", modelAlias: "kimi-code/k3", thinkingEffort: "max", time: 2 });
  append(fixture.wire, { type: "context.append_loop_event", event: { type: "content.part", uuid: "a", turnId: "0", step: 1, part: { type: "text", text: "첫 문장" } }, time: 3 });
  append(fixture.wire, { type: "context.append_loop_event", event: { type: "content.part", uuid: "b", turnId: "0", step: 1, part: { type: "text", text: "둘째 문장" } }, time: 4 });
  append(fixture.wire, { type: "context.append_loop_event", event: { type: "step.end", uuid: "c", turnId: "0", step: 1, finishReason: "end_turn" }, time: 5 });
  watcher.poll();

  assert.equal(messages.at(-1).message, "첫 문장\n\n둘째 문장");
  assert.equal(messages.at(-1).context.workerLabel, "K3");
  assert.equal(messages.at(-1).context.reasoningLabel, "Max");
  assert.equal(finished.at(-1).message, "첫 문장\n\n둘째 문장");
});

test("KimiWatcher는 서브에이전트 메시지를 숨기고 활성 개수만 갱신한다", (t) => {
  const fixture = sessionFixture(tempDir(t));
  const sub = path.join(fixture.session, "agents", "agent-0");
  fs.mkdirSync(sub, { recursive: true });
  const subWire = path.join(sub, "wire.jsonl");
  fs.writeFileSync(subWire, "");
  const watcher = new KimiWatcher({ roots: [path.dirname(path.dirname(fixture.session))], quietMs: 60_000 });
  const contexts = [];
  const leaked = [];
  watcher.on("context-changed", (context) => contexts.push(context));
  watcher.on("agent-message", (message) => leaked.push(message));
  watcher.seed();

  append(fixture.wire, { type: "turn.prompt", origin: { kind: "user" }, input: [{ type: "text", text: "메인" }], time: 1 });
  append(subWire, { type: "context.append_loop_event", event: { type: "step.begin", uuid: "sub-start", turnId: "0", step: 1 }, time: 2 });
  append(subWire, { type: "context.append_loop_event", event: { type: "content.part", uuid: "sub-secret", turnId: "0", step: 1, part: { type: "text", text: "노출 금지" } }, time: 3 });
  watcher.poll();
  assert.equal(contexts.at(-1).subagentCount, 1);
  assert.equal(leaked.includes("노출 금지"), false);

  append(subWire, { type: "context.append_loop_event", event: { type: "step.end", uuid: "sub-tool", turnId: "0", step: 1, finishReason: "tool_use" }, time: 4 });
  watcher.poll();
  assert.equal(contexts.at(-1).subagentCount, 1);

  append(subWire, { type: "context.append_loop_event", event: { type: "step.end", uuid: "sub-done", turnId: "0", step: 2, finishReason: "end_turn" }, time: 5 });
  watcher.poll();
  assert.equal(contexts.at(-1).subagentCount, 0);
});
```

활성 복원 테스트는 기존 sub wire에 `step.begin`을 먼저 쓰고 `watcher.seed()`한 뒤 메인 prompt를 append한다. 첫 메인 context의 `subagentCount == 1`이고 과거 sub message가 발행되지 않았음을 검증한다. 별도 두 세션 fixture를 만들어 threadId와 메시지가 섞이지 않는 테스트도 추가한다.

- [ ] **Step 2: lifecycle 테스트 실패 확인**

Run: `node --test test/kimi-watcher.test.js`

Expected: FAIL. `KimiWatcher` 또는 응답·서브에이전트 상태 관리가 아직 없음.

- [ ] **Step 3: KimiWatcher 최소 구현**

`KimiWatcher extends ExternalWatcher`를 구현한다.

```js
class KimiWatcher extends ExternalWatcher {
  constructor(options = {}) {
    const roots = options.roots || [DEFAULT_KIMI_ROOT];
    super({
      provider: "kimi",
      roots,
      findFiles: (root) => findKimiWireFiles(root, options.sessionLimit || KIMI_SESSION_LIMIT),
      parseRow: parseKimiRow,
      pollMs: options.pollMs || KIMI_POLL_MS,
      quietMs: options.quietMs || KIMI_QUIET_MS,
    });
    this.responseBuffers = new Map();
    this.activeSubagents = new Map();
    this.metadataCache = new Map();
  }
}
```

`parseLine()`을 override해 `readKimiSessionMetadata(file)` 결과를 mtime 기반 cache로 주입한다. `accept()`은 다음 순서로 처리한다.

1. `isSubagent`면 `step.begin`에서 세션별 `Set`에 agentId 추가, `end_turn`에서 제거.
2. 서브에이전트 content·tool 이벤트는 `super.accept()`로 보내지 않음.
3. 활성 수가 바뀌고 메인 세션이 이미 `sessions`에 있으면 `type: "context"`, `subagentCount` 이벤트를 `super.accept()`로 전달.
4. 메인 assistant chunk는 `${sessionId}:${turnId}:${step}` key로 `messageText([old, chunk].filter(Boolean).join("\n\n"))` 누적 후 전체 text를 `super.accept()`로 전달.
5. 메인 context·user·tool 이벤트에는 최신 `subagentCount`를 포함.
6. 메인 `end_turn`에서는 마지막 response buffer를 `event.text`로 넣고 활성 집합과 response buffer를 정리한 뒤 `super.accept()`.

`inferKimiSubagentActive()`는 tail의 마지막 관련 lifecycle을 기준으로 판정한다.

```js
function inferKimiSubagentActive(file, maxBytes = 256 * 1024) {
  let source;
  try {
    const size = fs.statSync(file).size;
    const offset = Math.max(0, size - maxBytes);
    source = readBytes(file, offset, size).toString("utf8");
  } catch {
    return false;
  }
  let active = false;
  for (const line of source.split("\n")) {
    try {
      const row = JSON.parse(line);
      const event = row.type === "context.append_loop_event" ? row.event : null;
      if (event?.type === "step.begin") active = true;
      if (event?.type === "step.end") active = event.finishReason !== "end_turn";
    } catch {
      // tail 첫 조각과 불완전 마지막 행은 무시합니다.
    }
  }
  return active;
}
```

`seed()`은 먼저 각 sub wire의 마지막 256KB에서 lifecycle 행만 읽어 활성 집합을 복원한 뒤 `super.seed()`를 호출한다. `finish(id, reason, message)` override는 sessionId를 구해 response buffer와 활성 집합을 지운 뒤 `super.finish()`를 호출한다. `stop()`은 세 map을 비운 뒤 `super.stop()`을 호출한다.

- [ ] **Step 4: lifecycle과 기존 watcher 테스트 통과 확인**

Run: `node --test test/kimi-watcher.test.js test/provider-watcher.test.js`

Expected: PASS. 응답 누적, 0개 갱신, 재시작 복원, 다중 세션 분리, 비노출 계약 통과.

- [ ] **Step 5: Task 3 커밋**

```bash
git add src/kimi-watcher.js test/kimi-watcher.test.js
git commit -m "feat(kimi): 다중 작업과 서브에이전트 추적"
```

### Task 4: Electron 수명주기와 말풍선 연결

**Files:**
- Modify: `src/main.js:7-10, 664-675, 1163-1165, 2904-2959, 3377-3400, 3417-3425`
- Modify: `test/kimi-watcher.test.js`

**Interfaces:**
- Consumes: Task 3 `KimiWatcher`와 Task 1 `context-changed`.
- Produces: Kimi activity가 기존 `ActivityBubbleState`와 전체 작업 수에 포함되는 앱 연결.

- [ ] **Step 1: main 연결 실패 테스트 작성**

`test/kimi-watcher.test.js`에 정적 연결 계약을 추가한다.

```js
test("main은 Kimi watcher를 전체 공급자 수명주기에 연결한다", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /const \{ KimiWatcher \} = require\("\.\/kimi-watcher"\)/);
  assert.match(main, /const kimiWatcher = new KimiWatcher\(\)/);
  assert.match(main, /registerExternalWatcher\(kimiWatcher, "Kimi"\)/);
  assert.match(main, /kimiWatcher\.start\(\)/);
  assert.match(main, /kimiWatcher\.stop\(\)/);
  assert.match(main, /claudeWatcher\.working \|\| kimiWatcher\.working/);
  assert.match(main, /watcher\.on\("context-changed"/);
});
```

- [ ] **Step 2: 연결 테스트 실패 확인**

Run: `node --test test/kimi-watcher.test.js`

Expected: FAIL. `main.js`에 Kimi watcher 연결이 없음.

- [ ] **Step 3: main 수명주기와 context refresh 구현**

`src/main.js`에 import와 instance를 추가한다.

```js
const { KimiWatcher } = require("./kimi-watcher");
// ...
const kimiWatcher = new KimiWatcher();
```

`isAnyProviderWorking()`에 `kimiWatcher.working`을 포함한다. `registerExternalWatcher()`에 다음 listener를 추가한다.

```js
watcher.on("context-changed", (context) => {
  if (activeActivityBubbles.refresh(context.threadId, context)) {
    showActiveActivityBubble();
  }
});
```

완료 말풍선 생성은 `activityHeading(completionTitle, result)`를 사용해 완료 직전의 section, model, reasoning을 유지한다.

tool title mapping을 다음처럼 확장한다.

```js
const title = activity.kind === "patch"
  ? "파일 수정 중"
  : activity.kind === "test"
    ? "테스트 중"
    : activity.kind === "build"
      ? "빌드 중"
      : ["read", "search"].includes(activity.kind)
        ? "자료 확인 중"
        : "명령 실행 중";
```

`app.whenReady()`에서 `registerExternalWatcher(kimiWatcher, "Kimi")`와 `kimiWatcher.start()`를 추가한다. `window-all-closed`에서 `kimiWatcher.stop()`을 추가한다.

- [ ] **Step 4: 연결·activity 상태 테스트 통과 확인**

Run: `node --test test/kimi-watcher.test.js test/activity-bubble-state.test.js test/activity-icons.test.js`

Expected: PASS. Kimi context refresh와 기존 상태 제목·아이콘 계약 통과.

- [ ] **Step 5: Task 4 커밋**

```bash
git add src/main.js test/kimi-watcher.test.js
git commit -m "feat(kimi): 펫 작업 상태 연결"
```

### Task 5: 문서·전체 회귀·실제 로컬 로그 smoke test

**Files:**
- Modify: `README.md:1-5, 130-137`
- Modify: `package.json:5`
- Modify: `test/kimi-watcher.test.js`

**Interfaces:**
- Consumes: 완성된 Kimi watcher와 실제 로컬 Kimi Code 0.27.0 세션 구조.
- Produces: 사용자 문서, 전체 테스트 증거, 민감 내용 없는 live 감지 증거.

- [ ] **Step 1: 문서 계약 실패 테스트 작성**

`test/kimi-watcher.test.js`에 다음 테스트를 추가한다.

```js
test("제품 설명과 README가 Kimi CLI 지원을 명시한다", () => {
  const packageJson = require("../package.json");
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(packageJson.description, /Kimi/);
  assert.match(readme, /Kimi Code CLI/);
  assert.match(readme, /kimi-watcher\.js/);
});
```

- [ ] **Step 2: 문서 테스트 실패 확인**

Run: `node --test test/kimi-watcher.test.js`

Expected: FAIL. 현재 제품 설명과 README에 Kimi가 없음.

- [ ] **Step 3: README와 package 설명 갱신**

`package.json` description을 다음으로 바꾼다.

```json
"description": "Multi-provider desktop companion for Codex, Antigravity, Claude, and Kimi."
```

README 첫 문단과 CLI 설명에 Kimi를 추가하고 코드 구조를 다음처럼 갱신한다.

```markdown
- `src/codex-watcher.js`, `antigravity-watcher.js`, `claude-watcher.js`, `kimi-watcher.js` — 네 프로그램의 로컬 작업 로그 감시
```

Kimi는 `~/.kimi-code/sessions` 로그를 읽으며 계정·사용량 조회 대상이 아니라는 문장을 지원 설명에 추가한다.

- [ ] **Step 4: focused와 전체 테스트 실행**

Run: `node --test test/kimi-watcher.test.js test/provider-watcher.test.js test/activity-bubble-state.test.js test/activity-icons.test.js`

Expected: PASS.

Run: `npm test`

Expected: 전체 테스트 PASS, 실패 0개.

- [ ] **Step 5: 실제 Kimi 로그 read-only smoke test**

실제 `~/.kimi-code/sessions`에는 쓰지 않는다. 다음 Node one-liner로 발견·메타데이터 정규화만 확인한다.

```bash
node - <<'NODE'
const os = require("node:os");
const path = require("node:path");
const { findKimiWireFiles, readKimiSessionMetadata } = require("./src/kimi-watcher");
const root = path.join(os.homedir(), ".kimi-code", "sessions");
const files = findKimiWireFiles(root, 20);
const main = files.filter((file) => path.basename(path.dirname(file)) === "main");
console.log(JSON.stringify({ mainSessions: main.length, metadataReadable: main.every((file) => Boolean(readKimiSessionMetadata(file).sessionId)) }));
NODE
```

Expected: `metadataReadable: true`. 세션 제목, 메시지, 경로 원문은 출력하지 않는다.

- [ ] **Step 6: diff와 비밀값 점검**

Run: `git diff --check && git status --short && rg -n "api_key|access_token|refresh_token|Bearer " src test README.md package.json`

Expected: `git diff --check` 성공. 새 비밀값 없음. `rg` 결과가 기존 테스트 fixture 또는 안전한 식별자 외에는 없음.

- [ ] **Step 7: Task 5 커밋**

```bash
git add README.md package.json src/kimi-watcher.js test/kimi-watcher.test.js
git commit -m "docs: Kimi CLI 지원 안내 추가"
```

- [ ] **Step 8: 최종 상태 기록**

Run: `git status --short --branch && git log -6 --oneline`

Expected: 작업 트리 clean. Kimi 구현 커밋들이 현재 branch에 존재. 사용자 요청 전에는 push하지 않음.
