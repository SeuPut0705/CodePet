# 작업별 서브에이전트 수 표시 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 각 Codex 사용자 작업 제목 옆에 중첩된 활성 서브에이전트 총수를 표시하되 내부 메시지는 계속 숨긴다.

**Architecture:** 순수 `SubagentActivityTracker`가 thread 부모 그래프와 활성 집합을 관리하고 최상위 사용자 thread별 재귀 합계를 계산한다. `CodexWatcher`는 사용자 rollout과 서브에이전트 rollout을 별도 제한으로 tail하며, 서브에이전트에서는 수명주기만 tracker에 전달한다. main process와 `ActivityBubbleState`는 구조화된 `subagentCount`를 renderer에 전달하고 renderer가 제목 뒤에 독립 배지를 만든다.

**Tech Stack:** Electron, Node.js CommonJS, `node:test`, DOM 기반 renderer, 인라인 SVG, CSS

## Global Constraints

- 서브에이전트의 이름, 모델, 메시지, 도구 활동은 사용자 말풍선에 노출하지 않는다.
- 직속 자식뿐 아니라 중첩된 모든 활성 자손을 최상위 사용자 작업에 합산한다.
- `task_started`에서 증가하고 `task_complete`, `turn_aborted`, stale 정리에서 감소한다.
- `subagentCount === 0`이면 배지를 렌더링하지 않는다.
- AGY와 Claude 활동에는 배지를 표시하지 않는다.
- 외부 라이브러리를 추가하지 않는다.
- 앱 재시작 시 최근 rollout에서 진행 중인 서브에이전트 수를 복원한다.

---

### Task 1: 재귀 서브에이전트 집계기

**Files:**
- Create: `src/subagent-activity-tracker.js`
- Create: `test/subagent-activity-tracker.test.js`

**Interfaces:**
- Consumes: `{ threadId: string, threadSource: "user" | "subagent", parentThreadId: string | null }`
- Produces: `SubagentActivityTracker.registerThread(metadata)`, `setActive(threadId, active)`, `removeThread(threadId)`, `countsByRoot(): Map<string, number>`, `getCount(rootThreadId): number`

- [ ] **Step 1: Write the failing graph tests**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { SubagentActivityTracker } = require("../src/subagent-activity-tracker");

test("직속 및 중첩 활성 자손을 최상위 사용자 작업에 합산한다", () => {
  const tracker = new SubagentActivityTracker();
  tracker.registerThread({ threadId: "root", threadSource: "user", parentThreadId: null });
  tracker.registerThread({ threadId: "child", threadSource: "subagent", parentThreadId: "root" });
  tracker.registerThread({ threadId: "grandchild", threadSource: "subagent", parentThreadId: "child" });
  tracker.setActive("child", true);
  tracker.setActive("grandchild", true);
  assert.equal(tracker.getCount("root"), 2);
  tracker.setActive("child", false);
  assert.equal(tracker.getCount("root"), 1);
});

