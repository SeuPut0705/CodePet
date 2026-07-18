# Activity Status Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 활동 상태를 직관적인 CodePet 전용 SVG 아이콘과 의미 색상으로 표시한다.

**Architecture:** 이미지 생성 결과는 스타일 참고 자료로만 보관한다. 상태 판정은 `activity-title.js`가 안정적인 아이콘 ID를 반환하고, 새 `activity-icons.js`가 허용된 ID만 DOM SVG로 렌더링한다. `bubble.css`는 상태 색상과 진행 애니메이션을 담당한다.

**Tech Stack:** Electron renderer, CommonJS, DOM SVG API, CSS, Node.js test runner

## Global Constraints

- 모든 아이콘은 16x16 좌표계와 1.75px 선 굵기를 사용한다.
- 둥근 선 끝과 모서리를 사용한다.
- 외부 아이콘 라이브러리 의존성을 추가하지 않는다.
- 생성된 래스터 이미지를 런타임 자산으로 포함하지 않는다.
- 기존 한국어 접근성 이름과 provider, 모델, 추론 강도를 보존한다.
- `prefers-reduced-motion`에서는 상태 애니메이션을 끈다.

---

### Task 1: 아이콘 스타일 참고 시트

**Files:**
- Create: `docs/superpowers/assets/activity-status-icons-reference.png`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-07-18-activity-status-icons-design.md`
- Produces: SVG 실루엣과 색상 관계를 결정하는 비런타임 참고 이미지

- [ ] **Step 1: 이미지 생성으로 참고 시트 제작**

다음 프롬프트로 하나의 정사각형 스타일 시트를 생성한다.

```text
Use case: ui-mockup
Asset type: CodePet desktop activity status icon style reference sheet
Primary request: Design twelve highly legible, friendly premium outline icons for work in progress, reviewing request, writing response, editing file, inspecting document, generating image, testing, building, running terminal command, waiting for approval, completed, and failed.
Style/medium: polished vector-like outline UI icon concept sheet, rounded line caps and corners, consistent 1.75px-equivalent stroke, restrained macOS-quality visual language, friendly but professional
Composition/framing: 4 by 3 grid, each icon centered in an equal cell with generous spacing, no labels
Color palette: teal active, blue information, violet image, cyan testing, amber waiting, green success, red failure, dark neutral terminal
Constraints: each silhouette must remain distinct and readable at 16px; consistent optical size; plain light background; no gradients; no shadows; no text; no logos; no watermark
Avoid: emoji, filled pictograms, 3D, photorealism, decorative complexity, thin hairlines
```

- [ ] **Step 2: 생성 결과 검수 및 프로젝트 보관**

12개 셀, 라벨 없음, 균일한 선 굵기, 서로 다른 실루엣을 확인한다. 선택 이미지를 `docs/superpowers/assets/activity-status-icons-reference.png`에 보관한다.

- [ ] **Step 3: 참고 이미지 커밋**

```bash
git add docs/superpowers/assets/activity-status-icons-reference.png
git commit -m "docs(activity): 상태 아이콘 시안 추가"
```

### Task 2: 상태별 아이콘 ID 계약

**Files:**
- Modify: `src/activity-title.js`
- Modify: `test/codex-watcher.test.js`

**Interfaces:**
- Consumes: 원본 한국어 활동 제목과 `{ workerLabel, reasoningLabel }`
- Produces: `createActivityHeading(title, context)`의 `{ statusIcon, title, titleLabel }`, 여기서 `statusIcon`은 `working|review|writing|edit|inspect|image|test|build|terminal|waiting|success|error|null`

- [ ] **Step 1: 실패하는 아이콘 ID 매핑 테스트 작성**

```js
const expected = [
  ["작업 중", "working"],
  ["요청 확인 중", "review"],
  ["응답 작성 중", "writing"],
  ["파일 수정 중", "edit"],
  ["자료 확인 중", "inspect"],
  ["이미지 생성 중", "image"],
  ["테스트 중", "test"],
  ["빌드 중", "build"],
  ["명령 실행 중", "terminal"],
  ["승인 대기", "waiting"],
  ["완료", "success"],
  ["실패", "error"],
];
for (const [title, statusIcon] of expected) {
  assert.equal(createActivityHeading(title).statusIcon, statusIcon);
}
```

- [ ] **Step 2: RED 확인**

Run: `node --test test/codex-watcher.test.js`

Expected: 기존 유니코드 기호가 반환되어 새 ID 기대값과 불일치한다.

- [ ] **Step 3: 최소 매핑 구현**

`STATUS_ICON_RULES`의 반환값을 순서대로 `error`, `success`, `waiting`, `writing`, `edit`, `inspect`, `review`, `image`, `test`, `build`, `terminal`, `working`으로 교체한다. provider, 모델, 추론 강도 조합 코드는 변경하지 않는다.

- [ ] **Step 4: GREEN 확인**

Run: `node --test test/codex-watcher.test.js test/activity-bubble-state.test.js`

Expected: 두 파일의 테스트가 모두 통과한다.

- [ ] **Step 5: 계약 변경 커밋**

```bash
git add src/activity-title.js test/codex-watcher.test.js test/activity-bubble-state.test.js
git commit -m "refactor(activity): 상태 아이콘 ID 정규화"
```

### Task 3: 안전한 SVG 렌더러와 상태 스타일

**Files:**
- Create: `src/activity-icons.js`
- Modify: `src/bubble.html`
- Modify: `src/bubble.js`
- Modify: `src/bubble.css`
- Modify: `test/settings-ui.test.js`

**Interfaces:**
- Consumes: `window.activityIcons.createActivityIcon(document, iconId)`의 `Document`와 허용 아이콘 ID
- Produces: 허용된 ID면 `SVGElement`, 아니면 `null`

- [ ] **Step 1: 실패하는 SVG·보안·접근성 테스트 작성**

`test/settings-ui.test.js` 상단에 `const activityIconsJs = source("src/activity-icons.js");`와 `const bubbleHtml = source("src/bubble.html");`를 추가하고 다음 계약을 검사한다.

```js
assert.match(activityIconsJs, /const ICON_PATHS = Object\.freeze/);
assert.match(activityIconsJs, /createElementNS\(SVG_NS, "svg"\)/);
assert.match(activityIconsJs, /svg\.setAttribute\("viewBox", "0 0 16 16"\)/);
assert.match(activityIconsJs, /svg\.setAttribute\("aria-hidden", "true"\)/);
assert.match(activityIconsJs, /if \(!paths\) return null/);
assert.match(activityIconsJs, /window\.activityIcons = Object\.freeze/);
assert.match(bubbleHtml, /activity-icons\.js[\s\S]*bubble\.js/);
assert.match(bubbleJs, /window\.activityIcons\.createActivityIcon\(document, statusIcon\)/);
assert.match(bubbleCss, /prefers-reduced-motion: reduce/);
```

- [ ] **Step 2: RED 확인**

Run: `node --test test/settings-ui.test.js`

Expected: `src/activity-icons.js`가 없거나 SVG 렌더링 계약이 없어 실패한다.

- [ ] **Step 3: SVG 허용 목록 구현**

`src/activity-icons.js`에 12개 ID별 SVG 경로/선/원 정의를 고정 데이터로 선언한다. 모든 요소는 `document.createElementNS`로 만들며 `innerHTML`을 사용하지 않는다. 루트 SVG에는 `viewBox="0 0 16 16"`, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.75"`, `stroke-linecap="round"`, `stroke-linejoin="round"`, `aria-hidden="true"`, `focusable="false"`를 지정한다. 허용 목록에 없는 ID는 `null`을 반환한다. renderer 전역에는 `window.activityIcons = Object.freeze({ createActivityIcon })`만 노출한다.

