"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExternalWatcher, messageText, text } = require("./external-watcher");
const { projectLabelFromCwd } = require("./activity-labels");
const { redactActivityDetail } = require("./activity-redaction");
const { geminiUserDir } = require("./provider-client-discovery");

function contentText(content) {
  if (typeof content === "string") return messageText(content);
  if (!Array.isArray(content)) return "";
  return messageText(content
    .filter((part) => typeof part === "string" || typeof part?.text === "string")
    .map((part) => typeof part === "string" ? part : part.text)
    .join("\n\n"));
}

function geminiModelLabel(model) {
  const source = String(model || "").trim().toLowerCase();
  const match = source.match(/^gemini-(\d+(?:\.\d+)?)-(pro|flash)(?:-(lite))?(?:-preview)?$/);
  if (!match) return null;
  return `Gemini ${match[1]} ${match[2][0].toUpperCase()}${match[2].slice(1)}${match[3] ? " Lite" : ""}`;
}

function toolDetail(call) {
  const args = call?.args && typeof call.args === "object" ? call.args : {};
  return text(redactActivityDetail(
    args.command || args.file_path || args.path || args.pattern || args.query || args.directory || "",
  ), 220);
}

function toolKind(name) {
  const source = String(name || "");
  if (/write|replace|edit|patch/i.test(source)) return "patch";
  if (/search|grep|glob/i.test(source)) return "search";
  if (/read|list/i.test(source)) return "read";
  return "command";
}

function eventId(row) {
  return crypto.createHash("sha1").update(JSON.stringify({
    id: row?.id,
    type: row?.type,
    content: row?.content,
    toolCalls: row?.toolCalls?.map((call) => ({
      id: call?.id,
      name: call?.name,
      args: call?.args,
      status: call?.status,
    })),
    model: row?.model,
  })).digest("hex").slice(0, 16);
}

function parseGeminiRow(row, _file = "", metadata = {}) {
  if (!row) return null;
  const common = {
    sessionId: metadata.sessionId,
    cwd: metadata.cwd || null,
    sectionLabel: metadata.sectionLabel || projectLabelFromCwd(metadata.cwd, "Gemini"),
    clientKind: "cli",
    eventId: eventId(row),
  };

  const recordId = String(row.id || common.eventId);
  const toolCalls = Array.isArray(row.toolCalls) ? row.toolCalls.filter((call) => call?.name) : [];
  const visible = contentText(row.displayContent ?? row.content);
  if (metadata.kind === "subagent") {
    const childCommon = {
      ...common,
      sessionId: metadata.parentSessionId,
      childSessionId: metadata.childSessionId || metadata.sessionId,
      recordId,
      type: "subagent",
    };
    if (!childCommon.sessionId || !childCommon.childSessionId) return null;
    if (row.type === "user" || toolCalls.length > 0) {
      return { ...childCommon, action: "start", completionCandidate: false };
    }
    if (row.type === "gemini" && visible) {
      return { ...childCommon, action: "finish-candidate", completionCandidate: true };
    }
    return null;
  }

  if (row.type === "user") {
    return visible ? { ...common, type: "user", text: visible, finished: false, recordId } : null;
  }
  if (row.type !== "gemini") return null;

  const workerLabel = geminiModelLabel(row.model);
  const toolEvents = toolCalls.map((call, index) => {
    const detail = toolDetail(call);
    return {
      ...common,
      type: "tool",
      kind: toolKind(call.name),
      text: [text(call.displayName || call.name, 80), detail].filter(Boolean).join(": "),
      workerLabel,
      eventId: `${recordId}:tool:${call.id || index}`,
      finished: false,
    };
  });
  if (visible) {
    return {
      ...common,
      type: "assistant",
      text: visible,
      workerLabel,
      recordId,
      completionCandidate: toolCalls.length === 0,
      toolEvents,
      finished: false,
    };
  }

  if (!toolEvents.length) return null;
  return { ...toolEvents[0], recordId, completionCandidate: false, toolEvents };
}

function readFirstJsonLine(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, count).toString("utf8").split(/\r?\n/, 1)[0];
    return JSON.parse(line);
  } catch {
    return {};
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function projectPathForFile(file, geminiHome) {
  const relative = path.relative(path.join(geminiHome, "tmp"), file);
  const projectId = relative.split(path.sep)[0];
  if (!projectId || projectId === "..") return null;
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(geminiHome, "projects.json"), "utf8"));
    for (const [projectPath, id] of Object.entries(registry?.projects || {})) {
      if (id === projectId) return projectPath;
    }
  } catch {
    // 구버전이나 첫 실행에서는 registry가 없을 수 있습니다.
  }
  return null;
}

function readGeminiSessionMetadata(file, geminiHome) {
  const row = readFirstJsonLine(file);
  const cwd = projectPathForFile(file, geminiHome) ||
    (Array.isArray(row.directories) && typeof row.directories[0] === "string"
      ? row.directories[0]
      : null);
  const relativeParts = path.relative(path.join(geminiHome, "tmp"), file).split(path.sep);
  const nested = relativeParts.length >= 4 && relativeParts[1] === "chats";
  const kind = row.kind === "subagent" || nested ? "subagent" : "main";
  const parentSessionId = nested ? relativeParts[2] : null;
  return {
    sessionId: typeof row.sessionId === "string" && row.sessionId
      ? row.sessionId
      : path.basename(file, path.extname(file)),
    cwd,
    sectionLabel: projectLabelFromCwd(cwd, "Gemini"),
    kind,
    parentSessionId,
    childSessionId: kind === "subagent"
      ? (typeof row.sessionId === "string" && row.sessionId
          ? row.sessionId
          : path.basename(file, path.extname(file)))
      : null,
    clientKind: "cli",
  };
}

