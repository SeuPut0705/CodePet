# Responsive Bubble Width Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CodePet 말풍선이 콘텐츠에 맞춰 `300px`부터 확장되면서도 `520px`와 현재 화면 여백 상한을 넘지 않게 만든다.

**Architecture:** 크기 제한과 위치 계산을 순수 모듈로 분리해 Electron 없이 검증한다. Renderer는 콘텐츠의 선호 너비와 현재 높이를 `{ width, height }`로 보고하고, main process가 현재 work area를 기준으로 신뢰 경계에서 값을 제한한 뒤 실제 창 크기와 위치를 갱신한다.

**Tech Stack:** Electron 40, CommonJS, DOM/CSS, Node.js built-in test runner

## Global Constraints

- 최소 말풍선 창 너비는 `300px`다.
- 최대 말풍선 창 너비는 `min(520px, workArea.width - 24px)`다.
- 현재 work area에는 좌우 각각 최소 `12px` 여백을 남긴다.
- 일반 메시지 본문은 줄바꿈하고 활동 제목만 필요할 때 말줄임한다.
- 상태 아이콘, 서브에이전트 배지, `5h`·`7d` 사용량 배지는 줄바꿈하지 않는다.
- 기존 숫자 height resize IPC를 호환 처리한다.
- 잘못된 renderer 크기 값은 main process에서 무시하거나 안전 범위로 제한한다.
- resize는 숨겨진 말풍선을 임의로 열거나 포커스를 가져오지 않는다.
- 기존 최대 높이 `420px`, pet 위/아래 배치, 자동 숨김, 클릭, 개인정보, provider 사용량 계약을 유지한다.
- 새 런타임 의존성을 추가하지 않는다.
- 브랜치를 추가하지 않고 현재 `main`에서 작업하며 push/PR은 별도 요청 전까지 실행하지 않는다.

---

### Task 1: 반응형 창 크기와 위치 순수 계산

**Files:**
- Create: `src/bubble-window-geometry.js`
- Create: `test/bubble-window-geometry.test.js`

**Interfaces:**
- Produces: `normalizeBubbleSize(payload, options) -> { width, height }`
- Produces: `positionBubbleBounds({ petBounds, workArea, bubbleSize, gapPx }) -> { x, y, width, height }`
- `payload` accepts `{ width, height }` or a legacy numeric height.
- `options` contains `currentWidth`, `currentHeight`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, and `marginPx`.

- [ ] **Step 1: Write failing geometry tests**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeBubbleSize,
  positionBubbleBounds,
} = require("../src/bubble-window-geometry");

const limits = {
  currentWidth: 300,
  currentHeight: 80,
  minWidth: 300,
  maxWidth: 520,
  minHeight: 48,
  maxHeight: 420,
  marginPx: 12,
};

