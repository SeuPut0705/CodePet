"use strict";

const { spawn } = require("node:child_process");

const THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeThreadTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  return title ? [...title].slice(0, 80).join("") : null;
}

// Codex Desktop과 같은 app-server 계약으로 사이드바에 표시되는 작업 이름을 읽습니다.
// 조회 실패는 활동 말풍선을 막지 않고 기존 상태 제목으로 조용히 fallback합니다.
function readCodexThreadTitle(threadId, options = {}) {
  if (!THREAD_ID_PATTERN.test(threadId) || !options.command) return Promise.resolve(null);

  const spawnProcess = options.spawnProcess || spawn;
  const timeoutMs = options.timeoutMs ?? 3000;

  return new Promise((resolve) => {
    let child;
    let buffer = "";
    let settled = false;

    const finish = (title = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        // 이미 종료된 app-server는 정리할 필요가 없습니다.
      }
      resolve(normalizeThreadTitle(title));
    };

    let timer;
    try {
      child = spawnProcess(options.command, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        shell: Boolean(options.shell),
      });
    } catch {
      resolve(null);
      return;
    }

    timer = setTimeout(() => finish(), timeoutMs);
    timer.unref?.();

    const write = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish();
      }
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1) {
          write({ method: "initialized", params: {} });
          write({
            id: 2,
            method: "thread/read",
            params: { threadId, includeTurns: false },
          });
        } else if (message.id === 2) {
          const thread = message.result?.thread;
          finish(thread?.id === threadId ? thread.name : null);
        }
      }
    });
    child.once("error", () => finish());
    child.once("close", () => finish());

    write({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codepet", title: "CodePet", version: "0.3.2" },
      },
    });
  });
}

class CodexThreadTitleResolver {
  constructor({ loadTitle, ttlMs = 60_000, failureTtlMs = 5_000, now = Date.now } = {}) {
    this.loadTitle = typeof loadTitle === "function" ? loadTitle : async () => null;
    this.ttlMs = ttlMs;
    this.failureTtlMs = failureTtlMs;
    this.now = now;
    this.cache = new Map();
    this.inflight = new Map();
  }

  get(threadId) {
    const cached = this.cache.get(threadId);
    if (!cached || cached.expiresAt <= this.now()) {
      this.cache.delete(threadId);
      return null;
    }
    return cached.title;
  }

  async resolve(threadId) {
    if (!THREAD_ID_PATTERN.test(threadId)) return null;
    const cached = this.cache.get(threadId);
    if (cached && cached.expiresAt > this.now()) return cached.title;
    this.cache.delete(threadId);
    if (this.inflight.has(threadId)) return this.inflight.get(threadId);

    const request = Promise.resolve()
      .then(() => this.loadTitle(threadId))
      .then((value) => {
        const title = normalizeThreadTitle(value);
        const cacheTtlMs = title ? this.ttlMs : this.failureTtlMs;
        this.cache.set(threadId, { title, expiresAt: this.now() + cacheTtlMs });
        return title;
      })
      .catch(() => {
        this.cache.set(threadId, { title: null, expiresAt: this.now() + this.failureTtlMs });
        return null;
      })
      .finally(() => this.inflight.delete(threadId));
    this.inflight.set(threadId, request);
    return request;
  }
}

module.exports = { CodexThreadTitleResolver, readCodexThreadTitle };
