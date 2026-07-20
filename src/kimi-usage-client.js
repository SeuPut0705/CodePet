"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildKimiUsageBadges } = require("./kimi-usage");

const DEFAULT_KIMI_HOME = path.join(os.homedir(), ".kimi-code");
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const LOCK_RETRY_MS = 25;
const LOCK_UPDATE_MS = 2000;

class KimiUsageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KimiUsageError";
    this.code = code;
  }
}

function usageError(code) {
  const messages = {
    KIMI_USAGE_AUTH: "Kimi 로그인 정보가 없거나 만료됐습니다.",
    KIMI_USAGE_LOCK: "Kimi 로그인 정보 갱신을 잠시 후 다시 시도해 주세요.",
    KIMI_USAGE_TIMEOUT: "Kimi 사용량 요청 시간이 초과됐습니다.",
    KIMI_USAGE_NETWORK: "Kimi 사용량 서버에 연결하지 못했습니다.",
    KIMI_USAGE_RATE_LIMIT: "Kimi 사용량 요청 제한에 도달했습니다.",
    KIMI_USAGE_SERVER: "Kimi 사용량 서버가 일시적으로 응답하지 않습니다.",
    KIMI_USAGE_UNAVAILABLE: "현재 Kimi 사용량 조회를 지원하지 않습니다.",
    KIMI_USAGE_RESPONSE: "Kimi 사용량 응답을 처리하지 못했습니다.",
  };
  return new KimiUsageError(code, messages[code] || messages.KIMI_USAGE_RESPONSE);
}

function validString(value, { empty = false } = {}) {
  return typeof value === "string" && (empty || value.length > 0);
}

function validNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseCredentials(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!validString(raw.access_token)) return null;
  if (!validString(raw.refresh_token, { empty: true })) return null;
  if (!validNumber(raw.expires_at)) return null;
  if (!validString(raw.scope, { empty: true })) return null;
  if (!validString(raw.token_type)) return null;
  if (!validNumber(raw.expires_in)) return null;
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_at: raw.expires_at,
    scope: raw.scope,
    token_type: raw.token_type,
    expires_in: raw.expires_in,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function mapStatus(status) {
  if (status === 401 || status === 403 || status === 400) return usageError("KIMI_USAGE_AUTH");
  if (status === 404) return usageError("KIMI_USAGE_UNAVAILABLE");
  if (status === 429) return usageError("KIMI_USAGE_RATE_LIMIT");
  if (status >= 500) return usageError("KIMI_USAGE_SERVER");
  return usageError("KIMI_USAGE_RESPONSE");
}

class KimiUsageClient {
  constructor({
    homeDir = process.env.KIMI_CODE_HOME || DEFAULT_KIMI_HOME,
    fetchImpl = fetch,
    nowSeconds = () => Math.floor(Date.now() / 1000),
    nowMilliseconds = () => Date.now(),
    sleepImpl = delay,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    fsImpl = fs.promises,
    timeoutMs = 8000,
  } = {}) {
    this.homeDir = homeDir;
    this.fetchImpl = fetchImpl;
    this.nowSeconds = nowSeconds;
    this.nowMilliseconds = nowMilliseconds;
    this.sleep = sleepImpl;
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.fs = fsImpl;
    this.timeoutMs = timeoutMs;
    this.credentialFile = path.join(homeDir, "credentials", "kimi-code.json");
    this.deviceFile = path.join(homeDir, "device_id");
    this.lockDir = path.join(homeDir, "oauth", "kimi-code.lock");
  }