test("말풍선 크기는 300..520 범위에서 콘텐츠 보고값을 사용한다", () => {
  assert.deepEqual(
    normalizeBubbleSize({ width: 410, height: 120 }, {
      ...limits,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    { width: 410, height: 120 }
  );
  assert.deepEqual(
    normalizeBubbleSize({ width: 900, height: 900 }, {
      ...limits,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    { width: 520, height: 420 }
  );
});

test("작은 work area에서는 좌우 12px 여백 상한을 우선한다", () => {
  assert.deepEqual(
    normalizeBubbleSize({ width: 520, height: 100 }, {
      ...limits,
      workArea: { x: 40, y: 20, width: 320, height: 600 },
    }),
    { width: 296, height: 100 }
  );
});

test("legacy 숫자 height와 잘못된 width는 현재 폭을 보존한다", () => {
  assert.deepEqual(
    normalizeBubbleSize(160, {
      ...limits,
      currentWidth: 380,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    { width: 380, height: 160 }
  );
  assert.deepEqual(
    normalizeBubbleSize({ width: "bad", height: 90 }, {
      ...limits,
      currentWidth: 360,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    { width: 360, height: 90 }
  );
});

test("실제 반응형 폭으로 pet 중심과 화면 좌우 경계를 보정한다", () => {
  assert.deepEqual(
    positionBubbleBounds({
      petBounds: { x: 760, y: 500, width: 120, height: 120 },
      workArea: { x: 0, y: 0, width: 800, height: 700 },
      bubbleSize: { width: 500, height: 100 },
      gapPx: 2,
    }),
    { x: 300, y: 398, width: 500, height: 100 }
  );
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/bubble-window-geometry.test.js`

Expected: FAIL with `Cannot find module '../src/bubble-window-geometry'`.

- [ ] **Step 3: Implement the pure geometry module**

```js
function roundedFinite(value) {
  if (typeof value === "string" && !value.trim()) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeBubbleSize(payload, options) {
  const {
    workArea,
    currentWidth,
    currentHeight,
    minWidth,
    maxWidth,
    minHeight,
    maxHeight,
    marginPx,
  } = options;
  const report = typeof payload === "number" ? { height: payload } : (payload || {});
  const workWidth = Math.max(1, roundedFinite(workArea?.width) || minWidth);
  const availableWidth = Math.max(1, workWidth - marginPx * 2);
  const effectiveMaxWidth = Math.min(maxWidth, availableWidth);
  const effectiveMinWidth = Math.min(minWidth, effectiveMaxWidth);
  const reportedWidth = roundedFinite(report.width);
  const reportedHeight = roundedFinite(report.height);
  const safeCurrentWidth = clamp(
    roundedFinite(currentWidth) || effectiveMinWidth,
    effectiveMinWidth,
    effectiveMaxWidth
  );
  return {
    width: reportedWidth === null
      ? safeCurrentWidth
      : clamp(reportedWidth, effectiveMinWidth, effectiveMaxWidth),
    height: reportedHeight === null
      ? clamp(roundedFinite(currentHeight) || minHeight, minHeight, maxHeight)
      : clamp(reportedHeight, minHeight, maxHeight),
  };
}

function positionBubbleBounds({ petBounds, workArea, bubbleSize, gapPx }) {
  const maxX = workArea.x + workArea.width - bubbleSize.width;
  const centeredX = Math.round(
    petBounds.x + petBounds.width / 2 - bubbleSize.width / 2
  );
  const x = clamp(centeredX, workArea.x, maxX);
  let y = Math.round(petBounds.y - bubbleSize.height - gapPx);
  if (y < workArea.y) {
    y = Math.round(petBounds.y + petBounds.height + gapPx);
  }
  y = clamp(y, workArea.y, workArea.y + workArea.height - bubbleSize.height);
  return { x, y, width: bubbleSize.width, height: bubbleSize.height };
}

module.exports = { normalizeBubbleSize, positionBubbleBounds };
```

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/bubble-window-geometry.test.js`

Expected: 4 tests PASS, 0 failures.

Run: `npm test`

Expected: all tests PASS, 0 failures.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/bubble-window-geometry.js test/bubble-window-geometry.test.js
git commit -m "feat(bubble): 반응형 창 크기 계산 추가"
```

---

### Task 2: Renderer 콘텐츠 측정과 크기 IPC

**Files:**
- Modify: `src/bubble-preload.js`
- Modify: `src/bubble.js`
- Modify: `src/bubble.css`
- Modify: `test/settings-ui.test.js`

**Interfaces:**
- Consumes: existing `bubble:resize` IPC channel.
- Produces: `window.bubbleApi.reportSize({ width, height })`.
- Preserves: `window.bubbleApi.reportHeight(height)` as a legacy compatibility API.

- [ ] **Step 1: Write failing renderer and CSS contract tests**

Extend the fake renderer elements with `scrollWidth`, `offsetHeight`, and `classList.remove`. Capture `reportSize` calls in the VM harness, then add:

```js
test("말풍선 renderer는 콘텐츠 선호 폭과 현재 높이를 함께 보고한다", () => {
  const reports = [];
  const { bubble, root, update } = createBubbleHarness({
    reportSize: (size) => reports.push(size),
  });
  bubble.scrollWidth = 402;
  root.offsetHeight = 126;

  update({ kind: "activity", title: "CodePet · Sol · Medium", text: "작업 중" });

  assert.deepEqual(reports.at(-1), { width: 412, height: 126 });
});

test("같은 크기는 중복 보고하지 않고 window resize에서 높이를 다시 측정한다", () => {
  const reports = [];
  const harness = createBubbleHarness({ reportSize: (size) => reports.push(size) });
  harness.bubble.scrollWidth = 310;
  harness.root.offsetHeight = 100;
  harness.update({ kind: "activity", title: "짧은 작업", text: "내용" });
  harness.update({ kind: "activity", title: "짧은 작업", text: "내용" });
  assert.equal(reports.length, 1);

  harness.root.offsetHeight = 84;
  harness.fireWindowResize();
  assert.deepEqual(reports.at(-1), { width: 320, height: 84 });
});

test("본문은 줄바꿈하고 제목과 사용량 배지는 한 줄 계약을 유지한다", () => {
  const measurementRule = bubbleCss.match(/\.bubble\.measure-width\s*\{[^}]*}/s)?.[0] || "";
  const bodyRule = bubbleCss.match(/\.body-text,[\s\S]*?\}/)?.[0] || "";
  const titleRule = bubbleCss.match(/\.activity-title-text\s*\{[^}]*}/s)?.[0] || "";
  const usageRule = bubbleCss.match(/\.activity-usage-badges\s*\{[^}]*}/s)?.[0] || "";
  assert.match(measurementRule, /width:\s*max-content/);
  assert.match(measurementRule, /max-width:\s*none/);
  assert.match(bodyRule, /white-space:\s*pre-wrap/);
  assert.match(bodyRule, /word-break:\s*break-word/);
  assert.match(titleRule, /text-overflow:\s*ellipsis/);
  assert.match(usageRule, /white-space:\s*nowrap/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/settings-ui.test.js`

Expected: FAIL because `reportSize`, width measurement, and `.bubble.measure-width` do not exist.

- [ ] **Step 3: Add the safe preload API**

```js
reportSize: (size) => {
  ipcRenderer.send(BUBBLE_CHANNELS.RESIZE, size);
},
reportHeight: (height) => {
  ipcRenderer.send(BUBBLE_CHANNELS.RESIZE, height);
},
```

Do not expose `ipcRenderer` or any additional channel to the renderer.

- [ ] **Step 4: Implement deterministic renderer measurement**

Add near the renderer state:

```js
let lastReportedSize = null;

function measureBubbleSize() {
  const root = document.querySelector("#root");
  bubbleElement.classList.add("measure-width");
  const width = Math.ceil(bubbleElement.scrollWidth + 10);
  bubbleElement.classList.remove("measure-width");
  return { width, height: Math.ceil(root.offsetHeight) };
}

function reportBubbleSize() {
  const size = measureBubbleSize();
  if (
    lastReportedSize?.width === size.width &&
    lastReportedSize?.height === size.height
  ) return;
  lastReportedSize = size;
  window.bubbleApi.reportSize(size);
}
```

Replace the final `reportHeight(...)` call in `onUpdate` with synchronous `reportBubbleSize()`. Register a resize listener without `requestAnimationFrame`:

```js
window.addEventListener("resize", reportBubbleSize);
```

The synchronous path is required because a hidden Electron window may throttle `requestAnimationFrame` before the main process shows it.

- [ ] **Step 5: Add measurement CSS without changing visible design**

```css
.bubble.measure-width {
  position: absolute;
  width: max-content;
  max-width: none;
}

.body-text {
  overflow-wrap: anywhere;
}
```

Keep the existing `.activity-title-text`, `.subagent-badge`, and `.activity-usage-badges` flex/nowrap rules unchanged.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test test/settings-ui.test.js`

Expected: all settings/bubble renderer tests PASS, 0 failures.

Run: `npm test`

Expected: all tests PASS, 0 failures.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/bubble-preload.js src/bubble.js src/bubble.css test/settings-ui.test.js
git commit -m "feat(bubble): 콘텐츠 크기 보고 추가"
```

---

### Task 3: Electron main 통합과 packaged runtime 검증

**Files:**
- Modify: `src/main.js`
- Modify: `test/settings-ui.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: `normalizeBubbleSize(payload, options)` and `positionBubbleBounds(...)` from Task 1.
- Consumes: `{ width, height }` or legacy numeric height from `bubble:resize`.
- Maintains: `bubbleWidth` and `bubbleHeight` as the latest clamped window size.

- [ ] **Step 1: Write failing main-process integration tests**

Add a static lifecycle contract beside existing bubble tests:

```js
test("main은 renderer 크기를 work area에 제한하고 실제 폭으로 배치한다", () => {
  assert.match(mainJs, /normalizeBubbleSize\(/);
  assert.match(mainJs, /positionBubbleBounds\(/);
  assert.match(mainJs, /minWidth:\s*300/);
  assert.match(mainJs, /maxWidth:\s*520/);
  assert.match(mainJs, /marginPx:\s*12/);
  assert.match(mainJs, /let bubbleWidth = BUBBLE_CONFIG\.minWidth/);
  assert.doesNotMatch(mainJs, /BUBBLE_CONFIG\.width\s*\/\s*2/);
});
```

Update the README feature description test to require a responsive bubble width statement:

```js
assert.match(readme, /말풍선.*콘텐츠.*화면.*자동.*폭/s);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/bubble-window-geometry.test.js test/settings-ui.test.js`

Expected: FAIL because main still uses fixed `BUBBLE_CONFIG.width = 270` and README lacks the responsive-width statement.

- [ ] **Step 3: Replace fixed width state and positioning**

Import the geometry helpers:

```js
const {
  normalizeBubbleSize,
  positionBubbleBounds,
} = require("./bubble-window-geometry");
```

Change the config and state:

```js
const BUBBLE_CONFIG = Object.freeze({
  minWidth: 300,
  maxWidth: 520,
  marginPx: 12,
  minHeight: 48,
  maxHeight: 420,
  gapPx: 2,
  renderFallbackMs: 350,
  loadTimeoutMs: 2500,
  recreateDelayMs: 250,
  usageAutoHideMs: 12000,
  doneAutoHideMs: 8000,
  activityMaxChars: 240,
});

let bubbleWidth = BUBBLE_CONFIG.minWidth;
```

Replace `positionBubble()` calculations with:

```js
function positionBubble() {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  const bounds = positionBubbleBounds({
    petBounds: {
      x: runtime.x,
      y: runtime.y,
      width: runtime.width,
      height: runtime.height,
    },
    workArea: getCurrentWorkArea(),
    bubbleSize: { width: bubbleWidth, height: bubbleHeight },
    gapPx: BUBBLE_CONFIG.gapPx,
  });
  bubbleWindow.setBounds(bounds);
}
```

Create the BrowserWindow with `width: bubbleWidth`.

- [ ] **Step 4: Normalize resize IPC at the main-process trust boundary**

Replace the height-only handler body with:

```js
ipcMain.on(BUBBLE_CHANNELS.RESIZE, (_event, size) => {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  const normalized = normalizeBubbleSize(size, {
    workArea: getCurrentWorkArea(),
    currentWidth: bubbleWidth,
    currentHeight: bubbleHeight,
    minWidth: BUBBLE_CONFIG.minWidth,
    maxWidth: BUBBLE_CONFIG.maxWidth,
    minHeight: BUBBLE_CONFIG.minHeight,
    maxHeight: BUBBLE_CONFIG.maxHeight,
    marginPx: BUBBLE_CONFIG.marginPx,
  });
  bubbleWidth = normalized.width;
  bubbleHeight = normalized.height;
  positionBubble();
  // retain the existing watchdog clearing and active-only show logic exactly
});
```

- [ ] **Step 5: Document the user-visible behavior**

Add to README features:

```md
- 말풍선은 콘텐츠와 현재 화면 크기에 맞춰 자동으로 폭을 조절하며, 긴 메시지는 제한된 최대 폭 안에서 줄바꿈합니다.
```

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
node --test test/bubble-window-geometry.test.js test/settings-ui.test.js
npm test
node --check src/bubble-window-geometry.js
node --check src/bubble-preload.js
node --check src/bubble.js
node --check src/main.js
git diff --check
```

Expected: all tests PASS, all syntax checks exit 0, and `git diff --check` has no output.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/main.js test/settings-ui.test.js README.md
git commit -m "feat(bubble): 화면에 맞춘 반응형 폭 적용"
```

- [ ] **Step 8: Build and relaunch the normal macOS app**

Run:

```bash
npm run dist -- --mac
npx --no-install asar list artifacts/mac-arm64/CodePet.app/Contents/Resources/app.asar \
  | rg '^/src/(bubble-window-geometry|bubble-preload|bubble|main)\.js$'
```

Expected: unsigned local macOS package succeeds and all four files are present in `app.asar`.

Only after package success, terminate the exact old executable at:

```text
/Users/seuput/Desktop/GitHub/CodePet/artifacts/mac-arm64/CodePet.app/Contents/MacOS/CodePet
```

Launch `artifacts/mac-arm64/CodePet.app` and verify a different exact PID.

- [ ] **Step 9: Run Chronicle visual proof and final repository verification**

Use the Chronicle read-only workflow to confirm on the fresh packaged PID:

- a short activity bubble stays near the minimum width;
- a long message or multi-activity bubble expands beyond `300px` but not beyond `520px`;
- the bubble remains inside the current work area;
- the title truncates only when necessary;
- status, subagent, `5h`, and `7d` badges remain on one line.

Then run:

```bash
npm test
git status --short --branch
git log -5 --oneline
```

Expected: all tests PASS, tracked working tree is clean, changes remain on `main`, and no push/PR has occurred.
