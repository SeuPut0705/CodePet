"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExternalWatcher, messageText, readBytes, text } = require("./external-watcher");
const {
  normalizeReasoningLabel,
  normalizeWorkerLabel,
  safeSectionLabel,
} = require("./activity-labels");

const DEFAULT_KIMI_ROOT = path.join(os.homedir(), ".kimi-code", "sessions");
const KIMI_POLL_MS = 1800;
const KIMI_QUIET_MS = 5 * 60 * 1000;
const KIMI_SESSION_LIMIT = 20;

const READ_TOOLS = new Set(["Read", "ReadMediaFile"]);
const SEARCH_TOOLS = new Set(["Glob", "Grep"]);
const PATCH_TOOLS = new Set(["Edit", "Write"]);

function directoryEntries(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function sessionRootFromWire(file) {
  return path.dirname(path.dirname(path.dirname(file)));
}

function agentIdFromWire(file) {
  return path.basename(path.dirname(file));
}

function readKimiSessionMetadata(file) {
  const sessionRoot = sessionRootFromWire(file);
  const sessionId = path.basename(sessionRoot);
  try {
    const state = JSON.parse(fs.readFileSync(path.join(sessionRoot, "state.json"), "utf8"));
    const cwd = typeof state.workDir === "string" ? state.workDir : null;
    const title = typeof state.title === "string" && state.title.trim()
      ? state.title
      : cwd
        ? path.basename(cwd)
        : null;
    return { sessionId, sectionLabel: safeSectionLabel(title), cwd };
  } catch {
    return { sessionId, sectionLabel: null, cwd: null };
  }
}

function findKimiWireFiles(root, limit = KIMI_SESSION_LIMIT) {
  const sessions = [];
  for (const workspace of directoryEntries(root)) {
    if (!workspace.isDirectory()) continue;
    const workspacePath = path.join(root, workspace.name);
    for (const entry of directoryEntries(workspacePath)) {
      if (!entry.isDirectory() || !entry.name.startsWith("session_")) continue;
      const sessionRoot = path.join(workspacePath, entry.name);
      const mainWire = path.join(sessionRoot, "agents", "main", "wire.jsonl");
      try {
        sessions.push({ sessionRoot, mtimeMs: fs.statSync(mainWire).mtimeMs });
      } catch {
        // 아직 main wire가 완성되지 않은 세션은 다음 poll에서 다시 찾습니다.
      }
    }
  }

  return sessions
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .flatMap(({ sessionRoot }) => {
      const agentsRoot = path.join(sessionRoot, "agents");
      return directoryEntries(agentsRoot).flatMap((agent) => {
        if (!agent.isDirectory()) return [];
        const wire = path.join(agentsRoot, agent.name, "wire.jsonl");
        try {
          return fs.statSync(wire).isFile() ? [wire] : [];
        } catch {
          return [];
        }
      });
    });
}

function normalizeKimiTool(event) {
  const name = String(event?.name || "");
  const detail = text(event?.description || event?.display?.prompt || name);
  const kind = PATCH_TOOLS.has(name)
    ? "patch"
    : SEARCH_TOOLS.has(name)
      ? "search"
      : READ_TOOLS.has(name)
        ? "read"
        : "command";
  return { kind, text: detail || "명령 실행" };
}

function kimiEventId(row, event) {
  const source = event?.uuid || event?.toolCallId || [
    row.time,
    row.type,
    event?.type,
    event?.turnId,
    event?.step,
  ].join("\u0000");
  return crypto.createHash("sha1").update(String(source)).digest("hex").slice(0, 16);
}

function parseKimiRow(row, file, metadata = readKimiSessionMetadata(file)) {
  const agentId = agentIdFromWire(file);
  const common = {
    sessionId: metadata.sessionId,
    cwd: metadata.cwd,
    sectionLabel: metadata.sectionLabel,
    agentId,
    isSubagent: agentId !== "main",
  };

  if (row.type === "turn.prompt" && row.origin?.kind === "user") {
    const visible = Array.isArray(row.input)
      ? row.input
        .filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("\n\n")
      : "";
    return visible
      ? { ...common, type: "user", text: messageText(visible), eventId: kimiEventId(row) }
      : null;
  }

  if (row.type === "llm.request") {
    return {
      ...common,
      type: "context",
      eventId: kimiEventId(row),
      workerLabel: normalizeWorkerLabel(row.modelAlias || row.model),
      reasoningLabel: normalizeReasoningLabel(row.thinkingEffort),
    };
  }

  if (row.type !== "context.append_loop_event" || !row.event) return null;
  const event = row.event;
  const lifecycle = {
    ...common,
    eventId: kimiEventId(row, event),
    turnId: event.turnId,
    step: event.step,
  };

  if (event.type === "content.part") {
    if (event.part?.type !== "text" || !event.part.text) return null;
    return {
      ...lifecycle,
      type: "assistant",
      text: messageText(event.part.text),
      chunk: true,
    };
  }
  if (event.type === "tool.call") {
    return { ...lifecycle, type: "tool", ...normalizeKimiTool(event) };
  }
  if (event.type === "step.begin") {
    return { ...lifecycle, type: "lifecycle", active: true, finished: false };
  }
  if (event.type === "step.end") {
    const done = event.finishReason === "end_turn";
    return {
      ...lifecycle,
      type: "lifecycle",
      active: !done,
      finished: !common.isSubagent && done,
    };
  }
  return null;
}

function inferKimiSubagentActive(file, maxBytes = 256 * 1024) {
  let source;
  try {
    const size = fs.statSync(file).size;
    const offset = Math.max(0, size - maxBytes);
    source = readBytes(file, offset, size).toString("utf8");
  } catch {
    return false;
  }

  let active = false;
  for (const line of source.split("\n")) {
    try {
      const row = JSON.parse(line);
      const event = row.type === "context.append_loop_event" ? row.event : null;
      if (event?.type === "step.begin") active = true;
      if (event?.type === "step.end") active = event.finishReason !== "end_turn";
    } catch {
      // tail 첫 조각과 불완전 마지막 행은 무시합니다.
    }
  }
  return active;
}

class KimiWatcher extends ExternalWatcher {
  constructor(options = {}) {
    const roots = options.roots || [DEFAULT_KIMI_ROOT];
    const sessionLimit = options.sessionLimit || KIMI_SESSION_LIMIT;
    super({
      provider: "kimi",
      roots,
      findFiles: (root) => findKimiWireFiles(root, sessionLimit),
      parseRow: parseKimiRow,
      pollMs: options.pollMs || KIMI_POLL_MS,
      quietMs: options.quietMs || KIMI_QUIET_MS,
    });
    this.responseBuffers = new Map();
    this.lastResponses = new Map();
    this.activeSubagents = new Map();
    this.metadataCache = new Map();
    this.parseRow = (row, file) => parseKimiRow(row, file, this.metadataFor(file));
  }

  metadataFor(file) {
    const sessionRoot = sessionRootFromWire(file);
    const stateFile = path.join(sessionRoot, "state.json");
    let mtimeMs = null;
    try {
      mtimeMs = fs.statSync(stateFile).mtimeMs;
    } catch {
      // readKimiSessionMetadata가 안전한 fallback을 만듭니다.
    }
    const cached = this.metadataCache.get(sessionRoot);
    if (cached && cached.mtimeMs === mtimeMs) return cached.metadata;
    const metadata = readKimiSessionMetadata(file);
    this.metadataCache.set(sessionRoot, { mtimeMs, metadata });
    return metadata;
  }

  activeSet(sessionId) {
    let active = this.activeSubagents.get(sessionId);
    if (!active) {
      active = new Set();
      this.activeSubagents.set(sessionId, active);
    }
    return active;
  }

  subagentCount(sessionId) {
    return this.activeSubagents.get(sessionId)?.size || 0;
  }

  updateSubagent(event, now) {
    if (event.type !== "lifecycle") return;
    const active = this.activeSet(event.sessionId);
    const previous = active.size;
    if (event.active) active.add(event.agentId);
    else active.delete(event.agentId);
    const next = active.size;
    if (next === 0) this.activeSubagents.delete(event.sessionId);
    if (previous === next || !this.sessions.has(`kimi:${event.sessionId}`)) return;
    super.accept(
      {
        sessionId: event.sessionId,
        eventId: `subagent:${event.eventId}:${next}`,
        type: "context",
        cwd: event.cwd,
        sectionLabel: event.sectionLabel,
        subagentCount: next,
      },
      now
    );
  }

  accept(event, now) {
    if (!event) return;
    if (event.isSubagent) {
      this.updateSubagent(event, now);
      return;
    }

    const enriched = { ...event, subagentCount: this.subagentCount(event.sessionId) };
    if (event.type === "assistant" && event.chunk) {
      const key = `${event.sessionId}:${event.turnId}:${event.step}`;
      const accumulated = messageText(
        [this.responseBuffers.get(key), event.text].filter(Boolean).join("\n\n")
      );
      this.responseBuffers.set(key, accumulated);
      this.lastResponses.set(event.sessionId, accumulated);
      enriched.text = accumulated;
    }
    if (event.finished) enriched.text = this.lastResponses.get(event.sessionId) || event.text || "";
    super.accept(enriched, now);
  }

  seed() {
    this.activeSubagents.clear();
    for (const file of this.files()) {
      const agentId = agentIdFromWire(file);
      if (agentId === "main" || !inferKimiSubagentActive(file)) continue;
      this.activeSet(readKimiSessionMetadata(file).sessionId).add(agentId);
    }
    super.seed();
  }

  clearSession(sessionId) {
    this.activeSubagents.delete(sessionId);
    this.lastResponses.delete(sessionId);
    for (const key of this.responseBuffers.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.responseBuffers.delete(key);
    }
  }

  finish(id, reason, message = "") {
    const sessionId = id.startsWith("kimi:") ? id.slice("kimi:".length) : id;
    this.clearSession(sessionId);
    super.finish(id, reason, message);
  }

  stop() {
    this.responseBuffers.clear();
    this.lastResponses.clear();
    this.activeSubagents.clear();
    this.metadataCache.clear();
    super.stop();
  }
}

module.exports = {
  DEFAULT_KIMI_ROOT,
  KimiWatcher,
  KIMI_POLL_MS,
  KIMI_QUIET_MS,
  KIMI_SESSION_LIMIT,
  agentIdFromWire,
  findKimiWireFiles,
  inferKimiSubagentActive,
  normalizeKimiTool,
  parseKimiRow,
  readKimiSessionMetadata,
  sessionRootFromWire,
};
