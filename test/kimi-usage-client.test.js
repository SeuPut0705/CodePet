const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { KimiUsageClient } = require("../src/kimi-usage-client");

const COMPLETE_CREDENTIALS = {
  access_token: "access-a",
  refresh_token: "refresh-a",
  expires_at: 5000,
  scope: "openid",
  token_type: "Bearer",
  expires_in: 3600,
};

function credentialFixture(t, overrides = {}, { deviceId = "device-a" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-kimi-"));
  const directory = path.join(home, "credentials");
  const file = path.join(directory, "kimi-code.json");
  fs.mkdirSync(directory, { recursive: true });
  const credentials = { ...COMPLETE_CREDENTIALS, ...overrides };
  const original = `${JSON.stringify(credentials, null, 2)}\n`;
  fs.writeFileSync(file, original, { mode: 0o600 });
  if (deviceId !== null) fs.writeFileSync(path.join(home, "device_id"), `${deviceId}\n`);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return {
    home,
    file,
    original,
    lockDir: path.join(home, "oauth", "kimi-code.lock"),
  };
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

test("유효한 Kimi access token으로 사용량을 조회하고 자격 파일은 쓰지 않는다", async (t) => {
  const fixture = credentialFixture(t);
  let requested;
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fetchImpl: async (url, options) => {
      requested = { url, authorization: options.headers.Authorization };
      return jsonResponse({ usage: { used: 20, limit: 100 } });
    },
  });

  assert.deepEqual(await client.fetchBadges(), [
    { key: "7d", remainingPercent: 80, ariaLabel: "Kimi 7일 80% 남음" },
  ]);
  assert.deepEqual(requested, {
    url: "https://api.kimi.com/coding/v1/usages",
    authorization: "Bearer access-a",
  });
  assert.equal(fs.readFileSync(fixture.file, "utf8"), fixture.original);
});

test("만료 임박 토큰은 공유 lock 안에서 다시 읽고 회전된 토큰을 원자 저장한다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  const requests = [];
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers, body: String(options.body || "") });
      if (url.includes("/api/oauth/token")) {
        assert.equal(fs.existsSync(fixture.lockDir), true);
        return jsonResponse({
          access_token: "new",
          refresh_token: "refresh-b",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      return jsonResponse({
        limits: [{ window: { duration: 5, timeUnit: "HOUR" }, detail: { used: 10, limit: 100 } }],
      });
    },
  });

  assert.equal((await client.fetchBadges())[0].remainingPercent, 90);
  const saved = JSON.parse(fs.readFileSync(fixture.file, "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(COMPLETE_CREDENTIALS).sort());
  assert.equal(saved.access_token, "new");
  assert.equal(saved.refresh_token, "refresh-b");
  assert.equal(saved.expires_at, 4600);
  assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(fixture.lockDir), false);
  assert.equal(requests[0].headers["X-Msh-Device-Id"], "device-a");
  assert.match(requests[0].body, /client_id=17e5f671-d194-4dfb-9706-5516cb48c098/);
  assert.match(requests[0].body, /grant_type=refresh_token/);
  assert.doesNotMatch(JSON.stringify(await client.fetchBadges()), /access-a|refresh-a|refresh-b/);
});

test("다른 프로세스가 lock 대기 중 갱신한 토큰을 다시 읽어 사용한다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  fs.mkdirSync(fixture.lockDir, { recursive: true });
  let refreshCalls = 0;
  let usageAuthorization;
  let nowMilliseconds = 10_000;
  let rotatedByOther = false;

  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    nowMilliseconds: () => nowMilliseconds,
    sleepImpl: async (milliseconds) => {
      nowMilliseconds += milliseconds;
      if (rotatedByOther) return;
      rotatedByOther = true;
      const rotated = {
        ...COMPLETE_CREDENTIALS,
        access_token: "rotated",
        refresh_token: "refresh-rotated",
        expires_at: 5000,
      };
      fs.writeFileSync(fixture.file, `${JSON.stringify(rotated)}\n`, { mode: 0o600 });
      fs.rmdirSync(fixture.lockDir);
    },
    timeoutMs: 500,
    fetchImpl: async (url, options) => {
      if (url.includes("/api/oauth/token")) refreshCalls += 1;
      else usageAuthorization = options.headers.Authorization;
      return jsonResponse({ usage: { used: 1, limit: 10 } });
    },
  });

  await client.fetchBadges();
  assert.equal(refreshCalls, 0);
  assert.equal(usageAuthorization, "Bearer rotated");
});

