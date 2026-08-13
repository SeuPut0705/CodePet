# Activity Usage Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 다중 활동 말풍선의 `총 N개 작업 중` 헤더 오른쪽에 Codex 5시간·7일 한도의 남은 퍼센트를 `5h 42%`, `7d 68%` 형식으로 표시한다.

**Architecture:** 새 순수 모듈이 watcher의 `rateLimits`를 고정된 배지 계약으로 정규화한다. main process는 최신 배지를 보관하고 Codex가 작업 중인 다중 활동 데이터에만 붙이며, bubble renderer는 원본 rate limit 형식을 모른 채 고정 오른쪽 배지를 그린다.

**Tech Stack:** CommonJS, Electron main/renderer, Node.js `node:test`, DOM API, CSS

## Global Constraints

- 여러 활동이 `sections`로 묶인 집계 헤더에만 표시한다.
- 5시간 한도는 `5h`, 7일 한도는 `7d`로 표시한다.
- 각 값은 사용률이 아닌 남은 비율의 정수다.
- Codex가 실제로 작업 중일 때만 표시한다.
- `token_count`의 최신 `rate_limits`만 사용하며 새 네트워크 요청을 추가하지 않는다.
- 초기화가 지난 창은 100% 남음으로 처리하고 잘못된 창은 숨긴다.
- AGY·Claude 한도, 계정별 합산, 토큰·요청 수 추정은 범위에서 제외한다.
- Git commit 단계는 검토 경계로만 문서화하며, 사용자가 별도로 커밋을 요청한 경우에만 실행한다.

## File Map

- Create `src/activity-usage.js`: rate limit 창을 5h·7d 배지로 정규화하고 다중 활동 데이터에 안전하게 부착한다.
- Create `test/activity-usage.test.js`: 기간 판별, 숫자 보정, reset, 다중 활동 조건을 검증한다.
- Modify `src/main.js`: 최신 watcher 사용량을 저장하고 활성 집계 말풍선에 전달한다.
- Modify `src/bubble.js`: 집계 헤더 전용 사용량 배지 DOM을 만든다.
- Modify `src/bubble.css`: 오른쪽 고정, tabular 숫자, nowrap 스타일을 추가한다.
- Modify `test/settings-ui.test.js`: main 연결과 실제 bubble DOM/CSS 렌더링을 검증한다.

---

### Task 1: 5h·7d 사용량 정규화 모듈

**Files:**
- Create: `src/activity-usage.js`
- Create: `test/activity-usage.test.js`

**Interfaces:**
- Consumes: `{ rateLimits: { windows?: RateWindow[], primary?: RateWindow, secondary?: RateWindow } }`, `Date.now()` 호환 millisecond timestamp
- Produces: `buildActivityUsageBadges(usage, nowMs?) -> Array<{ key: "5h"|"7d", remainingPercent: number, ariaLabel: string }>`
- Produces: `decorateActivityBubbleWithUsage(data, usageBadges, { codexWorking }) -> data | shallow copy with usageBadges`

- [ ] **Step 1: 기간·잔여율 변환 실패 테스트 작성**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildActivityUsageBadges,
  decorateActivityBubbleWithUsage,
} = require("../src/activity-usage");

test("rate limit 순서와 무관하게 5h·7d 남은 퍼센트를 만든다", () => {
  const usage = {
    rateLimits: {
      windows: [
        { window_minutes: 10080, used_percent: 32, resets_at: 500 },
        { window_minutes: 300, used_percent: 58.4, resets_at: 500 },
      ],
    },
  };

  assert.deepEqual(buildActivityUsageBadges(usage, 1_000), [
    { key: "5h", remainingPercent: 42, ariaLabel: "5시간 42% 남음" },
    { key: "7d", remainingPercent: 68, ariaLabel: "7일 68% 남음" },
  ]);
});

