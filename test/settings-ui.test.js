const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const activityIcons = require("../src/activity-icons");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const settingsHtml = source("src/settings.html");
const settingsJs = source("src/settings.js");
const settingsCss = source("src/settings.css");
const bubbleCss = source("src/bubble.css");
const bubbleJs = source("src/bubble.js");
const bubbleHtml = source("src/bubble.html");
const mainJs = source("src/main.js");

class FakeRendererElement {
  constructor(tagName, namespace = null) {
    this.tagName = tagName;
    this.namespace = namespace;
    this.attributes = {};
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.style = {
      setProperty() {},
      removeProperty() {},
    };
    this.offsetHeight = 100;
    this.classList = {
      add: (...tokens) => this.updateClassList(tokens, true),
      toggle: (token, force) => this.updateClassList([token], Boolean(force)),
    };
  }

  updateClassList(tokens, enabled) {
    const classes = new Set(this.className.split(/\s+/).filter(Boolean));
    for (const token of tokens) {
      if (enabled) classes.add(token);
      else classes.delete(token);
    }
    this.className = [...classes].join(" ");
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    this.children.push(...children);
  }

  prepend(child) {
    this.children.unshift(child);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  addEventListener() {}
}

function renderBubble(data) {
  const bubble = new FakeRendererElement("div");
  const root = new FakeRendererElement("div");
  const documentRef = {
    documentElement: new FakeRendererElement("html"),
    querySelector(selector) {
      if (selector === "#bubble") return bubble;
      if (selector === "#root") return root;
      return null;
    },
    createElement(tagName) {
      return new FakeRendererElement(tagName);
    },
    createElementNS(namespace, tagName) {
      return new FakeRendererElement(tagName, namespace);
    },
    createTextNode(textContent) {
      return { nodeType: 3, textContent };
    },
  };
  let updateHandler = null;
  const windowRef = {
    activityIcons,
    bubbleApi: {
      onAppearance() {},
      onUpdate(handler) {
        updateHandler = handler;
      },
      reportHeight() {},
      sendAction() {},
      dismiss() {},
    },
  };

  vm.runInNewContext(bubbleJs, { document: documentRef, window: windowRef });
  updateHandler(data);
  return bubble;
}

function childWithClass(element, className) {
  return element.children.find((child) => child.className === className) || null;
}

function descendantWithClass(element, className) {
  for (const child of element.children || []) {
    if (child.className === className) return child;
    const descendant = descendantWithClass(child, className);
    if (descendant) return descendant;
  }
  return null;
}

test("외부 provider 완료 메시지도 공통 말풍선 정리와 길이 제한을 거친다", () => {
  assert.match(mainJs, /text: truncateForBubble\(result\.message\)/);
});

test("활동 아이콘은 SVG 모듈과 접근성 제목으로 렌더링한다", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "..", "src", "activity-icons.js")), true);
  assert.match(bubbleHtml, /activity-icons\.js[\s\S]*bubble\.js/);
  assert.match(bubbleJs, /window\.activityIcons\.createActivityIcon\(document, statusIcon\)/);
  assert.match(bubbleJs, /setAttribute\("role", "heading"\)/);
  assert.match(bubbleJs, /setAttribute\("aria-label", titleLabel\)/);
  assert.match(bubbleCss, /\.status-icon\s*\{/);
  assert.match(bubbleCss, /prefers-reduced-motion:\s*reduce/);
});

test("양의 안전한 정수인 서브에이전트 수만 제목 옆 DOM 배지로 렌더링한다", () => {
  const badgeRenderer = bubbleJs.match(
    /function appendSubagentBadge\(element, count\)[\s\S]*?\n}/
  )?.[0] || "";

  assert.match(badgeRenderer, /Number\.isSafeInteger\(count\)/);
  assert.match(badgeRenderer, /count <= 0/);
  assert.match(badgeRenderer, /document\.createElement\("span"\)/);
  assert.match(badgeRenderer, /badge\.className = "subagent-badge"/);
  assert.match(badgeRenderer, /createActivityIcon\(document, "agents"\)/);
  assert.match(badgeRenderer, /value\.className = "subagent-count"/);
  assert.match(badgeRenderer, /value\.textContent = `×\$\{count\}`/);
  assert.doesNotMatch(bubbleJs, /\.innerHTML\s*=/);

  assert.match(bubbleJs, /appendSubagentBadge\(title, subagentCount\)/);
  assert.match(bubbleJs, /subagentCount:\s*data\.subagentCount/);
  assert.match(bubbleJs, /appendSubagentBadge\(label, sectionData\.subagentCount\)/);
});