test("fresh lock은 제거하지 않고 제한 시간 뒤 안전한 오류를 반환한다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  fs.mkdirSync(fixture.lockDir, { recursive: true });
  let nowMilliseconds = 10_000;
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    nowMilliseconds: () => nowMilliseconds,
    sleepImpl: async (milliseconds) => { nowMilliseconds += milliseconds; },
    timeoutMs: 40,
    fetchImpl: async () => assert.fail("lock을 얻지 못하면 요청하지 않아야 합니다."),
  });

  await assert.rejects(client.fetchBadges(), (error) => {
    assert.equal(error.code, "KIMI_USAGE_LOCK");
    assert.doesNotMatch(error.message, /access|refresh|secret/);
    return true;
  });
  assert.equal(fs.existsSync(fixture.lockDir), true);
});

test("mtime이 오래된 외부 lock도 회수하지 않고 제한 시간 뒤 보존한다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  fs.mkdirSync(fixture.lockDir, { recursive: true });
  fs.utimesSync(fixture.lockDir, new Date(0), new Date(0));
  let nowMilliseconds = 10_000;

  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    nowMilliseconds: () => nowMilliseconds,
    sleepImpl: async (milliseconds) => { nowMilliseconds += milliseconds; },
    timeoutMs: 50,
    fetchImpl: async () => assert.fail("외부 lock은 오래됐어도 요청하지 않아야 합니다."),
  });

  await assert.rejects(client.fetchBadges(), (error) => {
    assert.equal(error.code, "KIMI_USAGE_LOCK");
    return true;
  });
  assert.equal(fs.existsSync(fixture.lockDir), true);
});

test("외부 lock을 검사하는 동안 canonical 경로를 비워 제3 contender를 들이지 않는다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  fs.mkdirSync(fixture.lockDir, { recursive: true });
  fs.utimesSync(fixture.lockDir, new Date(0), new Date(0));
  const originalRename = fs.promises.rename;
  let thirdContenderAcquired = false;
  fs.promises.rename = async (source, destination) => {
    const result = await originalRename.call(fs.promises, source, destination);
    if (source === fixture.lockDir) {
      try {
        await fs.promises.mkdir(fixture.lockDir);
        thirdContenderAcquired = true;
      } catch {}
    }
    return result;
  };
  t.after(() => { fs.promises.rename = originalRename; });
  let nowMilliseconds = 10_000;
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    nowMilliseconds: () => nowMilliseconds,
    sleepImpl: async (milliseconds) => { nowMilliseconds += milliseconds; },
    timeoutMs: 50,
    fetchImpl: async () => assert.fail("외부 lock 대기 중 요청하지 않아야 합니다."),
  });

  await assert.rejects(client.fetchBadges(), { code: "KIMI_USAGE_LOCK" });
  assert.equal(thirdContenderAcquired, false);
  assert.equal(fs.existsSync(fixture.lockDir), true);
});

