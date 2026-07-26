const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { parentPort, workerData } = require("node:worker_threads");

const {
  EngineHostError,
  requirePlainObject,
  serializeEngineError,
} = require("./engine-interface");

if (!parentPort) throw new Error("OpenCodex engine worker requires a parent port");

const enginePath = workerData?.enginePath
  ? path.resolve(workerData.enginePath)
  : path.resolve(__dirname, "..", "..", "build", "generated", "opencodex-engine.mjs");

let enginePromise;
let configuration = null;

function loadEngine() {
  if (!enginePromise) enginePromise = import(pathToFileURL(enginePath).href);
  return enginePromise;
}

function engineOptions(value) {
  const input = requirePlainObject(value || {}, "configuration");
  if (input.port !== undefined
    && (!Number.isInteger(input.port) || input.port < 0 || input.port > 65_535)) {
    throw new EngineHostError("ENGINE_INVALID_ARGUMENT", "configuration.port must be an integer from 0 to 65535");
  }
  return input.port === undefined ? {} : { port: input.port };
}

async function dispatch(type, payload) {
  const engine = await loadEngine();
  if (type === "start") {
    configuration = requirePlainObject(payload?.configuration || {}, "configuration");
    return engine.startEmbeddedEngine(engineOptions(configuration));
  }
  if (type === "getStatus") return engine.getEmbeddedEngineStatus();
  if (type === "getCapabilities") {
    return {
      lifecycle: ["start", "status", "quiesce-and-stop"],
      protocolVersion: 1,
      reload: "restart-required",
      transports: ["http", "websocket"],
    };
  }
  if (type === "reload") {
    const nextConfiguration = requirePlainObject(payload?.configuration || {}, "configuration");
    const currentPort = configuration?.port;
    if (nextConfiguration.port !== currentPort || Object.keys(nextConfiguration).some((key) => key !== "port")) {
      throw new EngineHostError(
        "ENGINE_RELOAD_REQUIRES_DRAIN",
        "OpenCodex configuration reload requires a drained restart"
      );
    }
    configuration = nextConfiguration;
    return engine.getEmbeddedEngineStatus();
  }
  if (type === "quiesceAndStop") {
    const timeoutMs = payload?.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
      throw new EngineHostError("ENGINE_INVALID_ARGUMENT", "timeoutMs must be a positive number");
    }
    const status = await engine.stopEmbeddedEngine({ timeoutMs });
    configuration = null;
    return status;
  }
  throw new EngineHostError("ENGINE_UNKNOWN_REQUEST", "unknown OpenCodex engine worker request");
}

parentPort.on("message", async (message) => {
  const id = message?.id;
  if (!Number.isSafeInteger(id) || typeof message?.type !== "string") return;
  try {
    const result = await dispatch(message.type, message.payload || {});
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: serializeEngineError(error) });
  }
});
