const test = require("node:test");
const assert = require("node:assert/strict");

const { formatActivityMessage } = require("../src/activity-message");

test("펫 메시지는 Markdown 장식을 걷고 목록과 문단 구조를 보존한다", () => {
  const message = formatActivityMessage(
    "# 완료\n\n- **파일**: `src/main.js`\n> [문서 보기](https://example.com)\n\n```js\nconst token = 'secret';\n```"
  );

  assert.equal(message, "완료\n\n• 파일: src/main.js\n문서 보기\n\n[코드]");
});

test("긴 펫 메시지는 이모지를 자르지 않고 글자 수를 제한한다", () => {
  assert.equal(
    formatActivityMessage("1234567890👨‍👩‍👧‍👦끝", { maxChars: 11 }),
    "1234567890👨‍👩‍👧‍👦…"
  );
});

test("일반 경로의 밑줄과 비교식은 Markdown이나 HTML로 오인하지 않는다", () => {
  assert.equal(
    formatActivityMessage("foo_bar_baz\n/tmp/a_b_c.js\nx < y && y > z\n`Promise<T>` · <Button>"),
    "foo_bar_baz\n/tmp/a_b_c.js\nx < y && y > z\nPromise<T> · <Button>"
  );
});