test("release 확인 전에 교체된 다른 owner lock은 그대로 둔다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  const originalRm = fs.promises.rm;
  const originalStat = fs.promises.stat;
  let replacementIdentity = null;
  let interleaved = false;
  let lockStatCalls = 0;
  fs.promises.stat = async (target, ...args) => {
    if (target === fixture.lockDir && ++lockStatCalls === 2) {
      interleaved = true;
      await originalRm.call(fs.promises, fixture.lockDir, { recursive: true, force: true });
      await fs.promises.mkdir(fixture.lockDir);
      replacementIdentity = await originalStat.call(fs.promises, fixture.lockDir);
    }
    return originalStat.call(fs.promises, target, ...args);
  };
  t.after(() => {
    fs.promises.stat = originalStat;
  });
  let scheduledDelay = null;
  let cleared = false;

  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    nowMilliseconds: () => 10_000,
    setIntervalImpl: (_callback, milliseconds) => {
      scheduledDelay = milliseconds;
      return { unref() {} };
    },
    clearIntervalImpl: () => { cleared = true; },
    fetchImpl: async (url) => url.includes("/api/oauth/token")
      ? jsonResponse({ access_token: "new", expires_in: 3600 })
      : jsonResponse({ usage: { used: 0, limit: 1 } }),
  });

  await client.fetchBadges();
  const remaining = await originalStat.call(fs.promises, fixture.lockDir);
  assert.equal(interleaved, true);
  assert.equal(remaining.dev, replacementIdentity.dev);
  assert.equal(remaining.ino, replacementIdentity.ino);
  assert.equal(scheduledDelay, 2000);
  assert.equal(cleared, true);
});

test("release final heartbeat 뒤 freshness를 지키는 contender는 lock을 교체하지 못한다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  const fsImpl = Object.create(fs.promises);
  const originalRmdir = fs.promises.rmdir;
  const originalStat = fs.promises.stat;
  let contenderReplaced = false;
  const nowMilliseconds = 10_000;
  fsImpl.rmdir = async (target, ...args) => {
    if (target === fixture.lockDir) {
      const before = await originalStat.call(fs.promises, target);
      if (nowMilliseconds - before.mtimeMs > 5000) {
        await originalRmdir.call(fs.promises, target);
        await fs.promises.mkdir(target);
        contenderReplaced = true;
      }
    }
    return originalRmdir.call(fs.promises, target, ...args);
  };

  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    nowMilliseconds: () => nowMilliseconds,
    fsImpl,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    fetchImpl: async (url) => {
      if (url.includes("/api/oauth/token")) {
        fs.utimesSync(fixture.lockDir, new Date(0), new Date(0));
        return jsonResponse({ access_token: "new", expires_in: 3600 });
      }
      return jsonResponse({ usage: { used: 0, limit: 1 } });
    },
  });

  await client.fetchBadges();
  assert.equal(contenderReplaced, false);
  assert.equal(fs.existsSync(fixture.lockDir), false);
});

test("heartbeat scheduler callback은 열린 lock handle을 갱신하고 release 판단까지 유지된다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  const fsImpl = Object.create(fs.promises);
  const originalOpen = fs.promises.open;
  const originalStat = fs.promises.stat;
  let heartbeatCallback = null;
  let intervalActive = false;
  let activeAtReleaseValidation = null;
  let handleUtimesCalls = 0;
  fsImpl.open = async (target, ...args) => {
    const handle = await originalOpen.call(fs.promises, target, ...args);
    if (target !== fixture.lockDir) return handle;
    return {
      stat: (...methodArgs) => handle.stat(...methodArgs),
      utimes: (...methodArgs) => {
        handleUtimesCalls += 1;
        return handle.utimes(...methodArgs);
      },
      close: (...methodArgs) => handle.close(...methodArgs),
    };
  };
  fsImpl.stat = async (target, ...args) => {
    if (target === fixture.lockDir) activeAtReleaseValidation = intervalActive;
    return originalStat.call(fs.promises, target, ...args);
  };

  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    nowMilliseconds: () => 10_000,
    fsImpl,
    setIntervalImpl: (callback, milliseconds) => {
      assert.equal(milliseconds, 2000);
      heartbeatCallback = callback;
      intervalActive = true;
      return { unref() {} };
    },
    clearIntervalImpl: () => { intervalActive = false; },
    fetchImpl: async (url) => {
      if (url.includes("/api/oauth/token")) {
        await heartbeatCallback();
        assert.equal(handleUtimesCalls, 1);
        return jsonResponse({ access_token: "new", expires_in: 3600 });
      }
      return jsonResponse({ usage: { used: 0, limit: 1 } });
    },
  });

  await client.fetchBadges();
  assert.equal(handleUtimesCalls, 2);
  assert.equal(activeAtReleaseValidation, true);
  assert.equal(intervalActive, false);
});

