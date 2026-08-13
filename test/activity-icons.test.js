const test = require("node:test");
const assert = require("node:assert/strict");

let createActivityIcon = () => null;
try {
  ({ createActivityIcon } = require("../src/activity-icons"));
} catch {
  // RED 단계에서는 모듈이 아직 없습니다.
}

class FakeElement {
  constructor(namespace, tagName) {
    this.namespace = namespace;
    this.tagName = tagName;
    this.attributes = {};
    this.children = [];
    this.dataset = {};
    this.className = "";
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

const fakeDocument = {
  createElementNS(namespace, tagName) {
    return new FakeElement(namespace, tagName);
  },
};

test("모든 활동 상태를 16px용 SVG 아이콘으로 만든다", () => {
  const iconIds = [
    "working",
    "review",
    "writing",
    "edit",
    "inspect",
    "image",
    "test",
    "build",
    "terminal",
    "waiting",
    "success",
    "error",
  ];

  for (const iconId of iconIds) {
    const icon = createActivityIcon(fakeDocument, iconId);
    assert.ok(icon, `${iconId} 아이콘이 필요합니다`);
    assert.equal(icon.tagName, "svg");
    assert.equal(icon.attributes.class, "status-icon");
    assert.equal(icon.dataset.status, iconId);
    assert.equal(icon.attributes.viewBox, "0 0 16 16");
    assert.equal(icon.attributes.stroke, "currentColor");
    assert.equal(icon.attributes["stroke-width"], "1.75");
    assert.equal(icon.attributes["aria-hidden"], "true");
    assert.equal(icon.attributes.focusable, "false");
    assert.ok(icon.children.length > 0, `${iconId}에 SVG 도형이 필요합니다`);
  }
});

test("서브에이전트 배지용 16px SVG를 만든다", () => {
  const icon = createActivityIcon(fakeDocument, "agents");

  assert.equal(icon.tagName, "svg");
  assert.equal(icon.attributes["aria-hidden"], "true");
  assert.equal(icon.attributes.focusable, "false");
  assert.equal(icon.dataset.status, "agents");
  assert.ok(icon.children.length >= 2);
});

test("허용되지 않은 상태는 SVG를 만들지 않는다", () => {
  assert.equal(createActivityIcon(fakeDocument, "<script>alert(1)</script>"), null);
  assert.equal(createActivityIcon(fakeDocument, "__proto__"), null);
  assert.equal(createActivityIcon(fakeDocument, "constructor"), null);
  assert.equal(createActivityIcon(fakeDocument, "toString"), null);
  assert.equal(createActivityIcon(fakeDocument, null), null);
});