test("단일·다중 활동 제목을 축소 가능한 span으로 감싸고 배지를 끝에 고정한다", () => {
  const singleBubble = renderBubble({
    kind: "activity",
    title: "아주 긴 단일 작업 제목",
    titleLabel: "접근성 단일 제목",
    statusIcon: "working",
    subagentCount: 2,
    text: "",
  });
  const singleTitle = singleBubble.children[0];

  assert.equal(singleTitle.attributes["aria-label"], "접근성 단일 제목");
  assert.deepEqual(
    singleTitle.children.map((child) => child.className),
    ["status-icon", "activity-title-text", "subagent-badge"]
  );
  assert.equal(singleTitle.children[1].textContent, "아주 긴 단일 작업 제목");
  assert.equal(childWithClass(singleTitle.children[2], "subagent-count").textContent, "×2");

  const multiBubble = renderBubble({
    kind: "activity",
    title: "활동",
    sections: [{
      title: "아주 긴 다중 작업 제목",
      titleLabel: "접근성 다중 제목",
      statusIcon: "review",
      subagentCount: 3,
      text: "",
    }],
  });
  const sectionLabel = multiBubble.children[1].children[0].children[0];

  assert.equal(sectionLabel.attributes["aria-label"], "접근성 다중 제목");
  assert.deepEqual(
    sectionLabel.children.map((child) => child.className),
    ["status-icon", "activity-title-text", "subagent-badge"]
  );
  assert.equal(sectionLabel.children[1].textContent, "아주 긴 다중 작업 제목");
  assert.equal(childWithClass(sectionLabel.children[2], "subagent-count").textContent, "×3");
});

test("0 또는 잘못된 서브에이전트 수는 실제 제목 DOM에 배지를 만들지 않는다", () => {
  for (const subagentCount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
    const bubble = renderBubble({
      kind: "activity",
      title: "작업 제목",
      statusIcon: "working",
      subagentCount,
      text: "",
    });
    const title = bubble.children[0];

    assert.equal(childWithClass(title, "subagent-badge"), null);
  }
});

test("서브에이전트 배지는 좁은 말풍선용 고정 크기이며 애니메이션하지 않는다", () => {
  const badgeRule = bubbleCss.match(/\.subagent-badge\s*\{[^}]*}/s)?.[0] || "";
  const iconRule = bubbleCss.match(/\.subagent-badge \.status-icon\s*\{[^}]*}/s)?.[0] || "";
  const titleTextRule = bubbleCss.match(/\.activity-title-text\s*\{[^}]*}/s)?.[0] || "";

  assert.match(badgeRule, /display:\s*inline-flex/);
  assert.match(badgeRule, /flex:\s*none/);
  assert.match(badgeRule, /font-size:\s*10px/);
  assert.match(badgeRule, /font-variant-numeric:\s*tabular-nums/);
  assert.match(iconRule, /width:\s*13px/);
  assert.match(iconRule, /height:\s*13px/);
  assert.match(iconRule, /animation:\s*none/);
  assert.match(titleTextRule, /flex:\s*1/);
  assert.match(titleTextRule, /min-width:\s*0/);
  assert.match(titleTextRule, /overflow:\s*hidden/);
  assert.match(titleTextRule, /text-overflow:\s*ellipsis/);
  assert.match(titleTextRule, /white-space:\s*nowrap/);
});

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
  assert.deepEqual(
    group.children.map((badge) => badge.className),
    ["activity-usage-badge", "activity-usage-badge"]
  );
  assert.deepEqual(group.children.map((badge) => badge.textContent), ["5h 42%", "7d 68%"]);
  assert.deepEqual(group.children.map((badge) => badge.attributes["aria-label"]), [
    "5시간 42% 남음",
    "7일 68% 남음",
  ]);
  for (const section of multiBubble.children.slice(1)) {
    assert.equal(descendantWithClass(section, "activity-usage-badges"), null);
    assert.equal(descendantWithClass(section, "activity-usage-badge"), null);
  }

  const oneSectionBubble = renderBubble({
    kind: "activity",
    title: "총 1개 작업 중",
    usageBadges: [{ key: "5h", remainingPercent: 42, ariaLabel: "5시간 42% 남음" }],
    sections: [{ title: "A", text: "" }],
  });
  assert.equal(childWithClass(oneSectionBubble.children[0], "activity-usage-badges"), null);

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
  assert.match(groupRule, /margin-left:\s*auto/);
  assert.match(groupRule, /white-space:\s*nowrap/);
  assert.match(groupRule, /font-variant-numeric:\s*tabular-nums/);
  assert.match(groupRule, /color:\s*color-mix/);
});