  async fetchBadges() {
    let credentials = await this.readCredentials();
    credentials = await this.ensureFresh(credentials);

    let result = await this.request(KIMI_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        Accept: "application/json",
      },
    }, { allowAuthStatus: true });

    if (result.status === 401 || result.status === 403) {
      credentials = await this.recoverFromAuthFailure(credentials);
      result = await this.request(KIMI_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
          Accept: "application/json",
        },
      }, { allowAuthStatus: true });
      if (result.status === 401 || result.status === 403) throw usageError("KIMI_USAGE_AUTH");
    }
    return buildKimiUsageBadges(result.payload);
  }

  async readCredentials() {
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.credentialFile, "utf8"));
      const credentials = parseCredentials(parsed);
      if (credentials) return credentials;
    } catch {}
    throw usageError("KIMI_USAGE_AUTH");
  }

  shouldRefresh(credentials) {
    const threshold = Math.max(300, credentials.expires_in * 0.5);
    return credentials.expires_at - this.nowSeconds() < threshold;
  }

  async ensureFresh(credentials) {
    if (!this.shouldRefresh(credentials)) return credentials;
    const release = await this.acquireLock();
    try {
      const reloaded = await this.readCredentials();
      if (!this.shouldRefresh(reloaded)) return reloaded;
      if (!reloaded.refresh_token) throw usageError("KIMI_USAGE_AUTH");
      const refreshed = await this.refresh(reloaded);
      await this.writeCredentials(refreshed);
      return refreshed;
    } finally {
      await release();
    }
  }

  async recoverFromAuthFailure(rejectedCredentials) {
    const release = await this.acquireLock();
    try {
      const reloaded = await this.readCredentials();
      if (
        reloaded.access_token !== rejectedCredentials.access_token &&
        !this.shouldRefresh(reloaded)
      ) {
        return reloaded;
      }
      if (!reloaded.refresh_token) throw usageError("KIMI_USAGE_AUTH");
      const refreshed = await this.refresh(reloaded);
      await this.writeCredentials(refreshed);
      return refreshed;
    } finally {
      await release();
    }
  }

  async refresh(credentials) {
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "X-Msh-Platform": "kimi_code_cli",
    };
    const deviceId = await this.readDeviceId();
    if (deviceId) headers["X-Msh-Device-Id"] = deviceId;
    const result = await this.request(KIMI_TOKEN_URL, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        client_id: KIMI_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: credentials.refresh_token,
      }).toString(),
    });
    const payload = result.payload;
    const expiresIn = payload?.expires_in;
    if (!validString(payload?.access_token) || !validNumber(expiresIn) || expiresIn <= 0) {
      throw usageError("KIMI_USAGE_RESPONSE");
    }
    const refreshToken = validString(payload.refresh_token) ? payload.refresh_token : credentials.refresh_token;
    return {
      access_token: payload.access_token,
      refresh_token: refreshToken,
      expires_at: this.nowSeconds() + expiresIn,
      scope: typeof payload.scope === "string" ? payload.scope : credentials.scope,
      token_type: validString(payload.token_type) ? payload.token_type : credentials.token_type,
      expires_in: expiresIn,
    };
  }

  async request(url, options, { allowAuthStatus = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, { ...options, signal: controller.signal });
      if (!response || typeof response.status !== "number") throw usageError("KIMI_USAGE_RESPONSE");
      const allowedAuthFailure = allowAuthStatus && [401, 403].includes(response.status);
      if (!response.ok && !allowedAuthFailure) throw mapStatus(response.status);
      if (allowedAuthFailure) return { status: response.status };
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") throw error;
        throw usageError("KIMI_USAGE_RESPONSE");
      }
      return { status: response.status, payload };
    } catch (error) {
      if (error instanceof KimiUsageError) throw error;
      if (controller.signal.aborted || error?.name === "AbortError") throw usageError("KIMI_USAGE_TIMEOUT");
      throw usageError("KIMI_USAGE_NETWORK");
    } finally {
      clearTimeout(timer);
    }
  }

  async readDeviceId() {
    try {
      const value = (await this.fs.readFile(this.deviceFile, "utf8")).trim();
      return value || null;
    } catch {
      return null;
    }
  }

  async acquireLock() {
    await this.fs.mkdir(path.dirname(this.lockDir), { recursive: true });
    const deadline = this.nowMilliseconds() + this.timeoutMs;
    while (true) {
      try {
        await this.fs.mkdir(this.lockDir);
      } catch (error) {
        if (error?.code !== "EEXIST") throw usageError("KIMI_USAGE_LOCK");

        const remaining = deadline - this.nowMilliseconds();
        if (remaining <= 0) throw usageError("KIMI_USAGE_LOCK");
        await this.sleep(Math.min(LOCK_RETRY_MS, remaining));
        continue;
      }

      let directoryHandle = null;
      let owner = null;
      try {
        // mkdir 직후 inode를 먼저 확보해야 이후 open/stat 실패나 경로 교체가 있어도
        // 우리가 만든 directory만 정리할 수 있습니다.
        for (let attempt = 0; attempt < 2 && !owner; attempt += 1) {
          try {
            owner = await this.fs.stat(this.lockDir);
          } catch {}
        }
        if (!owner) throw usageError("KIMI_USAGE_LOCK");
        directoryHandle = await this.fs.open(this.lockDir, "r");
        const openedOwner = await directoryHandle.stat();
        if (!sameIdentity(owner, openedOwner)) throw usageError("KIMI_USAGE_LOCK");
        return this.maintainLock(owner, directoryHandle);
      } catch {
        await this.cleanupOwnedLock({ owner, directoryHandle });
        throw usageError("KIMI_USAGE_LOCK");
      }
    }
  }

  async cleanupOwnedLock({ owner, directoryHandle }) {
    try {
      let capturedOwner = owner;
      if (!capturedOwner && directoryHandle) {
        try {
          capturedOwner = await directoryHandle.stat();
        } catch {}
      }
      if (!capturedOwner) {
        try {
          capturedOwner = await this.fs.stat(this.lockDir);
        } catch {
          return false;
        }
      }

      const before = await this.fs.stat(this.lockDir);
      if (!sameIdentity(capturedOwner, before)) return false;
      await this.fs.rmdir(this.lockDir);
      return true;
    } catch {
      return false;
    } finally {
      try {
        await directoryHandle?.close();
      } catch {}
    }
  }

  maintainLock(owner, directoryHandle) {
    let releaseStarted = false;
    const heartbeat = this.setInterval(async () => {
      const now = new Date(this.nowMilliseconds());
      try {
        await directoryHandle.utimes(now, now);
      } catch {}
    }, LOCK_UPDATE_MS);
    heartbeat.unref?.();

    return async () => {
      if (releaseStarted) return;
      releaseStarted = true;
      try {
        const now = new Date(this.nowMilliseconds());
        try {
          await directoryHandle.utimes(now, now);
        } catch {
          // 마지막 heartbeat 실패와 lock 소유권 정리는 별개로 수행합니다.
        }
        await this.cleanupOwnedLock({ owner, directoryHandle });
      } finally {
        this.clearInterval(heartbeat);
      }
    };
  }

  async writeCredentials(credentials) {
    await this.fs.mkdir(path.dirname(this.credentialFile), { recursive: true });
    const temp = path.join(
      path.dirname(this.credentialFile),
      `.${path.basename(this.credentialFile)}.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    let handle;
    try {
      handle = await this.fs.open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fs.rename(temp, this.credentialFile);
    } catch (error) {
      try {
        await handle?.close();
      } catch {}
      try {
        await this.fs.rm(temp, { force: true });
      } catch {}
      if (error instanceof KimiUsageError) throw error;
      throw usageError("KIMI_USAGE_AUTH");
    }
  }
}

module.exports = { KimiUsageClient, KimiUsageError };
