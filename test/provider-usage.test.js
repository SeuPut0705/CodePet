const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  clearUsageCache,
  fetchAntigravityUsage,
  fetchClaudeUsage,
  normalizeAgyQuota,
  normalizeClaudeUsage,
  tierLabel,
} = require("../src/provider-usage");

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

test("AGY 한도는 남은 비율을 사용률로 바꾸고 잘못된 bucket은 제외한다", () => {
  assert.deepEqual(
    normalizeAgyQuota({
      groups: [
        {
          displayName: "모델",
          buckets: [
            { displayName: "주간", remainingFraction: 0.25, resetTime: "soon" },
            { displayName: "누락" },
          ],
        },
      ],
    }),
    [{ label: "모델 · 주간", usedPercent: 75, resetText: "soon" }]
  );
});

test("Claude 한도는 전체 및 모델별 창을 표시하고 범위를 보정한다", () => {
  const gauges = normalizeClaudeUsage({
    five_hour: { utilization: 50.4, resets_at: "a" },
    seven_day: { utilization: 120, resets_at: "b" },
    seven_day_sonnet: { utilization: 25, resets_at: "c" },
  });
  assert.deepEqual(gauges.map((item) => item.label), ["5시간", "7일", "7일 · Sonnet"]);
  assert.deepEqual(gauges.map((item) => item.usedPercent), [50, 100, 25]);
});

test("Claude access-only 토큰이 만료되면 API 호출 없이 재로그인을 안내한다", async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
  });
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({}, 401);
  };

  const credentialStore = {
    read: () => ({
      claudeAiOauth: {
        accessToken: "expired",
        expiresAt: Date.now() - 60_000,
      },
    }),
    write: () => {},
  };

  await assert.rejects(
    fetchClaudeUsage({ force: true, credentialStore }),
    (error) => {
      assert.equal(error.displayMessage, "로그인 만료 · 계정 탭에서 다시 로그인");
      return true;
    }
  );
  assert.equal(calls, 0);
});

test("Claude access-only 토큰이 서버에서 폐기됐으면 재로그인을 안내한다", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
  });
  global.fetch = async () => jsonResponse({}, 401);

  await assert.rejects(
    fetchClaudeUsage({
      force: true,
      credentialStore: {
        read: () => ({ claudeAiOauth: { accessToken: "revoked", expiresAt: Date.now() + 3_600_000 } }),
        write: () => {},
      },
    }),
    (error) => {
      assert.equal(error.displayMessage, "로그인 만료 · 계정 탭에서 다시 로그인");
      return true;
    }
  );
});

test("Claude 사용량 API가 제한되면 잠시 후 재시도를 안내한다", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
  });
  global.fetch = async () => jsonResponse({}, 429);

  await assert.rejects(
    fetchClaudeUsage({
      force: true,
      credentialStore: {
        read: () => ({
          claudeAiOauth: {
            accessToken: "limited",
            refreshToken: "refresh",
            expiresAt: Date.now() + 3_600_000,
          },
        }),
        write: () => {},
      },
    }),
    (error) => {
      assert.equal(error.displayMessage, "요청 제한 · 잠시 후 다시 시도");
      return true;
    }
  );
});

test("Claude 갱신 토큰이 폐기됐으면 재로그인을 안내한다", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
  });
  global.fetch = async () => jsonResponse({}, 400);

  await assert.rejects(
    fetchClaudeUsage({
      force: true,
      credentialStore: {
        read: () => ({
          claudeAiOauth: {
            accessToken: "expired",
            refreshToken: "revoked-refresh",
            expiresAt: Date.now() - 60_000,
          },
        }),
        write: () => {},
      },
    }),
    (error) => {
      assert.equal(error.displayMessage, "로그인 만료 · 계정 탭에서 다시 로그인");
      return true;
    }
  );
});

test("Claude 토큰 갱신 뒤 사용량 API가 제한돼도 재시도를 안내한다", async (t) => {
  const originalFetch = global.fetch;
  const responses = [
    jsonResponse({}, 401),
    jsonResponse({ access_token: "renewed", refresh_token: "renewed-refresh", expires_in: 3600 }),
    jsonResponse({}, 429),
  ];
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
  });
  global.fetch = async () => responses.shift();

  await assert.rejects(
    fetchClaudeUsage({
      force: true,
      credentialStore: {
        read: () => ({
          claudeAiOauth: {
            accessToken: "stale",
            refreshToken: "refresh",
            expiresAt: Date.now() + 3_600_000,
          },
        }),
        write: () => {},
      },
    }),
    (error) => {
      assert.equal(error.displayMessage, "요청 제한 · 잠시 후 다시 시도");
      return true;
    }
  );
});

test("AGY 응답에서 계정, 플랜, 한도만 정규화한다", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
  });
  global.fetch = async (url) => {
    if (String(url).includes("loadCodeAssist")) {
      return jsonResponse({
        cloudaicompanionProject: "projects/test",
        currentTier: { displayName: "Google AI Pro" },
      });
    }
    if (String(url).includes("userinfo")) return jsonResponse({ email: "agy@example.com" });
    return jsonResponse({
      groups: [{ displayName: "모델", buckets: [{ displayName: "5시간", remainingFraction: 0.8 }] }],
    });
  };

  const result = await fetchAntigravityUsage({
    credential: { token: { access_token: "access", refresh_token: "refresh" } },
    force: true,
  });
  assert.equal(result.email, "agy@example.com");
  assert.equal(result.plan, "Google AI Pro");
  assert.equal(result.gauges[0].usedPercent, 20);
  assert.equal(tierLabel({ currentTier: { name: "free-tier" } }), "free-tier");
});

test("AGY 저장 계정 access token이 만료되면 갱신하고 사용량 조회를 재시도한다", async (t) => {
  const originalFetch = global.fetch;
  let stored = { token: { access_token: "expired", refresh_token: "refresh" } };
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
  });
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("oauth2.googleapis.com/token")) {
      assert.match(String(options.body), /grant_type=refresh_token/);
      return jsonResponse({ access_token: "fresh", expires_in: 3600 });
    }
    if (target.includes("loadCodeAssist") && options.headers.authorization === "Bearer expired") {
      return jsonResponse({}, 401);
    }
    if (target.includes("loadCodeAssist")) {
      return jsonResponse({ cloudaicompanionProject: "projects/test" });
    }
    if (target.includes("userinfo")) return jsonResponse({ email: "agy@example.com" });
    return jsonResponse({
      groups: [{ displayName: "모델", buckets: [{ displayName: "5시간", remainingFraction: 0.5 }] }],
    });
  };

  const result = await fetchAntigravityUsage({
    credentialStore: {
      read: () => stored,
      write: (next) => {
        stored = next;
      },
    },
    force: true,
  });

  assert.equal(stored.token.access_token, "fresh");
  assert.equal(result.gauges[0].usedPercent, 50);
});

test("Claude 사용량 cache는 계정 자격 증명별로 분리한다", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-usage-"));
  const credentialPath = path.join(home, ".claude", ".credentials.json");
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  const originalFetch = global.fetch;
  let calls = 0;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
    fs.rmSync(home, { recursive: true, force: true });
  });
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({ five_hour: { utilization: calls * 10, resets_at: "soon" } });
  };

  fs.writeFileSync(
    credentialPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "account-a" } })
  );
  await fetchClaudeUsage({ home });
  await fetchClaudeUsage({ home });
  fs.writeFileSync(
    credentialPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "b", refreshToken: "account-b" } })
  );
  await fetchClaudeUsage({ home });
  assert.equal(calls, 2);
});
