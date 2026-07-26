const ENGINE_STATES = Object.freeze([
  "stopped",
  "starting",
  "ready",
  "draining",
  "failed",
]);

class EngineHostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EngineHostError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, name) {
  if (!isPlainObject(value)) {
    throw new EngineHostError("ENGINE_INVALID_ARGUMENT", `${name} must be a plain object`);
  }
  return value;
}

function sanitizeErrorMessage(value) {
  return String(value || "OpenCodex engine error")
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|api[_-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .slice(0, 500);
}

function serializeEngineError(error, fallbackCode = "ENGINE_WORKER_ERROR") {
  const code = typeof error?.code === "string" && /^ENGINE_[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : fallbackCode;
  return {
    code,
    message: sanitizeErrorMessage(error?.message || error),
  };
}

function errorFromReply(value) {
  const serialized = serializeEngineError(value);
  return new EngineHostError(serialized.code, serialized.message);
}

function validateWorkerMessage(value) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.id) || typeof value.ok !== "boolean") {
    throw new EngineHostError("ENGINE_PROTOCOL_ERROR", "invalid OpenCodex worker reply");
  }
  if (!value.ok && !isPlainObject(value.error)) {
    throw new EngineHostError("ENGINE_PROTOCOL_ERROR", "missing OpenCodex worker error");
  }
  return value;
}

module.exports = {
  ENGINE_STATES,
  EngineHostError,
  errorFromReply,
  requirePlainObject,
  sanitizeErrorMessage,
  serializeEngineError,
  validateWorkerMessage,
};