test("lock mkdir 뒤 directory open 실패는 본인 lock만 정리한다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  const fsImpl = Object.create(fs.promises);
  fsImpl.open = async (target, ...args) => {
    if (target === fixture.lockDir) throw Object.assign(new Error("open failed"), { code: "EIO" });
    return fs.promises.open(target, ...args);
  };
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fsImpl,
    fetchImpl: async () => assert.fail("부분 획득 실패 뒤 요청하지 않아야 합니다."),
  });

  await assert.rejects(client.fetchBadges(), { code: "KIMI_USAGE_LOCK" });
  assert.equal(fs.existsSync(fixture.lockDir), false);
});

test("lock 초기화 실패 사이에 교체된 다른 owner lock은 정리하지 않는다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  const fsImpl = Object.create(fs.promises);
  let replacementIdentity = null;
  fsImpl.open = async (target, ...args) => {
    if (target !== fixture.lockDir) return fs.promises.open(target, ...args);
    await fs.promises.rm(fixture.lockDir, { recursive: true, force: true });
    await fs.promises.mkdir(fixture.lockDir);
    replacementIdentity = await fs.promises.stat(fixture.lockDir);
    throw Object.assign(new Error("open failed"), { code: "EIO" });
  };
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fsImpl,
    fetchImpl: async () => assert.fail("교체된 lock 뒤 요청하지 않아야 합니다."),
  });

  await assert.rejects(client.fetchBadges(), { code: "KIMI_USAGE_LOCK" });
  const remaining = await fs.promises.stat(fixture.lockDir);
  assert.equal(remaining.dev, replacementIdentity.dev);
  assert.equal(remaining.ino, replacementIdentity.ino);
});

test("lock stat의 일시 실패도 먼저 확보한 inode로 본인 orphan을 정리한다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  const fsImpl = Object.create(fs.promises);
  let failed = false;
  fsImpl.open = async (target, ...args) => {
    const handle = await fs.promises.open(target, ...args);
    if (target !== fixture.lockDir) return handle;
    return {
      stat: (...methodArgs) => {
        if (!failed) {
          failed = true;
          throw Object.assign(new Error("stat failed"), { code: "EIO" });
        }
        return handle.stat(...methodArgs);
      },
      utimes: (...methodArgs) => handle.utimes(...methodArgs),
      close: (...methodArgs) => handle.close(...methodArgs),
    };
  };
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fsImpl,
    fetchImpl: async () => assert.fail("부분 획득 실패 뒤 요청하지 않아야 합니다."),
  });

  await assert.rejects(client.fetchBadges(), { code: "KIMI_USAGE_LOCK" });
  assert.equal(fs.existsSync(fixture.lockDir), false);
});

test("lock 초기 path stat이 두 번 실패하면 현재 inode를 뒤늦게 소유 증거로 채택하지 않는다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  const fsImpl = Object.create(fs.promises);
  let lockStatCalls = 0;
  let lockRmdirCalls = 0;
  fsImpl.stat = async (target, ...args) => {
    if (target === fixture.lockDir) {
      lockStatCalls += 1;
      if (lockStatCalls <= 2) {
        throw Object.assign(new Error("initial stat failed"), { code: "EIO" });
      }
    }
    return fs.promises.stat(target, ...args);
  };
  fsImpl.rmdir = async (target, ...args) => {
    if (target === fixture.lockDir) lockRmdirCalls += 1;
    return fs.promises.rmdir(target, ...args);
  };
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fsImpl,
    fetchImpl: async () => assert.fail("소유 증거 없는 lock 실패 뒤 요청하지 않아야 합니다."),
  });

  await assert.rejects(client.fetchBadges(), { code: "KIMI_USAGE_LOCK" });
  assert.equal(lockStatCalls, 2);
  assert.equal(lockRmdirCalls, 0);
  assert.equal(fs.existsSync(fixture.lockDir), true);
});