function findGeminiSessionFiles(root) {
  const files = [];
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const chatsDir = path.join(root, project.name, "chats");
    let chats;
    try {
      chats = fs.readdirSync(chatsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const chat of chats) {
      if (chat.isFile() && /^session-.*\.jsonl$/i.test(chat.name)) {
        files.push(path.join(chatsDir, chat.name));
        continue;
      }
      if (!chat.isDirectory()) continue;
      let children;
      try {
        children = fs.readdirSync(path.join(chatsDir, chat.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (child.isFile() && child.name.toLowerCase().endsWith(".jsonl")) {
          files.push(path.join(chatsDir, chat.name, child.name));
        }
      }
    }
  }
  return files.sort();
}

class GeminiWatcher extends ExternalWatcher {
  constructor(options = {}) {
    const geminiHome = options.homeDir || geminiUserDir({
      homeDir: os.homedir(),
      env: options.env || process.env,
    });
    const metadataCache = new Map();
    super({
      provider: "gemini",
      roots: options.roots || [path.join(geminiHome, "tmp")],
      findFiles: options.findFiles || findGeminiSessionFiles,
      parseRow: (row, file) => {
        let metadata = metadataCache.get(file);
        if (!metadata) {
          metadata = readGeminiSessionMetadata(file, geminiHome);
          metadataCache.set(file, metadata);
        }
        return parseGeminiRow(row, file, metadata);
      },
      pollMs: options.pollMs || 1800,
      quietMs: options.quietMs || 15000,
    });
    this.metadataCache = metadataCache;
    this.completionGraceMs = options.completionGraceMs || 800;
    this.pendingCompletions = new Map();
    this.subagents = new Map();
  }

  stop() {
    for (const pending of this.pendingCompletions.values()) clearTimeout(pending.timer);
    this.pendingCompletions.clear();
    this.subagents.clear();
    super.stop();
    this.metadataCache.clear();
  }

  completionKey(event, child = false) {
    return child
      ? `child:${event.sessionId}:${event.childSessionId}:${event.recordId}`
      : `main:${event.sessionId}:${event.recordId}`;
  }

  cancelCompletion(key) {
    const pending = this.pendingCompletions.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCompletions.delete(key);
  }

  cancelSessionCompletions(sessionId) {
    for (const [key, pending] of this.pendingCompletions) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pendingCompletions.delete(key);
    }
  }

  scheduleCompletion(event, { child = false } = {}) {
    const key = this.completionKey(event, child);
    this.cancelCompletion(key);
    const timer = setTimeout(() => {
      this.pendingCompletions.delete(key);
      if (child) {
        this.finishSubagent(event);
        return;
      }
      this.finish(`gemini:${event.sessionId}`, "done", event.text);
    }, this.completionGraceMs);
    timer.unref?.();
    this.pendingCompletions.set(key, { timer, sessionId: event.sessionId });
  }

  updateSubagent(event, now) {
    const eventKey = `gemini:${event.sessionId}:${event.childSessionId}:${event.eventId}`;
    if (!this.rememberEvent(eventKey)) return;
    const completionKey = this.completionKey(event, true);
    if (!event.completionCandidate) this.cancelCompletion(completionKey);
    let children = this.subagents.get(event.sessionId);
    if (!children) {
      children = new Set();
      this.subagents.set(event.sessionId, children);
    }
    const changed = !children.has(event.childSessionId);
    children.add(event.childSessionId);
    if (changed) {
      super.accept({
        sessionId: event.sessionId,
        type: "context",
        cwd: event.cwd,
        sectionLabel: event.sectionLabel,
        clientKind: "cli",
        subagentCount: children.size,
        finished: false,
      }, now);
    }
    if (event.completionCandidate) this.scheduleCompletion(event, { child: true });
  }

  finishSubagent(event) {
    const children = this.subagents.get(event.sessionId);
    if (!children?.delete(event.childSessionId)) return;
    if (!children.size) this.subagents.delete(event.sessionId);
    const id = `gemini:${event.sessionId}`;
    if (!this.sessions.has(id)) return;
    super.accept({
      sessionId: event.sessionId,
      type: "context",
      cwd: event.cwd,
      sectionLabel: event.sectionLabel,
      clientKind: "cli",
      subagentCount: children.size,
      finished: false,
    }, Date.now());
  }

  accept(event, now = Date.now()) {
    if (!event) return;
    if (event.type === "subagent") {
      this.updateSubagent(event, now);
      return;
    }
    if (event.type === "user") this.cancelSessionCompletions(event.sessionId);
    if (!event.recordId) {
      super.accept(event, now);
      return;
    }
    if (event.type === "user") {
      super.accept(event, now);
      return;
    }

    const key = this.completionKey(event);
    if (!event.completionCandidate) this.cancelCompletion(key);
    if (event.type === "assistant") {
      super.accept({
        ...event,
        eventId: `${event.recordId}:assistant`,
        toolEvents: undefined,
        completionCandidate: undefined,
      }, now);
    }
    const tools = Array.isArray(event.toolEvents)
      ? event.toolEvents
      : event.type === "tool"
        ? [event]
        : [];
    for (const toolEvent of tools) super.accept(toolEvent, now);
    if (event.completionCandidate) this.scheduleCompletion(event);
  }

  finish(id, reason, message = "") {
    const prefix = "gemini:";
    const sessionId = String(id).startsWith(prefix) ? String(id).slice(prefix.length) : String(id);
    this.cancelSessionCompletions(sessionId);
    this.subagents.delete(sessionId);
    super.finish(id, reason, message);
  }
}

module.exports = {
  GeminiWatcher,
  contentText,
  findGeminiSessionFiles,
  geminiModelLabel,
  parseGeminiRow,
  readGeminiSessionMetadata,
};
