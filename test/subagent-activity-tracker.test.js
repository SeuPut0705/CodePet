"use strict";

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