test("release final heartbeat 실패도 소유 lock 정리를 건너뛰지 않는다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 });
  const fsImpl = Object.create(fs.promises);
  fsImpl.open = async (target, ...args) => {
    const handle = await fs.promises.open(target, ...args);
    if (target !== fixture.lockDir) return handle;
    return {
      stat: (...methodArgs) => handle.stat(...methodArgs),
      utimes: () => { throw Object.assign(new Error("heartbeat failed"), { code: "EIO" }); },
      close: (...methodArgs) => handle.close(...methodArgs),
    };
  };
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fsImpl,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    fetchImpl: async (url) => url.includes("/api/oauth/token")
      ? jsonResponse({ access_token: "new", expires_in: 3600 })
      : jsonResponse({ usage: { used: 0, limit: 1 } }),
  });

  await client.fetchBadges();
  assert.equal(fs.existsSync(fixture.lockDir), false);
});

test("401 뒤 파일의 access token이 바뀌면 갱신 없이 한 번 재시도한다", async (t) => {
  const fixture = credentialFixture(t);
  const authorizations = [];
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fetchImpl: async (_url, options) => {
      authorizations.push(options.headers.Authorization);
      if (authorizations.length === 1) {
        const rotated = { ...COMPLETE_CREDENTIALS, access_token: "access-b" };
        fs.writeFileSync(fixture.file, `${JSON.stringify(rotated)}\n`, { mode: 0o600 });
        return jsonResponse({ message: "access-a" }, 401);
      }
      return jsonResponse({ usage: { used: 3, limit: 10 } });
    },
  });

  assert.deepEqual(await client.fetchBadges(), [
    { key: "7d", remainingPercent: 70, ariaLabel: "Kimi 7일 70% 남음" },
  ]);
  assert.deepEqual(authorizations, ["Bearer access-a", "Bearer access-b"]);
});

test("401·403은 같은 access token이어도 lock 안에서 강제 갱신하고 한 번만 재시도한다", async (t) => {
  for (const status of [401, 403]) {
    const fixture = credentialFixture(t);
    const requests = [];
    const client = new KimiUsageClient({
      homeDir: fixture.home,
      nowSeconds: () => 1000,
      fetchImpl: async (url, options) => {
        requests.push({ url, authorization: options.headers.Authorization });
        if (url.includes("/api/oauth/token")) {
          return jsonResponse({ access_token: `access-${status}`, expires_in: 3600 });
        }
        if (requests.filter((request) => request.url.includes("/usages")).length === 1) {
          return jsonResponse({ message: "민감한 서버 본문" }, status);
        }
        return jsonResponse({ usage: { used: 2, limit: 10 } });
      },
    });

    assert.equal((await client.fetchBadges())[0].remainingPercent, 80);
    assert.deepEqual(
      requests.map(({ url }) => url.includes("/api/oauth/token") ? "refresh" : "usage"),
      ["usage", "refresh", "usage"]
    );
    assert.equal(fs.existsSync(fixture.lockDir), false);
  }
});

test("강제 갱신 뒤에도 403이면 추가 갱신 없이 인증 오류로 끝낸다", async (t) => {
  const fixture = credentialFixture(t);
  let usageCalls = 0;
  let refreshCalls = 0;
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fetchImpl: async (url) => {
      if (url.includes("/api/oauth/token")) {
        refreshCalls += 1;
        return jsonResponse({ access_token: "access-refreshed", expires_in: 3600 });
      }
      usageCalls += 1;
      return jsonResponse({ message: "노출 금지" }, 403);
    },
  });

  await assert.rejects(client.fetchBadges(), { code: "KIMI_USAGE_AUTH" });
  assert.equal(refreshCalls, 1);
  assert.equal(usageCalls, 2);
});

