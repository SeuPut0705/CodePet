# CLI Project Labels and Kimi 5h·7d Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CLI auto-session titles with project labels and show Kimi Code account 5-hour and 7-day remaining quota on the first visible Kimi activity section.

**Architecture:** Add a pure Kimi quota normalizer, a main-process-only OAuth/API client, and a polling controller. Carry provider/client/project metadata through watchers into activity state, then decorate the first visible section for each provider with its own quota badges. Keep all secrets and raw Kimi API payloads out of renderer data.

**Tech Stack:** Electron 40, CommonJS Node.js, Node built-in `fetch`, `node:test`, JSONL watcher state, DOM `textContent`, macOS `electron-builder` packaging.

## Global Constraints

- Kimi badges show account quota only: `5h` and `7d` remaining percentages; never context-window usage.
- CLI headings use `project · model · effort`; Kimi `state.json.title` is ignored.
- Codex Desktop keeps app-server title hydration; Codex CLI/exec does not.
- Provider quota badges render only on the first visible section for that provider, including single-section bubbles.
- Kimi credentials and raw API responses stay in the Electron main process and never appear in logs, errors, IPC, or renderer data.
- OAuth refresh uses Kimi's `~/.kimi-code/oauth/kimi-code.lock` directory convention and atomic `0600` credential replacement.
- Kimi activity continues normally when usage lookup fails; missing/invalid quota windows are omitted independently.
- No Kimi account switching, context usage, Extra Usage balance, or custom-provider quota guessing.

---

### Task 1: Pure Kimi 5h·7d quota normalization

**Files:**
- Create: `src/kimi-usage.js`
- Create: `test/kimi-usage.test.js`

**Interfaces:**
- Consumes: Kimi `/coding/v1/usages` JSON payload.
- Produces: `buildKimiUsageBadges(payload) -> Array<{key: "5h"|"7d", remainingPercent: number, ariaLabel: string}>`.
- Produces: `parseKimiUsageWindows(payload) -> Array<{minutes: 300|10080, used: number, limit: number}>` for diagnostics and tests.

- [ ] **Step 1: Write failing payload-normalization tests**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildKimiUsageBadges, parseKimiUsageWindows } = require("../src/kimi-usage");

test("Kimi weekly summary와 5시간 window를 남은 퍼센트로 만든다", () => {
  const payload = {
    usage: { used: 57, limit: 100, name: "Weekly limit" },
    limits: [{
      window: { duration: 5, timeUnit: "HOUR" },
      detail: { used: 28, limit: 100 },
    }],
  };
  assert.deepEqual(buildKimiUsageBadges(payload), [
    { key: "5h", remainingPercent: 72, ariaLabel: "Kimi 5시간 72% 남음" },
    { key: "7d", remainingPercent: 43, ariaLabel: "Kimi 7일 43% 남음" },
  ]);
});

test("Kimi remaining 필드와 숫자 문자열을 안전하게 정규화한다", () => {
  const payload = {
    usage: { remaining: "31", limit: "100" },
    limits: [{ duration: 300, timeUnit: "MINUTE", remaining: 82, limit: 100 }],
  };
  assert.deepEqual(parseKimiUsageWindows(payload), [
    { minutes: 300, used: 18, limit: 100 },
    { minutes: 10080, used: 69, limit: 100 },
  ]);
});