test("Codex 활동은 사이드바 작업 제목을 비동기로 보강한다", () => {
  const resolverSetup = mainJs.match(/const codexThreadTitles = new CodexThreadTitleResolver\([\s\S]*?\n}\);/)?.[0] || "";
  const contextTitle = mainJs.match(/function contextWithCodexThreadTitle[\s\S]*?\n}/)?.[0] || "";
  const hydrateTitle = mainJs.match(/function hydrateCodexThreadTitle[\s\S]*?\n}/)?.[0] || "";
  assert.match(mainJs, /new CodexThreadTitleResolver/);
  assert.match(mainJs, /resolve\(threadId\)/);
  assert.match(mainJs, /sectionLabel/);
  assert.match(mainJs, /activeActivityBubbles\.refresh\(threadId/);
  assert.doesNotMatch(resolverSetup, /resolveCommand\(/);
  assert.doesNotMatch(hydrateTitle, /if \(!sectionLabel\) return/);
  assert.match(contextTitle, /context\.clientKind !== "desktop"/);
  assert.match(hydrateTitle, /context\.clientKind !== "desktop"/);
  assert.match(hydrateTitle, /codexThreadTitles\.resolve\(threadId\)/);
  assert.match(hydrateTitle, /activeActivityBubbles\.matchesContext\(threadId, expectedContext\)/);
  assert.match(mainJs, /hydrateCodexThreadTitle\(threadId, context\)/);
});

test("늦게 끝난 Desktop 제목 조회는 같은 thread의 CLI section을 덮어쓰지 않는다", async () => {
  const threadId = "019f4a30-b0a7-73f1-8080-2ba11b4e5d25";
  const hydrateSource = mainJs.match(/function hydrateCodexThreadTitle[\s\S]*?\n}/)?.[0] || "";
  let resolveTitle;
  let resolveCount = 0;
  let activeContext = { provider: "codex", clientKind: "desktop" };
  const refreshed = [];
  const titlePromise = new Promise((resolve) => {
    resolveTitle = resolve;
  });
  const hydrate = vm.runInNewContext(`(${hydrateSource})`, {
    CODEX_THREAD_ID_PATTERN: /^[0-9a-f-]{36}$/,
    codexThreadTitles: {
      resolve: () => {
        resolveCount += 1;
        return titlePromise;
      },
    },
    activeActivityBubbles: {
      matchesContext: (_threadId, context) =>
        activeContext.provider === context.provider &&
        activeContext.clientKind === context.clientKind,
      refresh: (resolvedThreadId, context) => {
        refreshed.push({ threadId: resolvedThreadId, context });
        return true;
      },
    },
    showActiveActivityBubble() {},
  });

  hydrate(threadId, { provider: "codex", clientKind: "cli", sectionLabel: "codepet" });
  assert.equal(resolveCount, 0);
  assert.deepEqual(refreshed, []);

  hydrate(threadId, { provider: "codex", clientKind: "desktop" });
  assert.equal(resolveCount, 1);
  activeContext = { provider: "codex", clientKind: "cli" };
  resolveTitle("Desktop 자동 제목");
  await titlePromise;
  await Promise.resolve();
  assert.deepEqual(refreshed, []);

  activeContext = { provider: "codex", clientKind: "desktop" };
  hydrate(threadId, activeContext);
  await Promise.resolve();
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].threadId, threadId);
  assert.equal(refreshed[0].context.sectionLabel, "Desktop 자동 제목");
});