test("Kimi 인증 실패와 잘못된 자격 파일은 민감값 없는 오류로 격리한다", async (t) => {
  const fixture = credentialFixture(t, {
    access_token: "secret-access",
    refresh_token: "secret-refresh",
  });
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fetchImpl: async () => jsonResponse({ message: "secret-access" }, 401),
  });
  await assert.rejects(client.fetchBadges(), (error) => {
    assert.equal(error.code, "KIMI_USAGE_AUTH");
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });

  fs.writeFileSync(fixture.file, JSON.stringify({
    ...COMPLETE_CREDENTIALS,
    access_token: "still-secret",
    expires_at: "5000",
  }));
  await assert.rejects(client.fetchBadges(), (error) => {
    assert.equal(error.code, "KIMI_USAGE_AUTH");
    assert.doesNotMatch(error.message, /still-secret|5000/);
    return true;
  });
});

test("refresh token을 회전하지 않은 응답은 기존 값과 여섯 snake_case 필드만 보존한다", async (t) => {
  const fixture = credentialFixture(t, {
    access_token: "old",
    expires_at: 1001,
    ignored_identity: "private-user",
  });
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fetchImpl: async (url) => url.includes("/api/oauth/token")
      ? jsonResponse({ access_token: "new", expires_in: 1200 })
      : jsonResponse({ usage: { used: 0, limit: 1 } }),
  });

  await client.fetchBadges();
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file, "utf8")), {
    access_token: "new",
    refresh_token: "refresh-a",
    expires_at: 2200,
    scope: "openid",
    token_type: "Bearer",
    expires_in: 1200,
  });
});

test("device_id가 없으면 새 장치 identity를 만들지 않는다", async (t) => {
  const fixture = credentialFixture(t, { access_token: "old", expires_at: 1001 }, { deviceId: null });
  let refreshHeaders;
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    fetchImpl: async (url, options) => {
      if (url.includes("/api/oauth/token")) {
        refreshHeaders = options.headers;
        return jsonResponse({ access_token: "new", expires_in: 3600 });
      }
      return jsonResponse({ usage: { used: 0, limit: 1 } });
    },
  });

  await client.fetchBadges();
  assert.equal(refreshHeaders["X-Msh-Device-Id"], undefined);
  assert.equal(fs.existsSync(path.join(fixture.home, "device_id")), false);
});

test("timeout·network·429·5xx 오류는 응답 본문 없는 안정된 코드로 변환한다", async (t) => {
  const fixture = credentialFixture(t);
  const cases = [
    ["KIMI_USAGE_TIMEOUT", (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("secret-timeout"), { name: "AbortError" })));
    }), 10],
    ["KIMI_USAGE_NETWORK", async () => { throw new Error("secret-network"); }],
    ["KIMI_USAGE_RATE_LIMIT", async () => jsonResponse({ message: "secret-rate" }, 429)],
    ["KIMI_USAGE_SERVER", async () => jsonResponse({ message: "secret-server" }, 503)],
  ];

  for (const [code, fetchImpl, timeoutMs] of cases) {
    const client = new KimiUsageClient({
      homeDir: fixture.home,
      nowSeconds: () => 1000,
      fetchImpl,
      timeoutMs,
    });
    await assert.rejects(client.fetchBadges(), (error) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  }
});

test("응답 JSON 본문을 읽는 동안에도 timeout을 유지한다", async (t) => {
  const fixture = credentialFixture(t);
  const client = new KimiUsageClient({
    homeDir: fixture.home,
    nowSeconds: () => 1000,
    timeoutMs: 10,
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("secret-body"), { name: "AbortError" }));
        });
      }),
    }),
  });

  const guard = new Promise((resolve) => setTimeout(resolve, 50, "본문 timeout이 동작하지 않았습니다."));
  await assert.rejects(Promise.race([client.fetchBadges(), guard]), (error) => {
    assert.equal(error.code, "KIMI_USAGE_TIMEOUT");
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});
