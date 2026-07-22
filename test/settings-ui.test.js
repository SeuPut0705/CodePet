const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const activityIcons = require("../src/activity-icons");
const { ActivityUsageController } = require("../src/activity-usage");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const settingsHtml = source("src/settings.html");
const settingsJs = source("src/settings.js");
const settingsCss = source("src/settings.css");
const settingsPreloadJs = source("src/settings-preload.js");
const settingsI18nJs = source("src/settings-i18n.js");
const bubbleCss = source("src/bubble.css");
const bubbleJs = source("src/bubble.js");
const bubbleHtml = source("src/bubble.html");
const mainJs = source("src/main.js");

test("README는 Kimi 5h·7d 사용량과 CLI 프로젝트 제목 정책을 설명한다", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /Kimi.*5h.*7d/s);
  assert.match(readme, /CLI.*프로젝트 폴더명/s);
  assert.match(readme, /말풍선.*콘텐츠.*화면.*자동.*폭/s);
});

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
    this.offsetWidth = 0;
    this.offsetHeight = 100;
    this.classList = {
      add: (...tokens) => this.updateClassList(tokens, true),
      remove: (...tokens) => this.updateClassList(tokens, false),
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

function createBubbleHarness({ reportSize = () => {} } = {}) {
  const bubble = new FakeRendererElement("div");
  const root = new FakeRendererElement("div");
  const measurementEvents = [];
  let preferredWidth = bubble.offsetWidth;
  let currentHeight = root.offsetHeight;
  Object.defineProperty(bubble, "offsetWidth", {
    configurable: true,
    enumerable: false,
    get() {
      measurementEvents.push("width");
      assert.equal(bubble.className.split(/\s+/).includes("measure-width"), true);
      return preferredWidth;
    },
    set(value) {
      preferredWidth = value;
    },
  });
  Object.defineProperty(root, "offsetHeight", {
    configurable: true,
    enumerable: false,
    get() {
      measurementEvents.push("height");
      assert.equal(bubble.className.split(/\s+/).includes("measure-width"), false);
      return currentHeight;
    },
    set(value) {
      currentHeight = value;
    },
  });
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
  let appearanceHandler = null;
  let resizeHandler = null;
  const windowRef = {
    activityIcons,
    addEventListener(eventName, handler) {
      if (eventName === "resize") resizeHandler = handler;
    },
    bubbleApi: {
      onAppearance(handler) {
        appearanceHandler = handler;
      },
      onUpdate(handler) {
        updateHandler = handler;
      },
      reportSize(size) {
        reportSize({ width: size.width, height: size.height });
      },
      reportHeight() {},
      sendAction() {},
      dismiss() {},
    },
  };

  vm.runInNewContext(bubbleJs, { document: documentRef, window: windowRef });
  return {
    bubble,
    root,
    measurementEvents,
    update(data) {
      updateHandler(data);
    },
    updateAppearance(appearance) {
      appearanceHandler?.(appearance);
    },
    fireWindowResize() {
      resizeHandler?.();
    },
  };
}

function accessibleText(element) {
  if (!element || element.attributes?.["aria-hidden"] === "true") return "";
  if (element.attributes?.["aria-label"]) return element.attributes["aria-label"];
  return [element.textContent, ...(element.children || []).map(accessibleText)]
    .filter(Boolean)
    .join(" ");
}

function renderBubble(data) {
  const harness = createBubbleHarness();
  harness.update(data);
  return harness.bubble;
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

test("main은 renderer 크기를 work area에 제한하고 실제 폭으로 배치한다", () => {
  assert.match(mainJs, /normalizeBubbleSize\(/);
  assert.match(mainJs, /positionBubbleBounds\(/);
  assert.match(mainJs, /minWidth:\s*300/);
  assert.match(mainJs, /maxWidth:\s*440/);
  assert.match(mainJs, /marginPx:\s*12/);
  assert.match(mainJs, /let bubbleWidth = BUBBLE_CONFIG\.minWidth/);
  assert.doesNotMatch(mainJs, /BUBBLE_CONFIG\.width\s*\/\s*2/);
});

test("main은 배치와 생성 전에 저장된 말풍선 크기를 현재 work area에 다시 제한한다", () => {
  const constrainSize = mainJs.slice(
    mainJs.indexOf("function constrainBubbleSizeToWorkArea"),
    mainJs.indexOf("function positionBubble")
  );
  const positionBubble = mainJs.slice(
    mainJs.indexOf("function positionBubble"),
    mainJs.indexOf("function clearBubbleLoadWatchdog")
  );
  const createBubbleWindow = mainJs.slice(
    mainJs.indexOf("function createBubbleWindow"),
    mainJs.indexOf("function createWindow")
  );

  assert.match(mainJs, /let preferredBubbleWidth = BUBBLE_CONFIG\.minWidth/);
  assert.match(mainJs, /let preferredBubbleHeight = 80/);
  assert.match(constrainSize, /normalizeBubbleSize\(\{[\s\S]*preferredBubbleWidth/);
  assert.match(constrainSize, /workArea,/);
  assert.match(constrainSize, /bubbleWidth = normalized\.width/);
  assert.match(constrainSize, /bubbleHeight = normalized\.height/);
  assert.doesNotMatch(constrainSize, /preferredBubble(?:Width|Height)\s*=/);
  assert.match(
    positionBubble,
    /const workArea = getCurrentWorkArea\(\);[\s\S]*constrainBubbleSizeToWorkArea\(workArea\)/
  );
  assert.match(positionBubble, /bubbleSize,/);
  assert.match(
    createBubbleWindow,
    /const initialBubbleSize = constrainBubbleSizeToWorkArea\(getCurrentWorkArea\(\)\);/
  );
  assert.match(createBubbleWindow, /width: initialBubbleSize\.width/);
  assert.match(createBubbleWindow, /height: initialBubbleSize\.height/);
});

test("main은 object 보고로 선호 폭·높이를 갱신하고 legacy 숫자는 선호 높이만 갱신한다", () => {
  const resizeHandler = mainJs.slice(
    mainJs.indexOf("ipcMain.on(BUBBLE_CHANNELS.RESIZE"),
    mainJs.indexOf("ipcMain.on(BUBBLE_CHANNELS.DISMISS")
  );

  assert.match(resizeHandler, /normalizePreferredBubbleSize\(size,\s*\{/);
  assert.match(resizeHandler, /currentWidth:\s*preferredBubbleWidth/);
  assert.match(resizeHandler, /currentHeight:\s*preferredBubbleHeight/);
  assert.match(resizeHandler, /preferredBubbleWidth = preferred\.width/);
  assert.match(resizeHandler, /preferredBubbleHeight = preferred\.height/);
  assert.match(resizeHandler, /constrainBubbleSizeToWorkArea\(getCurrentWorkArea\(\)\)/);
});

test("main은 display 변경 때 보이는 말풍선만 현재 화면에 다시 배치한다", () => {
  const displayHandler = mainJs.slice(
    mainJs.indexOf("function repositionVisibleBubbleForDisplayChange"),
    mainJs.indexOf("function registerBubbleDisplayListeners")
  );
  const displayRegistration = mainJs.slice(
    mainJs.indexOf("function registerBubbleDisplayListeners"),
    mainJs.indexOf("function unregisterBubbleDisplayListeners")
  );
  const readyLifecycle = mainJs.slice(
    mainJs.indexOf("app.whenReady().then"),
    mainJs.indexOf('app.on("before-quit"')
  );
  const quitLifecycle = mainJs.slice(
    mainJs.indexOf('app.on("before-quit"'),
    mainJs.indexOf('app.on("window-all-closed"')
  );

  assert.match(displayHandler, /bubbleWindow\.isVisible\(\)/);
  assert.match(displayHandler, /positionBubble\(\)/);
  assert.match(
    displayRegistration,
    /screen\.on\("display-metrics-changed", repositionVisibleBubbleForDisplayChange\)/
  );
  assert.match(
    displayRegistration,
    /screen\.on\("display-added", repositionVisibleBubbleForDisplayChange\)/
  );
  assert.match(
    displayRegistration,
    /screen\.on\("display-removed", repositionVisibleBubbleForDisplayChange\)/
  );
  assert.match(readyLifecycle, /registerBubbleDisplayListeners\(\)/);
  assert.match(quitLifecycle, /unregisterBubbleDisplayListeners\(\)/);
});

test("말풍선 renderer는 콘텐츠 선호 폭과 현재 높이를 함께 보고한다", () => {
  const reports = [];
  const { bubble, root, update } = createBubbleHarness({
    reportSize: (size) => reports.push(size),
  });
  bubble.offsetWidth = 402;
  bubble.scrollWidth = 399;
  root.offsetHeight = 126;

  update({ kind: "activity", title: "CodePet · Sol · Medium", text: "작업 중" });

  assert.deepEqual(reports.at(-1), { width: 412, height: 126 });
  assert.equal(bubble.className.split(/\s+/).includes("measure-width"), false);
});

test("같은 크기 콘텐츠 갱신은 매번 보고하고 unchanged window resize는 보고하지 않는다", () => {
  const reports = [];
  const harness = createBubbleHarness({ reportSize: (size) => reports.push(size) });
  harness.bubble.offsetWidth = 310;
  harness.bubble.scrollWidth = 307;
  harness.root.offsetHeight = 100;
  harness.update({ kind: "activity", title: "짧은 작업", text: "내용" });
  assert.equal(reports.length, 1);

  harness.update({ kind: "activity", title: "짧은 작업", text: "새 내용" });
  assert.equal(reports.length, 2);
  assert.deepEqual(reports, [
    { width: 320, height: 100 },
    { width: 320, height: 100 },
  ]);

  harness.fireWindowResize();
  assert.equal(reports.length, 2);

  harness.root.offsetHeight = 84;
  harness.fireWindowResize();
  assert.equal(reports.length, 3);
  assert.deepEqual(reports.at(-1), { width: 320, height: 84 });

  harness.fireWindowResize();
  assert.equal(reports.length, 3);
  assert.deepEqual(harness.measurementEvents, [
    "width", "height",
    "width", "height",
    "width", "height",
    "width", "height",
    "width", "height",
  ]);
  assert.equal(harness.bubble.className.split(/\s+/).includes("measure-width"), false);
});

test("fontFamily 변경은 콘텐츠가 있을 때만 적용 후 크기를 한 번 강제 보고한다", () => {
  const reports = [];
  const harness = createBubbleHarness({ reportSize: (size) => reports.push(size) });
  harness.bubble.offsetWidth = 350;
  harness.root.offsetHeight = 110;

  harness.updateAppearance({ fontFamily: "Pretendard" });
  assert.equal(reports.length, 0);

  harness.update({ kind: "activity", title: "긴 작업 제목", text: "내용" });
  assert.equal(reports.length, 1);

  harness.updateAppearance({ fontFamily: "Apple SD Gothic Neo" });
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.at(-1), { width: 360, height: 110 });

  harness.updateAppearance({ fontFamily: "Apple SD Gothic Neo" });
  assert.equal(reports.length, 2);
  assert.deepEqual(harness.measurementEvents, [
    "width", "height",
    "width", "height",
  ]);
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

test("활동 아이콘은 SVG 모듈과 접근성 제목으로 렌더링한다", () => {
  const createTitleSource = bubbleJs.slice(
    bubbleJs.indexOf("function createTitle("),
    bubbleJs.indexOf("function fillClassFor(")
  );
  assert.equal(fs.existsSync(path.join(__dirname, "..", "src", "activity-icons.js")), true);
  assert.match(bubbleHtml, /activity-icons\.js[\s\S]*bubble\.js/);
  assert.match(bubbleJs, /window\.activityIcons\.createActivityIcon\(document, statusIcon\)/);
  assert.match(bubbleJs, /setAttribute\("role", "heading"\)/);
  assert.doesNotMatch(createTitleSource, /title\.setAttribute\("aria-label", titleLabel\)/);
  assert.match(bubbleJs, /appendStatusHeadingContent\(title, titleText, statusIcon, titleLabel\)/);
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
  assert.match(badgeRenderer, /badge\.setAttribute\("role", "img"\)/);
  assert.match(badgeRenderer, /badge\.setAttribute\("aria-label", `활성 서브에이전트 \$\{count\}개`\)/);
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

  assert.equal(singleTitle.attributes["aria-label"], undefined);
  assert.deepEqual(
    singleTitle.children.map((child) => child.className),
    ["status-icon", "activity-title-text", "subagent-badge"]
  );
  assert.equal(singleTitle.children[1].textContent, "아주 긴 단일 작업 제목");
  assert.equal(singleTitle.children[1].attributes["aria-label"], "접근성 단일 제목");
  assert.equal(singleTitle.children[2].attributes.role, "img");
  assert.equal(singleTitle.children[2].attributes["aria-label"], "활성 서브에이전트 2개");
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
  const sectionLabel = multiBubble.children[0].children[0].children[0];

  assert.equal(sectionLabel.attributes["aria-label"], undefined);
  assert.deepEqual(
    sectionLabel.children.map((child) => child.className),
    ["status-icon", "activity-title-text", "subagent-badge"]
  );
  assert.equal(sectionLabel.children[1].textContent, "아주 긴 다중 작업 제목");
  assert.equal(sectionLabel.children[1].attributes["aria-label"], "접근성 다중 제목");
  assert.equal(sectionLabel.children[2].attributes.role, "img");
  assert.equal(sectionLabel.children[2].attributes["aria-label"], "활성 서브에이전트 3개");
  assert.equal(childWithClass(sectionLabel.children[2], "subagent-count").textContent, "×3");
});

test("활동 heading의 최종 접근성 이름은 제목·provider quota·서브에이전트 수를 한 번씩 읽는다", () => {
  const bubble = renderBubble({
    kind: "activity",
    title: "CodePet · Sol · Medium",
    titleLabel: "응답 작성 중 · CodePet · Sol · Medium",
    statusIcon: "writing",
    subagentCount: 2,
    usageBadges: [
      { key: "5h", remainingPercent: 42, ariaLabel: "Codex 5시간 42% 남음" },
    ],
    text: "",
  });
  const name = accessibleText(bubble.children[0]);

  assert.equal(name, [
    "응답 작성 중 · CodePet · Sol · Medium",
    "활성 서브에이전트 2개",
    "Codex 5시간 42% 남음",
  ].join(" "));
  assert.equal(name.match(/활성 서브에이전트 2개/g)?.length, 1);
  assert.equal(name.match(/Codex 5시간 42% 남음/g)?.length, 1);
});

test("월간 남은 사용량 배지를 작업 제목에 표시한다", () => {
  const bubble = renderBubble({
    kind: "activity",
    title: "CodePet · Sol · Max",
    statusIcon: "writing",
    usageBadges: [
      { key: "1mo", remainingPercent: 76, ariaLabel: "Codex 월간 76% 남음" },
    ],
    text: "작업 중",
  });
  const usageGroup = childWithClass(bubble.children[0], "activity-usage-badges");

  assert.ok(usageGroup);
  assert.deepEqual(usageGroup.children.map((badge) => badge.textContent), ["1mo 76%"]);
  assert.equal(usageGroup.children[0].attributes["aria-label"], "Codex 월간 76% 남음");
});

test("긴 제목·서브에이전트·5h·7d 결합 헤더는 제목만 축소하고 배지는 한 줄에 고정한다", () => {
  const bubble = renderBubble({
    kind: "activity",
    title: "매우 긴 프로젝트 제목 · K3 · Max · 상세 작업 이름",
    titleLabel: "전체 활동 제목",
    statusIcon: "working",
    subagentCount: 12,
    usageBadges: [
      { key: "5h", remainingPercent: 42, ariaLabel: "5시간 42% 남음" },
      { key: "7d", remainingPercent: 68, ariaLabel: "7일 68% 남음" },
    ],
    text: "작업 중",
  });
  const title = bubble.children[0];
  const usageGroup = title.children[3];
  const titleRule = bubbleCss.match(/\.title\s*\{[^}]*}/s)?.[0] || "";
  const titleTextRule = bubbleCss.match(/\.activity-title-text\s*\{[^}]*}/s)?.[0] || "";
  const subagentRule = bubbleCss.match(/\.subagent-badge\s*\{[^}]*}/s)?.[0] || "";
  const usageRule = bubbleCss.match(/\.activity-usage-badges\s*\{[^}]*}/s)?.[0] || "";

  assert.deepEqual(
    title.children.map((child) => child.className),
    ["status-icon", "activity-title-text", "subagent-badge", "activity-usage-badges"]
  );
  assert.equal(title.children[1].textContent, "매우 긴 프로젝트 제목 · K3 · Max · 상세 작업 이름");
  assert.equal(childWithClass(title.children[2], "subagent-count").textContent, "×12");
  assert.deepEqual(usageGroup.children.map((badge) => badge.textContent), ["5h 42%", "7d 68%"]);
  assert.match(titleRule, /flex-wrap:\s*nowrap/);
  assert.match(titleTextRule, /min-width:\s*0/);
  assert.match(titleTextRule, /text-overflow:\s*ellipsis/);
  assert.match(subagentRule, /flex:\s*none/);
  assert.match(usageRule, /flex:\s*none/);
  assert.match(usageRule, /white-space:\s*nowrap/);
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

test("공급자별 첫 활동 row와 단일 활동 제목에만 유효한 사용량 배지를 렌더링한다", () => {
  const multiBubble = renderBubble({
    kind: "activity",
    title: "총 4개 작업 중",
    usageBadges: [
      { key: "5h", remainingPercent: 1, ariaLabel: "헤더에 표시하면 안 됨" },
    ],
    sections: [
      {
        provider: "codex",
        title: "Codex A",
        text: "",
        usageBadges: [
          { key: "5h", remainingPercent: 42, ariaLabel: "Codex 5시간 42% 남음" },
          { key: "7d", remainingPercent: 68, ariaLabel: "Codex 7일 68% 남음" },
        ],
      },
      {
        provider: "kimi",
        title: "Kimi A",
        text: "",
        usageBadges: [
          { key: "5h", remainingPercent: 70, ariaLabel: "Kimi 5시간 70% 남음" },
        ],
      },
      { provider: "kimi", title: "Kimi B", text: "", usageBadges: [] },
      { provider: "codex", title: "Codex B", text: "", usageBadges: [] },
    ],
  });
  const sectionLabels = multiBubble.children
    .map((section) => section.children[0].children[0]);
  const codexGroup = childWithClass(sectionLabels[0], "activity-usage-badges");
  const kimiGroup = childWithClass(sectionLabels[1], "activity-usage-badges");

  assert.equal(JSON.stringify(multiBubble).includes("헤더에 표시하면 안 됨"), false);
  assert.ok(codexGroup);
  assert.deepEqual(
    codexGroup.children.map((badge) => badge.className),
    ["activity-usage-badge", "activity-usage-badge"]
  );
  assert.deepEqual(codexGroup.children.map((badge) => badge.textContent), ["5h 42%", "7d 68%"]);
  assert.deepEqual(codexGroup.children.map((badge) => badge.attributes["aria-label"]), [
    "Codex 5시간 42% 남음",
    "Codex 7일 68% 남음",
  ]);
  assert.deepEqual(kimiGroup.children.map((badge) => badge.textContent), ["5h 70%"]);
  assert.equal(descendantWithClass(sectionLabels[2], "activity-usage-badges"), null);
  assert.equal(descendantWithClass(sectionLabels[3], "activity-usage-badges"), null);

  const singleBubble = renderBubble({
    kind: "activity",
    provider: "kimi",
    title: "CodePet · K3 · Max",
    usageBadges: [{ key: "5h", remainingPercent: 70, ariaLabel: "Kimi 5시간 70% 남음" }],
    text: "",
  });
  assert.deepEqual(
    childWithClass(singleBubble.children[0], "activity-usage-badges").children.map(
      (badge) => badge.textContent
    ),
    ["5h 70%"]
  );

  const invalidBubble = renderBubble({
    kind: "activity",
    title: "총 2개 작업 중",
    sections: [
      {
        title: "A",
        text: "",
        usageBadges: [
          { key: "5h", remainingPercent: "42", ariaLabel: "잘못된 값", secret: "raw" },
        ],
      },
      { title: "B", text: "" },
    ],
  });
  assert.equal(descendantWithClass(invalidBubble, "activity-usage-badges"), null);
  assert.equal(JSON.stringify(invalidBubble).includes("raw"), false);
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

test("표시 기능 토글이 꺼지면 현재 말풍선의 배지를 즉시 숨기고 다시 켜면 복원한다", () => {
  const harness = createBubbleHarness();
  harness.update({
    kind: "activity",
    title: "CodePet",
    statusIcon: "working",
    subagentCount: 2,
    usageBadges: [
      { key: "5h", remainingPercent: 42, ariaLabel: "Codex 5시간 42% 남음" },
    ],
    text: "작업 중",
  });
  assert.ok(descendantWithClass(harness.bubble, "subagent-badge"));
  assert.ok(descendantWithClass(harness.bubble, "activity-usage-badges"));

  harness.updateAppearance({ showUsageBadges: false, showSubagentBadge: false });
  assert.equal(descendantWithClass(harness.bubble, "subagent-badge"), null);
  assert.equal(descendantWithClass(harness.bubble, "activity-usage-badges"), null);

  harness.updateAppearance({ showUsageBadges: true, showSubagentBadge: true });
  assert.ok(descendantWithClass(harness.bubble, "subagent-badge"));
  assert.ok(descendantWithClass(harness.bubble, "activity-usage-badges"));
});

test("말풍선 표시 기능 토글은 설정 저장부터 appearance 전파까지 연결된다", () => {
  assert.match(settingsHtml, /id="nav-bubble"/);
  assert.match(settingsHtml, /id="usage-badges"/);
  assert.match(settingsHtml, /id="subagent-badge"/);
  assert.match(settingsHtml, /id="save-bubble"/);
  assert.match(settingsJs, /showUsageBadges: \$\("#usage-badges"\)\.checked/);
  assert.match(settingsJs, /showSubagentBadge: \$\("#subagent-badge"\)\.checked/);
  assert.match(mainJs, /patch\.showUsageBadges = next\.showUsageBadges/);
  assert.match(mainJs, /patch\.showSubagentBadge = next\.showSubagentBadge/);
  assert.match(mainJs, /showUsageBadges: settings\.showUsageBadges !== false/);
  assert.match(mainJs, /showSubagentBadge: settings\.showSubagentBadge !== false/);
  assert.match(bubbleJs, /appearance\?\.showUsageBadges !== false/);
  assert.match(bubbleJs, /appearance\?\.showSubagentBadge !== false/);
});

test("설정 창 다국어는 언어 선택부터 저장·사전 적용까지 연결된다", () => {
  assert.match(settingsHtml, /<script src="\.\/settings-i18n\.js"><\/script>[\s\S]*<script src="\.\/settings\.js"><\/script>/);
  assert.match(settingsHtml, /data-i18n="nav\.general"/);
  assert.match(settingsHtml, /id="language"/);
  assert.match(settingsJs, /applyLanguage\(state\.language\)/);
  assert.match(settingsJs, /language: \$\("#language"\)\.value/);
  assert.match(mainJs, /language: settings\.language \|\| "system"/);
  assert.match(mainJs, /systemLocale: app\.getLocale\(\)/);
  assert.match(mainJs, /patch\.language = next\.language/);
});

test("말풍선 색상 라이브 프리뷰는 bubble 창에 즉시 반영되고 닫으면 저장값으로 복원된다", () => {
  assert.match(settingsPreloadJs, /PREVIEW_APPEARANCE: "settings:preview-appearance"/);
  assert.match(settingsPreloadJs, /previewAppearance: \(value\) => ipcRenderer\.send/);
  assert.match(settingsJs, /api\.previewAppearance\(\{ bubbleBgColor: previewBg, bubbleTextColor: previewText \}\)/);
  assert.match(mainJs, /ipcMain\.on\("settings:preview-appearance"/);
  assert.match(mainJs, /bubbleWindow\.webContents\.send\("appearance:update", payload\)/);
  const closedHandler = mainJs.match(/settingsWindow\.on\("closed", \(\) => \{[\s\S]*?\}\);/)?.[0] || "";
  assert.match(closedHandler, /sendAppearanceToWindows\(\)/);
});

test("설정 창은 캐시된 사용량으로 즉시 열리고 최신값은 백그라운드에서 갱신된다", () => {
  assert.match(mainJs, /getSettingsData\(\{ usageMode: "cache" \}\)/);
  assert.match(mainJs, /scheduleUsageSnapshotRefresh\(\)/);
  assert.match(mainJs, /settingsWindow\.webContents\.send\("settings:usage-refreshed"/);
  assert.match(mainJs, /lastUsageSnapshot = \{ providers, usage \}/);
  assert.match(settingsPreloadJs, /USAGE_REFRESHED: "settings:usage-refreshed"/);
  assert.match(settingsPreloadJs, /onUsageRefreshed: \(handler\) =>/);
  assert.match(settingsJs, /api\.onUsageRefreshed\(\(payload\) =>/);
  assert.match(settingsJs, /registerUsageUpdates\(\)/);
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
    /pendingBubbleData\?\.activitySource === "active"[\s\S]*?showActiveActivityBubble\(\)/
  );
  assert.doesNotMatch(mainJs, /activityUsageResetTimer|scheduleActivityUsageReset/);
  assert.doesNotMatch(buildActiveBubble, /decorateActivityBubbleWithProviderUsage/);
  assert.match(buildActiveBubble, /activeActivityBubbles\.toBubbleData\(\)/);
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

test("provider 사용량은 privacy 적용 뒤 renderer 직전에 eligibility를 지켜 장식한다", () => {
  const watcherBubble = mainJs.match(
    /function showWatcherActivityBubble\(data,[\s\S]*?\n}/
  )?.[0] || "";
  const privacyIndex = watcherBubble.indexOf("createVisibleActivityBubble(activityData)");
  const decorateIndex = watcherBubble.indexOf("decorateActivityBubbleWithProviderUsage(");
  const showIndex = watcherBubble.indexOf("showBubble(");

  assert.ok(privacyIndex >= 0);
  assert.ok(decorateIndex > privacyIndex);
  assert.ok(showIndex > decorateIndex);
  assert.match(watcherBubble, /codex:\s*activityUsageController\.buildBadges\(\)/);
  assert.match(watcherBubble, /kimi:\s*kimiUsageController\.buildBadges\(\)/);
});

test("단일 Codex section 사용량은 현재 보이는 active 말풍선만 다시 그린다", () => {
  const controllerSetup = mainJs.match(
    /const activityUsageController = new ActivityUsageController\([\s\S]*?\n}\);/
  )?.[0] || "";
  const callbackSource = controllerSetup.match(
    /onBadgesChanged:\s*(\(\) => \{[\s\S]*?\n  \})/
  )?.[1];
  assert.ok(callbackSource);

  let pendingBubbleData = { activitySource: "active" };
  let redrawCount = 0;
  let nowMs = 1_000;
  let resetCallback = null;
  const onBadgesChanged = vm.runInNewContext(`(${callbackSource})`, {
    codexWatcher: { working: true },
    pendingBubbleData,
    showActiveActivityBubble() {
      redrawCount += 1;
    },
  });
  const controller = new ActivityUsageController({
    now: () => nowMs,
    setTimer(callback) {
      resetCallback = callback;
      return 1;
    },
    clearTimer() {
      resetCallback = null;
    },
    onBadgesChanged,
  });

  controller.update("codex:single", {
    rateLimits: {
      windows: [{ window_minutes: 300, used_percent: 60, resets_at: 2 }],
    },
  });
  assert.equal(redrawCount, 1);

  nowMs = 2_000;
  const runReset = resetCallback;
  assert.equal(typeof runReset, "function");
  runReset();
  assert.equal(redrawCount, 2);

  pendingBubbleData = null;
  const hiddenCallback = vm.runInNewContext(`(${callbackSource})`, {
    codexWatcher: { working: true },
    pendingBubbleData,
    showActiveActivityBubble() {
      redrawCount += 1;
    },
  });
  hiddenCallback();
  assert.equal(redrawCount, 2);

  const temporaryCallback = vm.runInNewContext(`(${callbackSource})`, {
    codexWatcher: { working: true },
    pendingBubbleData: { activitySource: "temporary" },
    showActiveActivityBubble() {
      redrawCount += 1;
    },
  });
  temporaryCallback();
  assert.equal(redrawCount, 2);
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
  assert.match(settingsJs, /function createProviderMark/);
  assert.match(settingsJs, /provider\.icon/);
  assert.match(settingsCss, /\.provider-mark img/);
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
  assert.match(mainJs, /usage = \[\.\.\.codexUsage, \.\.\.agy\.usage, \.\.\.claude\.usage, \.\.\.kimiUsage\]/);
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
  assert.match(settingsJs, /t\("busy\.delete"\)/);
  assert.match(settingsI18nJs, /삭제 중…/);
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