- [ ] **Step 4: renderer 연결**

`bubble.html`에서 `activity-icons.js`를 `bubble.js`보다 먼저 불러온다. `appendStatusHeadingContent`는 텍스트 span 대신 `window.activityIcons.createActivityIcon(document, statusIcon)` 반환값을 추가한다. SVG가 없으면 기존 busy dot으로 안전하게 대체한다.

- [ ] **Step 5: 상태 색상과 움직임 구현**

`.status-icon`에 `width: 15px`, `height: 15px`, `color: var(--status-color)`를 적용한다. `data-status`별 의미 색상 변수를 지정하고 `working`, `writing`, `image`만 절제된 회전 또는 펄스 애니메이션을 사용한다. `@media (prefers-reduced-motion: reduce)`에서 모든 `.status-icon` 애니메이션을 `none`으로 만든다.

- [ ] **Step 6: GREEN 확인**

Run: `node --test test/settings-ui.test.js test/codex-watcher.test.js test/activity-bubble-state.test.js`

Expected: 관련 테스트가 모두 통과한다.

- [ ] **Step 7: renderer 커밋**

```bash
git add src/activity-icons.js src/bubble.html src/bubble.js src/bubble.css test/settings-ui.test.js
git commit -m "feat(activity): 직관적인 SVG 상태 아이콘 적용"
```

### Task 4: 전체 검증과 일반 앱 확인

**Files:**
- Verify only

**Interfaces:**
- Consumes: Task 1~3 결과
- Produces: 테스트·패키지·일반 실행 증거

- [ ] **Step 1: 전체 테스트와 diff 검증**

Run: `git diff --check && npm test`

Expected: whitespace 오류 없음, 전체 테스트 실패 0건.

- [ ] **Step 2: 패키지 빌드**

Run: `npm run dist -- --mac`

Expected: exit code 0. Developer ID가 없는 환경의 서명 생략 경고는 허용한다.

- [ ] **Step 3: 일반 앱 실행**

Run: `open -n /Users/seuput/Desktop/GitHub/CodePet/artifacts/mac-arm64/CodePet.app`

Expected: 패키지 앱 프로세스가 실행되고 개발용 Electron 프로세스가 사용되지 않는다.

- [ ] **Step 4: 시각 확인**

단일·다중 활동 제목에서 SVG가 15px 크기로 잘리지 않고 제목과 정렬되는지, 완료·실패·대기 색상이 구분되는지, 사용자 지정 글꼴이 아이콘 형태를 바꾸지 않는지 확인한다.

- [ ] **Step 5: 원격 반영**

Run: `git push fork fix/macos-autostart`

Expected: 로컬 HEAD와 `fork/fix/macos-autostart` SHA가 일치한다. PR은 만들지 않는다.
