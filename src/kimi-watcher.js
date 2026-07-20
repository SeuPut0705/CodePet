"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { messageText, text } = require("./external-watcher");
const { normalizeReasoningLabel, normalizeWorkerLabel } = require("./activity-labels");

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
      ? state.title.trim()
      : cwd
        ? path.basename(cwd)
        : null;
    return { sessionId, sectionLabel: title, cwd };
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

module.exports = {
  DEFAULT_KIMI_ROOT,
  KIMI_POLL_MS,
  KIMI_QUIET_MS,
  KIMI_SESSION_LIMIT,
  agentIdFromWire,
  findKimiWireFiles,
  normalizeKimiTool,
  parseKimiRow,
  readKimiSessionMetadata,
  sessionRootFromWire,
};