test("잘못된 Kimi window만 제외하고 퍼센트를 0..100으로 제한한다", () => {
  assert.deepEqual(buildKimiUsageBadges({
    usage: { used: -10, limit: 100 },
    limits: [
      { window: { duration: 5, timeUnit: "HOUR" }, detail: { used: 140, limit: 100 } },
      { window: { duration: 3, timeUnit: "HOUR" }, detail: { used: 10, limit: 100 } },
      { window: { duration: 7, timeUnit: "DAY" }, detail: { used: "bad", limit: 100 } },
    ],
  }), [
    { key: "5h", remainingPercent: 0, ariaLabel: "Kimi 5시간 0% 남음" },
    { key: "7d", remainingPercent: 100, ariaLabel: "Kimi 7일 100% 남음" },
  ]);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/kimi-usage.test.js`

Expected: FAIL because `../src/kimi-usage` does not exist.

- [ ] **Step 3: Implement strict pure normalizers**

```js
"use strict";

const TARGETS = new Map([[300, ["5h", "5시간"]], [10080, ["7d", "7일"]]);

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowMinutes(item, fallback) {
  if (fallback === 10080) return fallback;
  const window = item?.window && typeof item.window === "object" ? item.window : item;
  const duration = finiteNumber(window?.duration);
  const unit = String(window?.timeUnit || "").toUpperCase();
  if (unit.includes("MINUTE")) return duration;
  if (unit.includes("HOUR")) return duration === null ? null : duration * 60;
  if (unit.includes("DAY")) return duration === null ? null : duration * 1440;
  return null;
}

function usageWindow(raw, minutes) {
  if (!raw || typeof raw !== "object" || !TARGETS.has(minutes)) return null;
  const limit = finiteNumber(raw.limit);
  let used = finiteNumber(raw.used);
  const remaining = finiteNumber(raw.remaining);
  if (used === null && remaining !== null && limit !== null) used = limit - remaining;
  if (used === null || limit === null || limit <= 0) return null;
  return { minutes, used, limit };
}

function parseKimiUsageWindows(payload) {
  if (!payload || typeof payload !== "object") return [];
  const byMinutes = new Map();
  for (const item of Array.isArray(payload.limits) ? payload.limits : []) {
    const detail = item?.detail && typeof item.detail === "object" ? item.detail : item;
    const parsed = usageWindow(detail, windowMinutes(item, null));
    if (parsed) byMinutes.set(parsed.minutes, parsed);
  }
  const weekly = usageWindow(payload.usage, 10080);
  if (weekly) byMinutes.set(10080, weekly);
  return [...TARGETS.keys()].flatMap((minutes) => byMinutes.has(minutes) ? [byMinutes.get(minutes)] : []);
}

function buildKimiUsageBadges(payload) {
  return parseKimiUsageWindows(payload).map(({ minutes, used, limit }) => {
    const [key, name] = TARGETS.get(minutes);
    const remainingPercent = Math.round(Math.min(100, Math.max(0, (limit - used) / limit * 100)));
    return { key, remainingPercent, ariaLabel: `Kimi ${name} ${remainingPercent}% 남음` };
  });
}

module.exports = { buildKimiUsageBadges, parseKimiUsageWindows };
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/kimi-usage.test.js`

Expected: all Kimi normalization tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/kimi-usage.js test/kimi-usage.test.js docs/superpowers/plans/2026-07-20-cli-project-label-kimi-usage.md
git commit -m "feat(kimi): 5h·7d 사용량 정규화"
```

---

### Task 2: Main-process Kimi OAuth and usage client

**Files:**
- Create: `src/kimi-usage-client.js`
- Create: `test/kimi-usage-client.test.js`
- Modify: `src/provider-profile-store.js` only if its existing atomic writer cannot preserve Kimi's exact snake_case token fields.

**Interfaces:**
- Consumes: `~/.kimi-code/credentials/kimi-code.json`, optional `KIMI_CODE_HOME`, managed base URL.
- Produces: `new KimiUsageClient(options).fetchBadges() -> Promise<Array<badge>>`.
- Uses: `buildKimiUsageBadges(payload)` from Task 1.
- Never returns: credentials, access tokens, refresh tokens, raw API payload, user identity.

- [ ] **Step 1: Write failing credential/API tests with isolated temp files**

```js
test("유효한 Kimi access token으로 사용량을 조회하고 자격 파일은 쓰지 않는다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "access-a", refresh_token: "refresh-a", expires_at: 5000, expires_in: 3600 });
  let requested;
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fetchImpl: async (url, options) => {
      requested = { url, authorization: options.headers.Authorization };
      return jsonResponse({ usage: { used: 20, limit: 100 } });
    },
  });
  assert.deepEqual(await client.fetchBadges(), [
    { key: "7d", remainingPercent: 80, ariaLabel: "Kimi 7일 80% 남음" },
  ]);
  assert.deepEqual(requested, {
    url: "https://api.kimi.com/coding/v1/usages",
    authorization: "Bearer access-a",
  });
  assert.equal(fs.readFileSync(fixture.file, "utf8"), fixture.original);
});

test("만료 임박 토큰은 공유 lock 안에서 다시 읽고 회전된 토큰을 원자 저장한다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", refresh_token: "refresh-a", expires_at: 1001, expires_in: 3600 });
  const requests = [];
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: String(options.body || "") });
      if (url.includes("/api/oauth/token")) return jsonResponse({ access_token: "new", refresh_token: "refresh-b", expires_in: 3600, token_type: "Bearer" });
      return jsonResponse({ limits: [{ window: { duration: 5, timeUnit: "HOUR" }, detail: { used: 10, limit: 100 } }] });
    },
  });
  assert.equal((await client.fetchBadges())[0].remainingPercent, 90);
  const saved = JSON.parse(fs.readFileSync(fixture.file, "utf8"));
  assert.equal(saved.access_token, "new");
  assert.equal(saved.refresh_token, "refresh-b");
  assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o600);
  assert.match(requests[0].body, /grant_type=refresh_token/);
  assert.doesNotMatch(JSON.stringify(await client.fetchBadges()), /access-a|refresh-a|refresh-b/);
});

test("Kimi 인증·네트워크 실패는 민감값 없는 오류로 격리한다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "secret-access", refresh_token: "secret-refresh", expires_at: 5000, expires_in: 3600 });
  const client = new KimiUsageClient({ homeDir: fixture.home, fetchImpl: async () => jsonResponse({ message: "secret-access" }, 401) });
  await assert.rejects(client.fetchBadges(), (error) => {
    assert.equal(error.code, "KIMI_USAGE_AUTH");
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/kimi-usage-client.test.js`

Expected: FAIL because `KimiUsageClient` is not implemented.

- [ ] **Step 3: Implement client boundaries**

Implement these exact exports and constants:

```js
const DEFAULT_KIMI_HOME = path.join(os.homedir(), ".kimi-code");
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

class KimiUsageError extends Error {
  constructor(code, message) { super(message); this.name = "KimiUsageError"; this.code = code; }
}

class KimiUsageClient {
  constructor({ homeDir = process.env.KIMI_CODE_HOME || DEFAULT_KIMI_HOME, fetchImpl = fetch, nowSeconds = () => Math.floor(Date.now() / 1000), timeoutMs = 8000 } = {}) {}
  async fetchBadges() {}
}

module.exports = { KimiUsageClient, KimiUsageError };
```

Implementation requirements:

- Validate only the six credential fields documented in the spec.
- Use an `AbortController` timeout for refresh and usage requests.
- Send Kimi device headers using existing `device_id`; do not create a new identity when the file is missing.
- Refresh when `expires_at - now < max(300, expires_in * 0.5)`.
- Acquire the shared lock directory with `fs.promises.mkdir(lockDir)` and retry for up to 8 seconds.
- While owned, refresh the lock directory mtime every 2 seconds; never remove a fresh lock owned by another process.
- After acquiring the lock, reload credentials and accept another process's already-refreshed token.
- Write a `0600` temporary JSON file, `fsync`, then rename over the credential file.
- Release only the lock acquired by this instance.
- On 401, reload credentials and retry once if the access token changed; otherwise return `KIMI_USAGE_AUTH` without server text.
- Map timeout/network/429/5xx to stable codes and generic Korean messages without response bodies.

- [ ] **Step 4: Run client tests and Task 1 tests**

Run: `node --test test/kimi-usage-client.test.js test/kimi-usage.test.js`

Expected: all tests PASS and no token text appears in test output.

- [ ] **Step 5: Commit**

```bash
git add src/kimi-usage-client.js test/kimi-usage-client.test.js
git commit -m "feat(kimi): 계정 사용량 안전 조회"
```

---

### Task 3: Kimi usage polling lifecycle

**Files:**
- Create: `src/kimi-usage-controller.js`
- Create: `test/kimi-usage-controller.test.js`

**Interfaces:**
- Consumes: object with `fetchBadges() -> Promise<Array<badge>>`.
- Produces: `KimiUsageController#setWorking(boolean)`, `refresh()`, `buildBadges()`, `dispose()`.
- Calls: `onBadgesChanged(badges)` only when normalized badge values change.

- [ ] **Step 1: Write failing fake-clock lifecycle tests**

```js
test("Kimi 첫 작업에서 즉시 조회하고 60초마다 하나의 요청만 유지한다", async () => {
  const pending = deferred();
  let calls = 0;
  const clock = fakeIntervalClock();
  const controller = new KimiUsageController({
    client: { fetchBadges: () => { calls += 1; return pending.promise; } },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  controller.setWorking(true);
  controller.setWorking(true);
  assert.equal(calls, 1);
  await clock.advance(60_000);
  assert.equal(calls, 1);
  pending.resolve([{ key: "5h", remainingPercent: 70, ariaLabel: "Kimi 5시간 70% 남음" }]);
  await controller.whenIdle();
  await clock.advance(60_000);
  assert.equal(calls, 2);
});

test("Kimi 마지막 작업 종료는 timer와 배지를 제거한다", async () => {
  const changes = [];
  const clock = fakeIntervalClock();
  const controller = new KimiUsageController({
    client: { fetchBadges: async () => [{ key: "7d", remainingPercent: 40, ariaLabel: "Kimi 7일 40% 남음" }] },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onBadgesChanged: (badges) => changes.push(badges),
  });
  controller.setWorking(true);
  await controller.whenIdle();
  controller.setWorking(false);
  assert.deepEqual(controller.buildBadges(), []);
  assert.deepEqual(changes.at(-1), []);
  assert.equal(clock.size, 0);
});

test("Kimi 일시 오류는 기존 배지를 유지하고 다음 주기에 재시도한다", async () => {
  let fail = false;
  const controller = new KimiUsageController({ client: { fetchBadges: async () => {
    if (fail) throw new Error("temporary");
    return [{ key: "5h", remainingPercent: 55, ariaLabel: "Kimi 5시간 55% 남음" }];
  } } });
  controller.setWorking(true);
  await controller.whenIdle();
  fail = true;
  await controller.refresh();
  assert.equal(controller.buildBadges()[0].remainingPercent, 55);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/kimi-usage-controller.test.js`

Expected: FAIL because controller module is missing.

- [ ] **Step 3: Implement controller with a 60-second one-shot timer**

```js
class KimiUsageController {
  constructor({ client, pollMs = 60_000, setTimer = setTimeout, clearTimer = clearTimeout, onBadgesChanged = () => {} }) {}
  setWorking(working) {}
  async refresh() {}
  schedule() {}
  buildBadges() { return this.badges.map((badge) => ({ ...badge })); }
  whenIdle() { return this.inFlight || Promise.resolve(); }
  dispose() {}
}
```

Use a one-shot timer scheduled after each settled request, not `setInterval`. Coalesce concurrent `refresh()` calls into `this.inFlight`. Clear badges only when `setWorking(false)` or `dispose()` runs; transient fetch errors preserve the last successful values.

- [ ] **Step 4: Run controller tests**

Run: `node --test test/kimi-usage-controller.test.js test/kimi-usage-client.test.js test/kimi-usage.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/kimi-usage-controller.js test/kimi-usage-controller.test.js
git commit -m "feat(kimi): 사용량 갱신 수명주기 추가"
```

---

### Task 4: CLI project labels and client classification

**Files:**
- Modify: `src/activity-labels.js`
- Modify: `src/kimi-watcher.js`
- Modify: `src/claude-watcher.js`
- Modify: `src/codex-watcher.js`
- Modify: `src/main.js`
- Modify: `test/kimi-watcher.test.js`
- Modify: `test/provider-watcher.test.js`
- Modify: `test/codex-watcher.test.js`
- Modify: `test/settings-ui.test.js`

**Interfaces:**
- Produces: `projectLabelFromCwd(cwd, fallback) -> safe section label`.
- Watcher context adds `provider`, `clientKind: "desktop"|"cli"`, and project `sectionLabel` for CLI.
- Codex main title hydration runs only when `context.clientKind === "desktop"`.

- [ ] **Step 1: Write failing CLI label tests**

```js
test("Kimi metadata는 자동 title 대신 작업 폴더명을 section으로 사용한다", (t) => {
  const fixture = sessionFixture(tempDir(t), "session_one", "/work/shortput");
  fs.writeFileSync(path.join(fixture.session, "state.json"), JSON.stringify({ title: "자동 생성 제목", workDir: "/work/shortput" }));
  assert.deepEqual(readKimiSessionMetadata(fixture.wire), {
    sessionId: "session_one",
    sectionLabel: "shortput",
    cwd: "/work/shortput",
    clientKind: "cli",
  });
});

test("Codex rollout metadata는 Desktop과 CLI를 분류하고 CLI 프로젝트명을 보존한다", (t) => {
  const cli = rolloutFixture(t, { originator: "codex-tui", source: "cli", cwd: "/work/codepet" });
  const desktop = rolloutFixture(t, { originator: "Codex Desktop", source: "vscode", cwd: "/work/codepet" });
  assert.equal(readRolloutMetadata(cli).clientKind, "cli");
  assert.equal(readRolloutMetadata(cli).sectionLabel, "codepet");
  assert.equal(readRolloutMetadata(desktop).clientKind, "desktop");
  assert.equal(readRolloutMetadata(desktop).sectionLabel, null);
});

test("Claude CLI는 cwd 프로젝트명을 activity context로 전달한다", (t) => {
  const event = parseClaudeRow({ type: "user", sessionId: "a", cwd: "/work/mowda-one", message: { content: "진행" } }, "/tmp/a.jsonl");
  assert.equal(event.sectionLabel, "mowda-one");
  assert.equal(event.clientKind, "cli");
});
```

Add a static main test asserting CLI context bypasses `codexThreadTitles.resolve` while Desktop context still resolves.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/kimi-watcher.test.js test/provider-watcher.test.js test/codex-watcher.test.js test/settings-ui.test.js`

Expected: FAIL because automatic Kimi title remains and client classification is absent.

- [ ] **Step 3: Implement safe project labels and propagation**

```js
function projectLabelFromCwd(cwd, fallback = null) {
  if (typeof cwd !== "string" || !cwd.trim()) return safeSectionLabel(fallback);
  const normalized = cwd.replace(/[\\/]+$/, "");
  return safeSectionLabel(path.basename(normalized) || fallback);
}
```

Kimi metadata must ignore `state.title`, set `clientKind: "cli"`, and use `projectLabelFromCwd(state.workDir, "Kimi")`. Claude events use `projectLabelFromCwd(row.cwd, "Claude")` and `clientKind: "cli"`.

Extend Codex `readRolloutMetadata()` to retain sanitized `cwd`, derive `clientKind` from `originator/source`, and set a project section only for CLI/exec. Include those fields in metadata cache equality and `contextFor(filePath)`.

Change main title functions to:

```js
function contextWithCodexThreadTitle(context = {}) {
  if (context.clientKind !== "desktop") return context;
  const sectionLabel = codexThreadTitles.get(context.threadId);
  return sectionLabel ? { ...context, sectionLabel } : context;
}

function hydrateCodexThreadTitle(threadId, context = {}) {
  if (context.clientKind !== "desktop" || !CODEX_THREAD_ID_PATTERN.test(threadId || "")) return;
  // existing async resolver body
}
```

- [ ] **Step 4: Run focused watcher and UI tests**

Run: `node --test test/kimi-watcher.test.js test/provider-watcher.test.js test/codex-watcher.test.js test/settings-ui.test.js`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/activity-labels.js src/kimi-watcher.js src/claude-watcher.js src/codex-watcher.js src/main.js test/kimi-watcher.test.js test/provider-watcher.test.js test/codex-watcher.test.js test/settings-ui.test.js
git commit -m "feat(activity): CLI 작업을 프로젝트명으로 표시"
```

---

### Task 5: Provider-scoped section badges and renderer

**Files:**
- Modify: `src/activity-bubble-state.js`
- Modify: `src/activity-usage.js`
- Modify: `src/bubble.js`
- Modify: `src/bubble.css`
- Modify: `test/activity-bubble-state.test.js`
- Modify: `test/activity-usage.test.js`
- Modify: `test/settings-ui.test.js`

**Interfaces:**
- Activity entries preserve `provider` from watcher context.
- Produces: `decorateActivityBubbleWithProviderUsage(data, usageByProvider) -> decorated copy`.
- `usageByProvider` shape: `{ codex?: badge[], kimi?: badge[] }`.
- Renderer consumes `section.usageBadges` for both single and multi-section activity data.

- [ ] **Step 1: Write failing provider-dedupe and renderer tests**

```js
test("공급자별 첫 visible section에만 사용량 배지를 붙인다", () => {
  const data = {
    title: "총 4개 작업 중",
    sections: [
      { threadId: "codex:a", provider: "codex" },
      { threadId: "kimi:a", provider: "kimi" },
      { threadId: "kimi:b", provider: "kimi" },
      { threadId: "codex:b", provider: "codex" },
    ],
  };
  const result = decorateActivityBubbleWithProviderUsage(data, {
    codex: [{ key: "7d", remainingPercent: 30, ariaLabel: "7일 30% 남음" }],
    kimi: [{ key: "5h", remainingPercent: 70, ariaLabel: "Kimi 5시간 70% 남음" }],
  });
  assert.deepEqual(result.sections.map((section) => section.usageBadges || []), [
    [{ key: "7d", remainingPercent: 30, ariaLabel: "7일 30% 남음" }],
    [{ key: "5h", remainingPercent: 70, ariaLabel: "Kimi 5시간 70% 남음" }],
    [],
    [],
  ]);
});

test("단일 Kimi section에도 사용량 배지를 붙인다", () => {
  const single = { kind: "activity", provider: "kimi", title: "CodePet · K3 · Max" };
  const result = decorateActivityBubbleWithProviderUsage(single, { kimi: KIMI_BADGES });
  assert.deepEqual(result.usageBadges, KIMI_BADGES);
});
```

In the renderer harness, assert `.activity-usage-badges` is a child of the first Codex row and first Kimi row, absent from duplicates and the aggregate header, and present on a single-section title.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/activity-bubble-state.test.js test/activity-usage.test.js test/settings-ui.test.js`

Expected: FAIL because provider is not stored and section badges are not rendered.

- [ ] **Step 3: Implement provider state, decoration, and DOM placement**

Store a sanitized provider (`codex`, `kimi`, `claude`, `agy`) in `ActivityBubbleState.upsert/refresh`, include it in produced sections, and replace the aggregate-only decorator with:

```js
function decorateActivityBubbleWithProviderUsage(data, usageByProvider = {}) {
  if (!data) return data;
  const seen = new Set();
  const decorate = (section) => {
    const provider = section?.provider;
    const badges = Array.isArray(usageByProvider[provider]) ? usageByProvider[provider] : [];
    if (!provider || seen.has(provider) || badges.length === 0) return { ...section, usageBadges: [] };
    seen.add(provider);
    return { ...section, usageBadges: badges.map((badge) => ({ ...badge })) };
  };
  if (Array.isArray(data.sections)) return { ...data, sections: data.sections.map(decorate) };
  return decorate(data);
}
```

Pass `data.usageBadges` into `appendActivityContent()` and call `appendUsageBadges(label, sectionData.usageBadges)` after the subagent badge for multi-section rows. Remove aggregate-header usage rendering. Keep `.activity-title-text` as the only shrinking element and `.activity-usage-badges` fixed at the row end.

- [ ] **Step 4: Run focused state and renderer tests**

Run: `node --test test/activity-bubble-state.test.js test/activity-usage.test.js test/settings-ui.test.js`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/activity-bubble-state.js src/activity-usage.js src/bubble.js src/bubble.css test/activity-bubble-state.test.js test/activity-usage.test.js test/settings-ui.test.js
git commit -m "feat(activity): 공급자별 사용량 배지 표시"
```

---

### Task 6: Main lifecycle integration, documentation, package verification

**Files:**
- Modify: `src/main.js`
- Modify: `README.md`
- Modify: `test/kimi-usage-controller.test.js`
- Modify: `test/settings-ui.test.js`

**Interfaces:**
- Instantiates `KimiUsageClient` and `KimiUsageController` once in the Electron main process.
- `showActiveActivityBubble()` decorates activity state with `{ codex: activityUsageController.buildBadges(), kimi: kimiUsageController.buildBadges() }`.
- Kimi watcher `working-changed` drives `kimiUsageController.setWorking(kimiWatcher.working)`.

- [ ] **Step 1: Write failing static lifecycle and documentation tests**

```js
test("main은 Kimi 사용량 controller를 watcher와 말풍선 수명주기에 연결한다", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /new KimiUsageClient\(/);
  assert.match(main, /new KimiUsageController\(/);
  assert.match(main, /kimiUsageController\.setWorking\(kimiWatcher\.working\)/);
  assert.match(main, /kimiUsageController\.dispose\(\)/);
  assert.match(main, /decorateActivityBubbleWithProviderUsage/);
});

test("README는 Kimi 5h·7d 사용량과 CLI 프로젝트 제목 정책을 설명한다", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /Kimi.*5h.*7d/s);
  assert.match(readme, /CLI.*프로젝트 폴더명/s);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/kimi-usage-controller.test.js test/settings-ui.test.js`

Expected: FAIL because main and README are not integrated.

- [ ] **Step 3: Integrate main lifecycle and README**

Create the Kimi usage objects next to existing watcher/controller singletons. In `showActiveActivityBubble()`, decorate the privacy-filtered activity snapshot with provider-scoped badges immediately before `showBubble()`.

On every Kimi `working-changed`, call `kimiUsageController.setWorking(kimiWatcher.working)` after watcher state has changed. On app shutdown, call `dispose()` before destroying windows. The controller callback should redraw only when an active activity bubble exists; it must not open a hidden bubble.

Document:

```md
- CLI 활동 제목은 자동 세션 제목 대신 프로젝트 폴더명을 사용합니다.
- 관리형 Kimi Code 로그인에서는 작업 중 첫 Kimi 섹션에 `5h`·`7d` 남은 사용량을 표시합니다. 사용자 지정 provider와 컨텍스트 사용량은 표시하지 않습니다.
```

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test
node --check src/kimi-usage.js
node --check src/kimi-usage-client.js
node --check src/kimi-usage-controller.js
node --check src/main.js
git diff --check
```

Expected: all tests PASS, all syntax checks exit 0, and `git diff --check` has no output.

- [ ] **Step 5: Run live read-only Kimi quota smoke without printing payload or tokens**

Run a Node script that instantiates `KimiUsageClient`, calls `fetchBadges()`, and prints only:

```json
{"keys":["5h","7d"],"validPercents":true}
```

Expected: both managed Kimi quota keys are present when the current account exposes both windows. Never print credentials, headers, raw payload, account identifiers, or server error bodies.

- [ ] **Step 6: Commit implementation**

```bash
git add src/main.js README.md test/kimi-usage-controller.test.js test/settings-ui.test.js
git commit -m "feat(kimi): 활동 말풍선에 5h·7d 사용량 연결"
```

- [ ] **Step 7: Build and relaunch the normal macOS app**

Run:

```bash
npm run dist -- --mac
npx --no-install asar list artifacts/mac-arm64/CodePet.app/Contents/Resources/app.asar | rg '(/src/kimi-usage-client.js|/src/kimi-usage-controller.js|/src/kimi-usage.js|/src/main.js)$'
```

Expected: unsigned local macOS package succeeds and all four files are present in `app.asar`.

Only after the package succeeds, terminate the exact old CodePet executable, launch `artifacts/mac-arm64/CodePet.app`, and verify a new PID. Use Chronicle read-only screen inspection to confirm a Kimi section shows a project label plus `5h` and `7d` badges; distinguish this local unsigned runtime proof from signed release proof.

- [ ] **Step 8: Final repository verification**

Run:

```bash
npm test
git status --short --branch
git log -7 --oneline
```

Expected: full suite PASS, working tree clean, and the six implementation commits plus the design commit are on `main`. Do not push or open a PR unless the user explicitly requests it.
