const test = require("node:test");
const assert = require("node:assert/strict");

const { redactActivityDetail } = require("../src/activity-redaction");

test("활동 명령의 인증 헤더·환경변수·옵션·URL 비밀값을 마스킹한다", () => {
  const samples = [
    'curl -H "Authorization: Bearer TOPSECRET" https://example.test',
    "API_KEY=TOPSECRET npm test",
    "tool --token TOPSECRET --api-key=SECOND",
    "curl 'https://example.test?q=ok&access_token=TOPSECRET'",
    '{"apiKey":"TOPSECRET","safe":"visible"}',
    'curl -H "Authorization: Basic dXNlcjpwYXNz" https://example.test',
    "curl -u user:password https://example.test",
    'curl -H "Cookie: session=TOPSECRET" https://example.test',
  ];

  for (const sample of samples) {
    const redacted = redactActivityDetail(sample);
    assert.doesNotMatch(redacted, /TOPSECRET|SECOND|dXNlcjpwYXNz|user:password/);
    assert.match(redacted, /\[redacted\]/);
  }
});

test("비밀값이 없는 파일 경로와 검색어는 그대로 둔다", () => {
  assert.equal(
    redactActivityDetail("rg provider src/provider-catalog.js"),
    "rg provider src/provider-catalog.js"
  );
});