test("Codex watcher만 작업별 서브에이전트 수 변경을 활성 section에 전달한다", () => {
  const codexRegistration = mainJs.match(/function registerCodexWatcher\(\)[\s\S]*?\n}\n\nfunction registerExternalWatcher/)?.[0] || "";
  const externalRegistration = mainJs.match(/function registerExternalWatcher[\s\S]*?\n}\n\nfunction registerIpcHandlers/)?.[0] || "";

  assert.match(
    codexRegistration,
    /codexWatcher\.on\("subagent-count-changed", \(\{ threadId, subagentCount }\) => \{[\s\S]*?activeActivityBubbles\.refresh\(threadId, \{ subagentCount }\)[\s\S]*?showActiveActivityBubble\(\)/
  );
  assert.doesNotMatch(externalRegistration, /subagent-count-changed/);
});

test("Codex 세션별 usage controller를 watcher와 활성 집계 헤더 수명주기에 연결한다", () => {
  const buildActiveBubble = mainJs.match(
    /function buildActiveActivityBubble\(\)[\s\S]*?\n}/
  )?.[0] || "";
  const removeActiveBubble = mainJs.match(
    /function removeCodexActivityBubble\(threadId\)[\s\S]*?\n}/
  )?.[0] || "";
  const codexRegistration = mainJs.match(
    /function registerCodexWatcher\(\)[\s\S]*?\n}\n\n\/\/ 한도 사용률/
  )?.[0] || "";
  const controllerSetup = mainJs.match(
    /const activityUsageController = new ActivityUsageController\([\s\S]*?\n}\);/
  )?.[0] || "";

  assert.match(mainJs, /require\("\.\/activity-usage"\)/);
  assert.match(controllerSetup, /onBadgesChanged/);
  assert.match(
    controllerSetup,
    /codexWatcher\.working && activeActivityBubbles\.size > 1[\s\S]*?showActiveActivityBubble\(\)/
  );
  assert.doesNotMatch(mainJs, /activityUsageResetTimer|scheduleActivityUsageReset/);
  assert.match(buildActiveBubble, /decorateActivityBubbleWithUsage/);
  assert.match(buildActiveBubble, /activityUsageController\.buildBadges\(\)/);
  assert.match(buildActiveBubble, /codexWorking: codexWatcher\.working/);
  assert.match(removeActiveBubble, /activityUsageController\.remove\(threadId\)/);
  assert.match(
    removeActiveBubble,
    /if \(!codexWatcher\.working\) activityUsageController\.clear\(\)/
  );
  assert.match(codexRegistration, /codexWatcher\.on\("usage-updated", \(usage, context\)/);
  assert.match(codexRegistration, /if \(!context\?\.threadId\) return/);
  assert.match(
    codexRegistration,
    /activityUsageController\.update\(context\.threadId, usage\)/
  );
  assert.match(mainJs, /activityUsageController\.dispose\(\)/);
});
const rendererJs = source("src/renderer.js");
const petHtml = source("src/index.html");
const petCss = source("src/styles.css");

test("클릭 가능한 말풍선 hover는 사용자 지정 배경색을 덮어쓰지 않는다", () => {
  assert.match(bubbleCss, /\.bubble\s*\{[^}]*background:\s*var\(--bubble-bg\)/s);
  assert.doesNotMatch(bubbleCss, /--bubble-hover/);
  assert.doesNotMatch(bubbleCss, /\.bubble\.clickable:hover/);
  assert.doesNotMatch(bubbleCss, /\.activity-section\.clickable:hover/);
});

