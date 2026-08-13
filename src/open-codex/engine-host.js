const path = require("node:path");
const { Worker } = require("node:worker_threads");

const {
  EngineHostError,
  errorFromReply,
  requirePlainObject,
  validateWorkerMessage,
} = require("./engine-interface");

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function requireTimeout(value, name, fallback) {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout < 1) {
    throw new EngineHostError("ENGINE_INVALID_ARGUMENT", `${name} must be a positive number`);
  }
  return timeout;
}

function createEngineHost({
  workerPath = path.join(__dirname, "engine-worker.js"),
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  workerData,
  workerEnv,
} = {}) {
  if (typeof workerPath !== "string" || workerPath.length === 0) {
    throw new EngineHostError("ENGINE_INVALID_ARGUMENT", "workerPath must be a non-empty string");
  }
  const startupTimeout = requireTimeout(startupTimeoutMs, "startupTimeoutMs", DEFAULT_STARTUP_TIMEOUT_MS);
  const requestTimeout = requireTimeout(requestTimeoutMs, "requestTimeoutMs", DEFAULT_REQUEST_TIMEOUT_MS);

  let state = "stopped";
  let worker = null;
  let nextRequestId = 1;
  let startPromise = null;
  let lastStatus = null;
  const pending = new Map();
  const expectedExits = new WeakSet();

  function localStatus() {
    return {
      activeTurns: lastStatus?.activeTurns ?? 0,
      draining: state === "draining" || Boolean(lastStatus?.draining),
      port: lastStatus?.port ?? null,
      running: state === "ready" || state === "draining",
      state,
    };
  }

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function markWorkerFailed(target) {
    if (target !== worker || expectedExits.has(target)) return;
    worker = null;
    state = "failed";
    lastStatus = null;
    rejectPending(new EngineHostError("ENGINE_WORKER_EXITED", "OpenCodex engine worker exited unexpectedly"));
  }

  function attachWorker(target) {
    target.on("message", (message) => {
      let reply;
      try {
        reply = validateWorkerMessage(message);
      } catch (error) {
        state = "failed";
        lastStatus = null;
        rejectPending(error);
        void terminateWorker(target);
        return;
      }
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      clearTimeout(entry.timer);
      if (reply.ok) entry.resolve(reply.result);
      else entry.reject(errorFromReply(reply.error));
    });
    target.on("error", () => markWorkerFailed(target));
    target.on("exit", () => markWorkerFailed(target));
  }

  function spawnWorker() {
    let target;
    try {
      target = new Worker(workerPath, { workerData, env: workerEnv });
    } catch {
      state = "failed";
      throw new EngineHostError("ENGINE_WORKER_START_FAILED", "OpenCodex engine worker could not start");
    }
    worker = target;
    attachWorker(target);
    return target;
  }

  function request(type, payload, timeoutMs, timeoutCode = "ENGINE_REQUEST_TIMEOUT") {
    if (!worker) {
      return Promise.reject(new EngineHostError("ENGINE_NOT_RUNNING", "OpenCodex engine worker is not running"));
    }
    const target = worker;
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new EngineHostError(timeoutCode, `OpenCodex engine ${type} timed out`));
      }, timeoutMs);
      pending.set(id, { reject, resolve, timer });
      try {
        target.postMessage({ id, type, payload });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new EngineHostError("ENGINE_WORKER_SEND_FAILED", "OpenCodex engine request could not be sent"));
      }
    });
  }

  async function terminateWorker(target) {
    if (!target) return;
    expectedExits.add(target);
    if (worker === target) worker = null;
    rejectPending(new EngineHostError("ENGINE_WORKER_STOPPED", "OpenCodex engine worker stopped"));
    await target.terminate();
  }

  function withState(status, nextState = state) {
    lastStatus = status && typeof status === "object" ? { ...status } : null;
    return { ...localStatus(), ...lastStatus, state: nextState };
  }

  async function start(configuration = {}) {
    requirePlainObject(configuration, "configuration");
    if (state === "ready") return withState(lastStatus, "ready");
    if (state === "starting" && startPromise) return startPromise;
    if (state === "draining") {
      throw new EngineHostError("ENGINE_INVALID_STATE", "OpenCodex engine is draining");
    }

    state = "starting";
    const target = spawnWorker();
    startPromise = (async () => {
      try {
        const status = await request(
          "start",
          { configuration },
          startupTimeout,
          "ENGINE_START_TIMEOUT"
        );
        if (worker !== target) throw new EngineHostError("ENGINE_WORKER_EXITED", "OpenCodex engine worker exited unexpectedly");
        state = "ready";
        return withState(status, "ready");
      } catch (error) {
        if (worker === target) await terminateWorker(target);
        state = "failed";
        lastStatus = null;
        throw error;
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }

  async function getStatus() {
    if (!worker || state === "stopped" || state === "starting" || state === "failed") return localStatus();
    const status = await request("getStatus", {}, requestTimeout);
    if (status?.running === false) {
      const target = worker;
      await terminateWorker(target);
      state = "stopped";
      lastStatus = null;
      return { ...localStatus(), ...status, draining: false, port: null, running: false, state: "stopped" };
    }
    return withState(status);
  }

  async function getCapabilities() {
    if (!worker || (state !== "ready" && state !== "draining")) {
      throw new EngineHostError("ENGINE_INVALID_STATE", "OpenCodex engine is not ready");
    }
    return request("getCapabilities", {}, requestTimeout);
  }

  async function reload(configuration = {}) {
    requirePlainObject(configuration, "configuration");
    if (!worker || state !== "ready") {
      throw new EngineHostError("ENGINE_INVALID_STATE", "OpenCodex engine is not ready");
    }
    const status = await request("reload", { configuration }, requestTimeout);
    return withState(status, "ready");
  }

  async function quiesceAndStop(options = {}) {
    requirePlainObject(options, "options");
    const timeoutMs = requireTimeout(options.timeoutMs, "timeoutMs", 30_000);
    if (!worker || state === "stopped") {
      state = "stopped";
      lastStatus = null;
      return localStatus();
    }
    if (state !== "ready") {
      throw new EngineHostError("ENGINE_INVALID_STATE", `OpenCodex engine cannot stop from ${state}`);
    }
    const target = worker;
    state = "draining";
    try {
      const status = await request(
        "quiesceAndStop",
        { timeoutMs },
        timeoutMs,
        "ENGINE_DRAIN_TIMEOUT"
      );
      await terminateWorker(target);
      state = "stopped";
      lastStatus = null;
      return { ...localStatus(), ...status, draining: false, port: null, running: false, state: "stopped" };
    } catch (error) {
      if (worker === target) state = "ready";
      throw error;
    }
  }

  return {
    getCapabilities,
    getStatus,
    quiesceAndStop,
    reload,
    start,
  };
}

module.exports = { createEngineHost };