test("작업별 개수를 분리하고 순환·고아 관계는 제외한다", () => {
  const tracker = new SubagentActivityTracker();
  tracker.registerThread({ threadId: "root-a", threadSource: "user", parentThreadId: null });
  tracker.registerThread({ threadId: "root-b", threadSource: "user", parentThreadId: null });
  tracker.registerThread({ threadId: "a", threadSource: "subagent", parentThreadId: "root-a" });
  tracker.registerThread({ threadId: "b", threadSource: "subagent", parentThreadId: "root-b" });
  tracker.registerThread({ threadId: "cycle-1", threadSource: "subagent", parentThreadId: "cycle-2" });
  tracker.registerThread({ threadId: "cycle-2", threadSource: "subagent", parentThreadId: "cycle-1" });
  for (const id of ["a", "b", "cycle-1", "cycle-2"]) tracker.setActive(id, true);
  assert.deepEqual([...tracker.countsByRoot()], [["root-a", 1], ["root-b", 1]]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/subagent-activity-tracker.test.js`

Expected: FAIL because `src/subagent-activity-tracker.js` does not exist.

- [ ] **Step 3: Implement the bounded graph tracker**

```js
"use strict";

class SubagentActivityTracker {
  constructor({ maxThreads = 512 } = {}) {
    this.maxThreads = maxThreads;
    this.threads = new Map();
    this.active = new Set();
  }

  registerThread({ threadId, threadSource, parentThreadId = null } = {}) {
    if (!threadId || !["user", "subagent"].includes(threadSource)) return false;
    this.threads.set(threadId, { threadSource, parentThreadId: parentThreadId || null });
    while (this.threads.size > this.maxThreads) {
      const oldest = this.threads.keys().next().value;
      this.threads.delete(oldest);
      this.active.delete(oldest);
    }
    return true;
  }

  setActive(threadId, active) {
    if (!this.threads.has(threadId)) return false;
    if (active) this.active.add(threadId);
    else this.active.delete(threadId);
    return true;
  }

  removeThread(threadId) {
    this.active.delete(threadId);
    return this.threads.delete(threadId);
  }

  rootFor(threadId) {
    const visited = new Set();
    let currentId = threadId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const metadata = this.threads.get(currentId);
      if (!metadata) return null;
      if (metadata.threadSource === "user") return currentId;
      currentId = metadata.parentThreadId;
    }
    return null;
  }

  countsByRoot() {
    const counts = new Map();
    for (const threadId of this.active) {
      const metadata = this.threads.get(threadId);
      if (metadata?.threadSource !== "subagent") continue;
      const rootId = this.rootFor(threadId);
      if (rootId) counts.set(rootId, (counts.get(rootId) || 0) + 1);
    }
    return counts;
  }

  getCount(rootThreadId) {
    return this.countsByRoot().get(rootThreadId) || 0;
  }
}

module.exports = { SubagentActivityTracker };
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/subagent-activity-tracker.test.js`

Expected: 2 tests pass, 0 fail.

- [ ] **Step 5: Commit the tracker**

```bash
git add src/subagent-activity-tracker.js test/subagent-activity-tracker.test.js
git commit -m "feat(activity): 서브에이전트 수 집계"
```

---

### Task 2: CodexWatcher 수명주기 연결과 재시작 복원

**Files:**
- Modify: `src/codex-watcher.js`
- Modify: `test/codex-watcher.test.js`

**Interfaces:**
- Consumes: `SubagentActivityTracker` from Task 1 and parsed `session_meta`
- Produces: watcher event `subagent-count-changed`, payload `{ threadId: string, subagentCount: number }`

- [ ] **Step 1: Add failing watcher lifecycle tests**

```js
test("서브에이전트 메시지는 숨기고 부모 작업에 재귀 활성 수만 발행한다", () => {
  const ROOT_ID = "019f4a30-b0a7-73f1-8080-2ba11b4e5d25";
  const CHILD_ID = "019f4a31-1111-7222-8333-444444444444";
  const GRANDCHILD_ID = "019f4a32-1111-7222-8333-444444444444";
  const ROOT_PATH = `/tmp/rollout-${ROOT_ID}.jsonl`;
  const CHILD_PATH = `/tmp/rollout-${CHILD_ID}.jsonl`;
  const GRANDCHILD_PATH = `/tmp/rollout-${GRANDCHILD_ID}.jsonl`;
  const watcher = new CodexWatcher({ getCodexHomes: () => [] });
  const counts = [];
  const messages = [];
  watcher.on("subagent-count-changed", (value) => counts.push(value));
  watcher.on("agent-message", (value) => messages.push(value));

  watcher.registerRolloutMetadata(ROOT_PATH, {
    threadId: ROOT_ID, threadSource: "user", parentThreadId: null,
  });
  watcher.registerRolloutMetadata(CHILD_PATH, {
    threadId: CHILD_ID, threadSource: "subagent", parentThreadId: ROOT_ID,
  });
  watcher.registerRolloutMetadata(GRANDCHILD_PATH, {
    threadId: GRANDCHILD_ID, threadSource: "subagent", parentThreadId: CHILD_ID,
  });
  watcher.handleLine(CHILD_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(GRANDCHILD_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  watcher.handleLine(CHILD_PATH, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "내부 검토" } }));
  watcher.handleLine(CHILD_PATH, JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }));

  assert.deepEqual(counts.map((item) => item.subagentCount), [1, 2, 1]);
  assert.deepEqual(messages, []);
});
```

앱 시작 복원 테스트는 임시 sessions 폴더에 사용자, 직속 subagent, 중첩 subagent rollout을 만들고 `poll()` 뒤 부모 ID의 마지막 count가 2인지 검증한다. 완료된 subagent와 `staleWorkingMs`를 넘은 파일은 0으로 복원되는 사례도 같은 테스트에 포함한다.

- [ ] **Step 2: Run watcher tests and verify RED**

Run: `node --test test/codex-watcher.test.js`

Expected: FAIL because metadata registration and count event do not exist.

- [ ] **Step 3: Parse full rollout metadata and tail separate quotas**

Replace the source-only cache with metadata records:

```js
function readRolloutMetadata(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const size = Math.min(fs.fstatSync(fd).size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buffer, 0, size, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const newlineIndex = text.indexOf("\n");
    if (newlineIndex < 0) return null;
    const entry = JSON.parse(text.slice(0, newlineIndex));
    if (entry?.type !== "session_meta" || !entry.payload?.id) return null;
    return {
      threadId: entry.payload.id,
      threadSource: entry.payload.thread_source || "user",
      parentThreadId: entry.payload.parent_thread_id || null,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
```

Cache and register metadata through one method so tests and poll use the same path:

```js
registerRolloutMetadata(filePath, metadata) {
  if (!metadata) return false;
  this.rolloutMetadata.set(filePath, metadata);
  this.subagents.registerThread(metadata);
  return true;
}
```

Add `WATCHER_CONFIG.subagentTailFiles = 40`. During each poll, select up to `tailFiles` user rollouts and `subagentTailFiles` subagent rollouts after classification, merge them by mtime, and tail both groups. Never allow subagents to consume the user quota.

- [ ] **Step 4: Route subagent events only to the tracker**

```js
handleSubagentLine(filePath, entry) {
  const metadata = this.rolloutMetadata.get(filePath);
  if (!metadata) return;
  const type = entry?.type === "event_msg" ? entry.payload?.type : null;
  if (type === "task_started") this.subagents.setActive(metadata.threadId, true);
  if (type === "task_complete" || type === "turn_aborted") {
    this.subagents.setActive(metadata.threadId, false);
  }
  if (["task_started", "task_complete", "turn_aborted"].includes(type)) {
    this.emitChangedSubagentCounts();
  }
}

emitChangedSubagentCounts() {
  const next = this.subagents.countsByRoot();
  const roots = new Set([...this.lastSubagentCounts.keys(), ...next.keys()]);
  for (const threadId of roots) {
    const subagentCount = next.get(threadId) || 0;
    if ((this.lastSubagentCounts.get(threadId) || 0) !== subagentCount) {
      this.emit("subagent-count-changed", { threadId, subagentCount });
    }
  }
  this.lastSubagentCounts = next;
}
```

`handleLine()`은 metadata가 subagent이면 `handleSubagentLine()`을 호출하고 즉시 반환한다. stale 제거에서도 tracker를 비활성화하고 count를 다시 발행한다. 첫 poll 복원에서는 `detectWorkingFromFile()`이 true인 subagent만 활성화한다.

- [ ] **Step 5: Run watcher and regression tests**

Run: `node --test test/codex-watcher.test.js test/subagent-activity-tracker.test.js`

Expected: all tests pass; existing subagent-message exclusion tests remain green.

- [ ] **Step 6: Commit watcher integration**

```bash
git add src/codex-watcher.js test/codex-watcher.test.js
git commit -m "feat(activity): 작업별 에이전트 수 추적"
```

---

### Task 3: 활동 상태에 구조화된 개수 전달

**Files:**
- Modify: `src/activity-bubble-state.js`
- Modify: `src/main.js`
- Modify: `test/activity-bubble-state.test.js`
- Modify: `test/settings-ui.test.js`

**Interfaces:**
- Consumes: `{ threadId, subagentCount }` from Task 2
- Produces: each Codex activity section with integer `subagentCount` and accessible `titleLabel`

- [ ] **Step 1: Add failing state tests**

```js
test("서브에이전트 수를 작업별 section에만 저장하고 0에서 숨긴다", () => {
  const state = new ActivityBubbleState();
  state.upsert(THREADS[0], activity("응답 작성 중", "a", "status"), { sectionLabel: "CodePet" });
  state.upsert(THREADS[1], activity("테스트 중", "b", "status"), { sectionLabel: "ShortPut" });
  state.refresh(THREADS[0], { subagentCount: 3 });
  let sections = state.toBubbleData().sections;
  assert.deepEqual(sections.map((item) => item.subagentCount), [3, 0]);
  assert.match(sections[0].titleLabel, /활성 서브에이전트 3개/);
  state.refresh(THREADS[0], { subagentCount: 0 });
  sections = state.toBubbleData().sections;
  assert.deepEqual(sections.map((item) => item.subagentCount), [0, 0]);
});
```

- [ ] **Step 2: Run state tests and verify RED**

Run: `node --test test/activity-bubble-state.test.js test/settings-ui.test.js`

Expected: FAIL because `subagentCount` is not retained or connected in main.

- [ ] **Step 3: Normalize, store, and forward the count**

Add:

```js
function safeSubagentCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}
```

Store it in both `upsert()` and `refresh()`, and include it in each output section. Append `활성 서브에이전트 ${count}개` to `titleLabel` only when count is positive.

Connect the watcher in `registerCodexWatcher()`:

```js
codexWatcher.on("subagent-count-changed", ({ threadId, subagentCount }) => {
  if (activeActivityBubbles.refresh(threadId, { subagentCount })) {
    showActiveActivityBubble();
  }
});
```

- [ ] **Step 4: Run focused state and source-integration tests**

Run: `node --test test/activity-bubble-state.test.js test/settings-ui.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit state integration**

```bash
git add src/activity-bubble-state.js src/main.js test/activity-bubble-state.test.js test/settings-ui.test.js
git commit -m "feat(activity): 에이전트 수를 section에 전달"
```

---

### Task 4: 에이전트 배지 렌더링과 최종 검증

**Files:**
- Modify: `src/activity-icons.js`
- Modify: `src/bubble.js`
- Modify: `src/bubble.css`
- Modify: `test/activity-icons.test.js`
- Modify: `test/settings-ui.test.js`

**Interfaces:**
- Consumes: section field `subagentCount: number`
- Produces: `.subagent-badge` containing an accessible-hidden agent SVG and `×N` text

- [ ] **Step 1: Add failing icon and DOM contract tests**

```js
test("서브에이전트 배지용 16px SVG를 만든다", () => {
  const icon = createActivityIcon(fakeDocument, "agents");
  assert.equal(icon.tagName, "svg");
  assert.equal(icon.attributes["aria-hidden"], "true");
  assert.ok(icon.children.length >= 2);
});
```

`test/settings-ui.test.js`에는 `appendSubagentBadge(label, sectionData.subagentCount)` 호출, `.subagent-badge`, `.subagent-count` CSS가 존재하는지 검사하고 `innerHTML` 사용 금지 검사를 유지한다.

- [ ] **Step 2: Run renderer tests and verify RED**

Run: `node --test test/activity-icons.test.js test/settings-ui.test.js`

Expected: FAIL because `agents` icon and badge renderer do not exist.

- [ ] **Step 3: Add the safe SVG and DOM badge**

Add `agents` to the existing SVG allowlist. Render with DOM APIs only:

```js
function appendSubagentBadge(element, count) {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  const badge = document.createElement("span");
  badge.className = "subagent-badge";
  const icon = window.activityIcons.createActivityIcon(document, "agents");
  if (icon) badge.appendChild(icon);
  const value = document.createElement("span");
  value.className = "subagent-count";
  value.textContent = `×${count}`;
  badge.appendChild(value);
  element.appendChild(badge);
}
```

Call this immediately after `appendStatusHeadingContent()` for both single and multi-section activity headings.

Update the single-title helper and both call sites with the same structured field:

```js
function createTitle(
  titleText,
  busy,
  { titleLabel = null, statusIcon = null, subagentCount = 0 } = {}
) {
  const title = document.createElement("div");
  title.className = "title";
  title.setAttribute("role", "heading");
  title.setAttribute("aria-level", "2");
  if (titleLabel) title.setAttribute("aria-label", titleLabel);
  appendStatusHeadingContent(title, titleText, statusIcon);
  appendSubagentBadge(title, subagentCount);
  return title;
}

const title = createTitle(data.title, data.busy, {
  titleLabel: data.titleLabel,
  statusIcon: data.statusIcon,
  subagentCount: data.subagentCount,
});

appendStatusHeadingContent(label, sectionData.title, sectionData.statusIcon);
appendSubagentBadge(label, sectionData.subagentCount);
```

- [ ] **Step 4: Add compact badge styling**

```css
.subagent-badge {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 2px;
  margin-left: 2px;
  color: color-mix(in srgb, var(--bubble-ink) 72%, transparent);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.subagent-badge .status-icon {
  width: 13px;
  height: 13px;
  color: currentColor;
  animation: none;
}
```

- [ ] **Step 5: Run focused renderer tests**

Run: `node --test test/activity-icons.test.js test/settings-ui.test.js test/activity-bubble-state.test.js`

Expected: all tests pass; zero count produces no badge contract.

- [ ] **Step 6: Run full verification**

Run: `npm test`

Expected: all tests pass, 0 fail.

Run: `npm run dist -- --mac`

Expected: exit code 0 and `artifacts/mac-arm64/CodePet.app` rebuilt. Code signing may be skipped when no Developer ID certificate exists.

- [ ] **Step 7: Perform packaged runtime QA**

Launch the packaged app, start one direct and one nested review subagent under the current CodePet task, and verify:

- title badge changes `×1 → ×2 → ×1 → hidden`
- no subagent message or separate subagent section appears
- parent title remains `CodePet · Sol · <reasoning>`
- normal app process remains alive after completion

- [ ] **Step 8: Commit renderer and push the existing branch**

```bash
git add src/activity-icons.js src/bubble.js src/bubble.css test/activity-icons.test.js test/settings-ui.test.js
git commit -m "feat(activity): 작업별 에이전트 배지 표시"
git push fork fix/macos-autostart
```

Do not create a PR.