test("설정 창은 테마 선택 없이 색상, 설치 글꼴, 세 provider, 사용량을 제공한다", () => {
  assert.doesNotMatch(settingsHtml, /name="theme"|화면 테마|data-theme/);
  assert.doesNotMatch(settingsJs, /themeSource|resolvedTheme|prefers-color-scheme/);
  assert.doesNotMatch(settingsCss, /data-theme|theme-option|theme-preview/);
  assert.match(settingsHtml, /id="font-search"/);
  assert.match(settingsHtml, /id="font-preview"/);
  assert.match(settingsJs, /function resolveInstalledFontFamily/);
  assert.match(settingsHtml, /id="provider-groups"/);
  assert.match(settingsHtml, /id="usage-cards"/);
  assert.match(settingsCss, /--font-body:\s*"Segoe UI Variable"/);
  assert.doesNotMatch(settingsHtml, /<link[^>]+href=["']https?:/);
  assert.doesNotMatch(settingsHtml, /\.\.\/assets\//);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "assets")), false);
  assert.equal(
    fs.existsSync(path.join(__dirname, "..", "src", "default-pet", "spritesheet.webp")),
    true
  );
  assert.match(mainJs, /path\.join\(__dirname, "default-pet", "spritesheet\.webp"\)/);
});

test("설정 대시보드는 중복 페이지 헤더와 장식용 문구 없이 핵심 섹션부터 보여준다", () => {
  assert.doesNotMatch(settingsHtml, /class="workspace-bar"/);
  assert.doesNotMatch(settingsHtml, /class="panel-heading"/);
  assert.doesNotMatch(settingsHtml, /class="nav-index"/);
  assert.doesNotMatch(settingsHtml, /WORKSPACE COMPANION|VERSION 0\.3\.2/);
  assert.match(settingsHtml, /id="provider-list-title">연결된 계정/);
  assert.match(settingsHtml, /id="usage-list-title">계정별 한도/);
});

test("설정 Footer는 짧은 창에서도 본문을 덮지 않고 글꼴 목록은 각 글꼴로 표시된다", () => {
  const panelActionsRule = settingsCss.match(/\.panel-actions\s*\{[^}]*\}/)?.[0] || "";
  assert.doesNotMatch(panelActionsRule, /position:\s*sticky|bottom\s*:/);
  assert.match(settingsJs, /function createFontOption/);
  assert.match(settingsJs, /option\.style\.fontFamily\s*=\s*fontFamily/);
  assert.match(settingsJs, /filteredFonts\.map\(\(font\) => createFontOption\(font, font, font\)\)/);
});

test("말풍선 글자 색상은 작업 제목과 모델 상태까지 함께 바꾼다", () => {
  assert.doesNotMatch(bubbleJs, /dataset\.theme|resolvedTheme/);
  assert.doesNotMatch(bubbleCss, /data-theme/);
  assert.match(bubbleCss, /\.title\s*\{[^}]*color:\s*var\(--bubble-ink\)/s);
  assert.match(bubbleCss, /\.activity-row-label\s*\{[^}]*color:\s*var\(--bubble-ink\)/s);
});

test("마우스 따라가기와 수동 일시정지는 설정 파일에 저장하고 시작 시 복원한다", () => {
  assert.match(mainJs, /restoreMovementPreferences\(\)/);
  assert.match(mainJs, /writeSettings\(movementPreferencesPatch\(runtime\)\)/);
  assert.match(mainJs, /persistMovementPreferences\(\)/);
});

test("펫 크기 조절은 화면 끝에서도 쓸 수 있는 좌상단 핸들과 절대 화면 좌표를 사용한다", () => {
  const resizeHandleRule = petCss.match(/\.resize-handle\s*\{[^}]*\}/)?.[0] || "";
  assert.match(petHtml, /data-resize-corner="top-left"/);
  assert.match(petHtml, /data-resize-corner="bottom-right"/);
  assert.match(resizeHandleRule, /width:\s*36px/);
  assert.match(resizeHandleRule, /height:\s*36px/);
  assert.match(petCss, /\.resize-handle\[data-resize-corner="top-left"\]/);
  assert.match(petCss, /body\.is-resizing \.resize-handle/);
  assert.match(rendererJs, /event\.screenX/);
  assert.match(rendererJs, /event\.preventDefault\(\)/);
  assert.match(rendererJs, /document\.body\.classList\.add\("is-resizing"\)/);
  assert.match(rendererJs, /window\.addEventListener\("pointermove", handleResizePointerMove\)/);
});

test("클릭·작업 상태·정지 랜덤·마우스 둘러보기·2차원 배회를 동작 규칙대로 연결한다", () => {
  const animationPolicy = mainJs.slice(
    mainJs.indexOf("function syncMovementAnimation"),
    mainJs.indexOf("function schedulePhase")
  );
  assert.match(mainJs, /isActivityOnlyReason\(reason\)/);
  assert.match(rendererJs, /requestReaction\("jumping"\)/);
  assert.match(rendererJs, /requestReaction\("waving"\)/);
  assert.match(mainJs, /initialDragState = runtime\.direction > 0 \? "runningRight" : "runningLeft"/);
  assert.match(mainJs, /function didTaskFail\(result\)/);
  assert.match(mainJs, /playReaction\(failed \? "failed" : "jumping"\)/);
  assert.match(mainJs, /pauseAutoMovement\("codex", "running"\)/);
  assert.match(mainJs, /function chooseRandomIdleState\(\)/);
  assert.match(mainJs, /states = \["waiting", "failed"\]/);
  assert.match(mainJs, /states\.push\("lookRow10", "lookRow9"\)/);
  assert.match(mainJs, /function ensureMouseLookState\(\)/);
  assert.ok(
    animationPolicy.indexOf("runtime.followMouse") <
      animationPolicy.indexOf("getActivityPetState()")
  );
  assert.match(mainJs, /runtime\.movementPhase === "walking"/);
  assert.match(mainJs, /directionIndexFromVector\(deltaX, deltaY\)/);
  assert.match(mainJs, /createRoamingVector\(\)/);
  assert.match(mainJs, /advanceRoamingPosition\(\{/);
  assert.doesNotMatch(mainJs, /targetWorkArea/);
  assert.match(mainJs, /label: "왼쪽 둘러보기"[^\n]+lookRow10/);
  assert.match(mainJs, /label: "오른쪽 둘러보기"[^\n]+lookRow9/);
  assert.match(mainJs, /playManualReaction\("lookRow9"\)/);
  assert.match(mainJs, /playManualReaction\("lookRow10"\)/);
  assert.match(rendererJs, /scanSpriteFrameOccupancy/);
  assert.match(rendererJs, /playableFrameColumns\(rowOccupancy, expectedFrames\)/);
  assert.match(rendererJs, /nearestPlayableDirection/);
});

test("프로젝트 연결과 Codex 현재 저장·재실행 UI는 제거됐다", () => {
  assert.doesNotMatch(settingsHtml, /project-account|binding-list|save-binding|프로젝트 연결/);
  assert.doesNotMatch(settingsHtml, /현재 계정 저장|Codex Desktop 재실행/);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "src", "project-account-bindings.js")), false);
});