test("초기화·범위 보정·잘못된 창을 안전하게 처리한다", () => {
  const usage = {
    rateLimits: {
      primary: { window_minutes: 300, used_percent: 94, resets_at: 1 },
      secondary: { window_minutes: 10080, used_percent: -20, resets_at: 500 },
      windows: [
        { window_minutes: 300, used_percent: 94, resets_at: 1 },
        { window_minutes: 10080, used_percent: -20, resets_at: 500 },
        { window_minutes: 60, used_percent: 10 },
        { window_minutes: 300, used_percent: "unknown", scope: "추가" },
      ],
    },
  };

  assert.deepEqual(buildActivityUsageBadges(usage, 2_000), [
    { key: "5h", remainingPercent: 100, ariaLabel: "5시간 100% 남음" },
    { key: "7d", remainingPercent: 100, ariaLabel: "7일 100% 남음" },
  ]);
  assert.deepEqual(buildActivityUsageBadges(null, 2_000), []);
});

test("Codex가 작업 중인 다중 활동에만 사용량 배지를 붙인다", () => {
  const badges = [
    { key: "5h", remainingPercent: 42, ariaLabel: "5시간 42% 남음" },
  ];
  const multi = { title: "총 2개 작업 중", sections: [{}, {}] };
  const single = { title: "작업 중" };

  const decorated = decorateActivityBubbleWithUsage(multi, badges, { codexWorking: true });
  assert.notEqual(decorated, multi);
  assert.deepEqual(decorated.usageBadges, badges);
  assert.equal(decorateActivityBubbleWithUsage(multi, badges, { codexWorking: false }), multi);
  assert.equal(decorateActivityBubbleWithUsage(single, badges, { codexWorking: true }), single);
  assert.equal(decorateActivityBubbleWithUsage(multi, [], { codexWorking: true }), multi);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test test/activity-usage.test.js`

Expected: FAIL with `Cannot find module '../src/activity-usage'`.

- [ ] **Step 3: 최소 정규화 구현**

Create `src/activity-usage.js`:

```js
const TARGET_WINDOWS = Object.freeze([
  { minutes: 300, key: "5h", accessibleName: "5시간" },
  { minutes: 10080, key: "7d", accessibleName: "7일" },
]);

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

function resetHasPassed(rateWindow, nowMs) {
  const resetAt = Number(rateWindow?.resets_at ?? rateWindow?.reset_at);
  return Number.isFinite(resetAt) && resetAt * 1000 <= nowMs;
}

function badgeForWindow(rateWindow, target, nowMs) {
  if (!rateWindow || rateWindow.scope) return null;
  if (Number(rateWindow.window_minutes) !== target.minutes) return null;

  const rawUsedPercent = Number(rateWindow.used_percent ?? rateWindow.usedPercent);
  if (!Number.isFinite(rawUsedPercent)) return null;

  const usedPercent = resetHasPassed(rateWindow, nowMs)
    ? 0
    : clampPercent(rawUsedPercent);
  const remainingPercent = Math.round(100 - usedPercent);
  return {
    key: target.key,
    remainingPercent,
    ariaLabel: `${target.accessibleName} ${remainingPercent}% 남음`,
  };
}

function buildActivityUsageBadges(usage, nowMs = Date.now()) {
  const rateLimits = usage?.rateLimits;
  if (!rateLimits || typeof rateLimits !== "object") return [];

  const windows = Array.isArray(rateLimits.windows)
    ? rateLimits.windows
    : [rateLimits.primary, rateLimits.secondary].filter(Boolean);

  return TARGET_WINDOWS.flatMap((target) => {
    for (const rateWindow of windows) {
      const badge = badgeForWindow(rateWindow, target, nowMs);
      if (badge) return [badge];
    }
    return [];
  });
}

function decorateActivityBubbleWithUsage(
  data,
  usageBadges,
  { codexWorking = false } = {}
) {
  if (
    !data ||
    !codexWorking ||
    !Array.isArray(data.sections) ||
    data.sections.length < 2 ||
    !Array.isArray(usageBadges) ||
    usageBadges.length === 0
  ) {
    return data;
  }
  return { ...data, usageBadges: usageBadges.map((badge) => ({ ...badge })) };
}

module.exports = {
  buildActivityUsageBadges,
  decorateActivityBubbleWithUsage,
};
```

- [ ] **Step 4: GREEN 확인**

Run: `node --test test/activity-usage.test.js`

Expected: 3 tests, 3 pass, 0 fail.

- [ ] **Step 5: Commit checkpoint**

Run only after explicit user authorization:

```bash
git add src/activity-usage.js test/activity-usage.test.js
git commit -m "feat(activity): 5h·7d 잔여율 계산 추가"
```

---

### Task 2: watcher 사용량을 활성 집계 헤더에 연결

**Files:**
- Modify: `src/main.js:20-55, 480-500, 2323-2325, 2559-2565`
- Modify: `test/settings-ui.test.js`
- Test: `test/activity-usage.test.js`

**Interfaces:**
- Consumes: `buildActivityUsageBadges(usage)`, `decorateActivityBubbleWithUsage(data, badges, { codexWorking })` from Task 1
- Consumes: `codexWatcher.on("usage-updated", handler)`, `codexWatcher.working`
- Produces: active multi-section bubble data with root `usageBadges`

- [ ] **Step 1: main 연결 실패 테스트 작성**

Append to `test/settings-ui.test.js`:

```js
test("Codex 실시간 사용량을 다중 활동 헤더 데이터에 연결한다", () => {
  const buildActiveBubble = mainJs.match(
    /function buildActiveActivityBubble\(\)[\s\S]*?\n}/
  )?.[0] || "";
  const codexRegistration = mainJs.match(
    /function registerCodexWatcher\(\)[\s\S]*?\n}\n\n\/\/ 한도 사용률/
  )?.[0] || "";

  assert.match(mainJs, /require\("\.\/activity-usage"\)/);
  assert.match(mainJs, /let latestActivityUsageBadges = \[\]/);
  assert.match(buildActiveBubble, /decorateActivityBubbleWithUsage/);
  assert.match(buildActiveBubble, /codexWorking: codexWatcher\.working/);
  assert.match(codexRegistration, /codexWatcher\.on\("usage-updated"/);
  assert.match(codexRegistration, /buildActivityUsageBadges\(usage\)/);
  assert.match(codexRegistration, /showActiveActivityBubble\(\)/);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test --test-name-pattern='Codex 실시간 사용량' test/settings-ui.test.js`

Expected: FAIL because `main.js` does not import `activity-usage` or register `usage-updated`.

- [ ] **Step 3: main process 최소 연결 구현**

Add near the other activity imports in `src/main.js`:

```js
const {
  buildActivityUsageBadges,
  decorateActivityBubbleWithUsage,
} = require("./activity-usage");
```

Add next to `activeActivityBubbles`:

```js
let latestActivityUsageBadges = [];
```

Replace `buildActiveActivityBubble()` with:

```js
function buildActiveActivityBubble() {
  return decorateActivityBubbleWithUsage(
    activeActivityBubbles.toBubbleData(),
    latestActivityUsageBadges,
    { codexWorking: codexWatcher.working }
  );
}
```

Add at the start of `registerCodexWatcher()`:

```js
codexWatcher.on("usage-updated", (usage) => {
  latestActivityUsageBadges = buildActivityUsageBadges(usage);
  if (codexWatcher.working && activeActivityBubbles.size > 1) {
    showActiveActivityBubble();
  }
});
```

The existing comment that says `usage-updated` is not used for warning remains valid: this listener updates the passive header only and must not call `maybeWarnUsage()`.

- [ ] **Step 4: GREEN 확인**

Run: `node --test test/activity-usage.test.js test/settings-ui.test.js`

Expected: all tests pass, 0 fail.

- [ ] **Step 5: Commit checkpoint**

Run only after explicit user authorization:

```bash
git add src/main.js test/settings-ui.test.js
git commit -m "feat(activity): 실시간 사용량 헤더 연결"
```

---

### Task 3: 오른쪽 고정 사용량 배지 렌더링

**Files:**
- Modify: `src/bubble.js:53-86, 189-200`
- Modify: `src/bubble.css:73-135`
- Modify: `test/settings-ui.test.js`

**Interfaces:**
- Consumes: root `usageBadges: Array<{ key, remainingPercent, ariaLabel }>` from Task 2
- Produces: `.activity-usage-badges` container and `.activity-usage-badge` children in aggregate title only

- [ ] **Step 1: DOM·CSS 실패 테스트 작성**

Append to `test/settings-ui.test.js`:

```js
test("다중 활동 헤더 오른쪽에 유효한 5h·7d 배지만 고정 렌더링한다", () => {
  const multiBubble = renderBubble({
    kind: "activity",
    title: "총 3개 작업 중",
    usageBadges: [
      { key: "5h", remainingPercent: 42, ariaLabel: "5시간 42% 남음" },
      { key: "7d", remainingPercent: 68, ariaLabel: "7일 68% 남음" },
    ],
    sections: [{ title: "A", text: "" }, { title: "B", text: "" }],
  });
  const header = multiBubble.children[0];
  const group = childWithClass(header, "activity-usage-badges");

  assert.ok(group);
  assert.deepEqual(group.children.map((badge) => badge.textContent), ["5h 42%", "7d 68%"]);
  assert.deepEqual(group.children.map((badge) => badge.attributes["aria-label"]), [
    "5시간 42% 남음",
    "7일 68% 남음",
  ]);

  const singleBubble = renderBubble({
    kind: "activity",
    title: "작업 중",
    usageBadges: [{ key: "5h", remainingPercent: 42, ariaLabel: "5시간 42% 남음" }],
    text: "",
  });
  assert.equal(childWithClass(singleBubble.children[0], "activity-usage-badges"), null);

  const invalidBubble = renderBubble({
    kind: "activity",
    title: "총 2개 작업 중",
    usageBadges: [{ key: "5h", remainingPercent: "42", ariaLabel: "잘못된 값" }],
    sections: [{ title: "A", text: "" }, { title: "B", text: "" }],
  });
  assert.equal(childWithClass(invalidBubble.children[0], "activity-usage-badges"), null);
});

test("사용량 배지는 좁은 헤더에서도 줄바꿈과 숫자 흔들림이 없다", () => {
  const groupRule = bubbleCss.match(/\.activity-usage-badges\s*\{[^}]*}/s)?.[0] || "";
  assert.match(groupRule, /display:\s*inline-flex/);
  assert.match(groupRule, /flex:\s*none/);
  assert.match(groupRule, /white-space:\s*nowrap/);
  assert.match(groupRule, /font-variant-numeric:\s*tabular-nums/);
  assert.match(groupRule, /color:\s*color-mix/);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test --test-name-pattern='사용량 배지|5h·7d 배지' test/settings-ui.test.js`

Expected: FAIL because `.activity-usage-badges` is absent.

- [ ] **Step 3: 안전한 DOM 렌더러 구현**

Add before `createTitle()` in `src/bubble.js`:

```js
function appendUsageBadges(element, badges) {
  if (!Array.isArray(badges)) return;
  const validBadges = badges.filter((badge) =>
    ["5h", "7d"].includes(badge?.key) &&
    Number.isSafeInteger(badge?.remainingPercent) &&
    badge.remainingPercent >= 0 &&
    badge.remainingPercent <= 100 &&
    typeof badge.ariaLabel === "string" &&
    badge.ariaLabel
  );
  if (validBadges.length === 0) return;

  const group = document.createElement("span");
  group.className = "activity-usage-badges";
  for (const badgeData of validBadges) {
    const badge = document.createElement("span");
    badge.className = "activity-usage-badge";
    badge.textContent = `${badgeData.key} ${badgeData.remainingPercent}%`;
    badge.setAttribute("aria-label", badgeData.ariaLabel);
    group.appendChild(badge);
  }
  element.appendChild(group);
}
```

Extend `createTitle()` options and append after `appendSubagentBadge`:

```js
function createTitle(
  titleText,
  busy,
  {
    titleLabel = null,
    statusIcon = null,
    subagentCount = 0,
    usageBadges = [],
  } = {}
) {
  const title = document.createElement("div");
  title.className = "title";
  title.setAttribute("role", "heading");
  title.setAttribute("aria-level", "2");
  if (titleLabel) title.setAttribute("aria-label", titleLabel);

  const hasStatusIcon = appendStatusHeadingContent(title, titleText, statusIcon);
  appendSubagentBadge(title, subagentCount);
  appendUsageBadges(title, usageBadges);
  if (!hasStatusIcon) {
    const dot = document.createElement("span");
    dot.className = busy ? "dot busy" : "dot";
    title.prepend(dot);
  }
  return title;
}
```

Pass badges only on the multi-section path in `renderActivity()`:

```js
bubbleElement.appendChild(createTitle(data.title, true, {
  usageBadges: data.usageBadges,
}));
```

- [ ] **Step 4: 고정 배지 CSS 구현**

Add after `.subagent-badge` rules in `src/bubble.css`:

```css
.activity-usage-badges {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  color: color-mix(in srgb, var(--bubble-ink) 68%, transparent);
  font-size: 10px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
  text-transform: none;
  white-space: nowrap;
}

.activity-usage-badge {
  white-space: nowrap;
}
```

- [ ] **Step 5: GREEN 확인**

Run: `node --test test/activity-usage.test.js test/settings-ui.test.js`

Expected: all focused tests pass, 0 fail.

- [ ] **Step 6: Commit checkpoint**

Run only after explicit user authorization:

```bash
git add src/bubble.js src/bubble.css test/settings-ui.test.js
git commit -m "feat(activity): 5h·7d 사용량 배지 표시"
```

---

### Task 4: 전체 검증·패키징·일반 앱 교체

**Files:**
- Verify: all `src/**`, `test/**`
- Build output: `artifacts/mac-arm64/CodePet.app`

**Interfaces:**
- Consumes: Tasks 1-3 complete implementation
- Produces: tested packaged app containing `activity-usage.js`, main wiring, renderer and CSS

- [ ] **Step 1: 변경 범위와 whitespace 확인**

Run:

```bash
git status -sb
git diff --check
git diff --stat
```

Expected: only the approved plan/feature files are modified; `git diff --check` exits 0.

- [ ] **Step 2: 전체 회귀 테스트**

Run: `npm test`

Expected: all tests pass, 0 fail.

- [ ] **Step 3: macOS 일반 앱 패키징**

Stop only the currently running packaged CodePet process after resolving its exact PID, then run:

```bash
npm run dist -- --mac
```

Expected: electron-builder exits 0 and writes `artifacts/mac-arm64/CodePet.app`.

- [ ] **Step 4: 패키지 내용 확인**

Run a read-only `@electron/asar` check that verifies these markers in `app.asar`:

```js
const asar = require("@electron/asar");
const archive = "artifacts/mac-arm64/CodePet.app/Contents/Resources/app.asar";
const main = asar.extractFile(archive, "src/main.js").toString();
const bubble = asar.extractFile(archive, "src/bubble.js").toString();
const usage = asar.extractFile(archive, "src/activity-usage.js").toString();
if (!main.includes('codexWatcher.on("usage-updated"')) throw new Error("main wiring missing");
if (!bubble.includes("activity-usage-badges")) throw new Error("renderer missing");
if (!usage.includes("buildActivityUsageBadges")) throw new Error("normalizer missing");
```

Expected: exits 0 with all three markers present.

- [ ] **Step 5: 일반 앱 실행 확인**

Run:

```bash
open -n /Users/seuput/Desktop/GitHub/CodePet/artifacts/mac-arm64/CodePet.app
```

Then verify the exact `CodePet.app/Contents/MacOS/CodePet` process remains alive. Do not use development-mode `electron .`.

- [ ] **Step 6: Final commit checkpoint**

Do not commit or push unless the user explicitly requests it. If authorized after all checks:

```bash
git add docs/superpowers/plans/2026-07-18-activity-usage-header.md \
  src/activity-usage.js src/main.js src/bubble.js src/bubble.css \
  test/activity-usage.test.js test/settings-ui.test.js
git commit -m "feat(activity): 작업 헤더에 5h·7d 잔여율 표시"
git push fork main
```