test("사용량 카드는 한도만 렌더링하고 계정 action을 넣지 않는다", () => {
  const usageRenderer = settingsJs.slice(
    settingsJs.indexOf("function renderUsage"),
    settingsJs.indexOf("function renderAll")
  );
  assert.match(settingsJs, /function createUsageGauge/);
  assert.match(settingsJs, /function renderUsage/);
  assert.doesNotMatch(settingsHtml, /data-account=/);
  assert.doesNotMatch(usageRenderer, /runAccountAction\(/);
});

test("사용량 화면은 provider별 모든 계정을 개별 카드로 표시한다", () => {
  assert.match(mainJs, /loadAccountUsageCards/);
  assert.match(mainJs, /usage:\s*\[\.\.\.codexUsage, \.\.\.agy\.usage, \.\.\.claude\.usage\]/);
  assert.match(settingsJs, /item\.accountLabel/);
  assert.match(settingsJs, /item\.active/);
  assert.match(settingsHtml, />계정별 한도</);
});

test("설정 renderer는 안전한 DOM API를 쓰고 성공 카드를 남기지 않는다", () => {
  assert.doesNotMatch(settingsJs, /\.innerHTML\s*=/);
  assert.match(settingsJs, /textContent/);
  assert.match(settingsHtml, /id="toast"/);
  assert.doesNotMatch(settingsHtml, /id="notice"/);
  assert.doesNotMatch(settingsJs, /완료했습니다|적용했습니다|setNotice/);
});

test("계정 설정은 비활성 프로필 삭제를 확인하고 삭제 중 상태를 표시한다", () => {
  assert.match(settingsJs, /action: "delete", profileKey: account\.key/);
  assert.match(settingsJs, /window\.confirm/);
  assert.match(settingsJs, /deleteButton\.disabled = account\.active/);
  assert.match(settingsJs, /"삭제 중…"/);
  assert.match(settingsCss, /\.danger-button/);
});

test("메뉴에서 사용량 보기와 활동 말풍선 항목을 제거하고 수동 모션을 세 번 재생한다", () => {
  assert.doesNotMatch(mainJs, /label:\s*"Codex 사용량 보기"/);
  assert.doesNotMatch(mainJs, /label:\s*"활동 말풍선"/);
  assert.match(mainJs, /label:\s*"설정…"/);
  assert.match(mainJs, /let remaining = 2/);
  assert.match(rendererJs, /window\.petApi\.showCodexStatus\(\)/);
  assert.match(mainJs, /SHOW_CODEX_STATUS[\s\S]*void showUsageBubble\(\)/);
  assert.match(mainJs, /readSettings\(\)\.codexProxyMode !== false/);
  assert.doesNotMatch(mainJs, /readSettings\(\)\.codexProxyMode === true/);
  assert.match(
    mainJs,
    /function showWatcherActivityBubble[\s\S]*pendingBubbleData && !pendingBubbleData\.activityPrivacy/
  );
});

test("macOS 개발 실행은 자동 실행을 비활성화하고 잘못 등록된 Electron 항목을 정리한다", () => {
  assert.match(mainJs, /clearUnsupportedAutoLaunch\(app, getAutoLaunchContext\(\)\)/);
  assert.match(mainJs, /autoStartSupported:\s*isAutoLaunchSupported\(\)/);
  assert.match(mainJs, /enabled:\s*isAutoLaunchSupported\(\)/);
  assert.match(settingsJs, /autostart\.disabled = state\.autoStartSupported === false/);
  assert.match(settingsHtml, /id="autostart-note"/);
});

test("펫 우클릭과 트레이 메뉴는 하나의 공통 템플릿을 사용한다", () => {
  const sharedMenu = mainJs.slice(
    mainJs.indexOf("function buildAppMenuTemplate"),
    mainJs.indexOf("function buildTrayMenu")
  );
  const trayMenu = mainJs.slice(
    mainJs.indexOf("function buildTrayMenu"),
    mainJs.indexOf("function refreshTrayMenu")
  );
  const contextMenu = mainJs.slice(
    mainJs.indexOf("function showContextMenu"),
    mainJs.indexOf("function handleDragStart")
  );

  assert.match(sharedMenu, /label:\s*"모션 실행"/);
  assert.match(sharedMenu, /label:\s*"로그인 시 자동 실행"/);
  assert.match(sharedMenu, /label:\s*"완전 종료"/);
  assert.match(trayMenu, /Menu\.buildFromTemplate\(buildAppMenuTemplate\(\)\)/);
  assert.match(contextMenu, /Menu\.buildFromTemplate\(buildAppMenuTemplate\(\)\)/);
  assert.equal((mainJs.match(/function buildAppMenuTemplate/g) || []).length, 1);
});
