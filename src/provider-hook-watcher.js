"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ExternalWatcher, messageText, text } = require("./external-watcher");
const { normalizeWorkerLabel, projectLabelFromCwd } = require("./activity-labels");
const { redactActivityDetail } = require("./activity-redaction");

function hookSessionId(provider, payload) {
  if (provider === "windsurf") return payload?.trajectory_id || payload?.trajectoryId || null;
  return payload?.sessionId || payload?.session_id || payload?.conversation_id ||
    payload?.conversationId || payload?.trajectory_id || payload?.execution_id || null;
}

function parentSessionId(payload) {
  return payload?.parentSessionId || payload?.parent_session_id ||
    payload?.parent_conversation_id || payload?.parentConversationId || null;
}

function hookCwd(payload) {
  const roots = payload?.workspace_roots || payload?.workspaceRoots;
  return payload?.cwd || payload?.tool_info?.cwd ||
    (Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : null);
}

function providerFallbackLabel(provider) {
  return provider === "copilot" ? "Copilot" : provider === "cursor" ? "Cursor" : "Windsurf";
}

function hookEventId(provider, eventName, payload) {
  return crypto.createHash("sha1").update(JSON.stringify({
    provider,
    eventName,
    id: payload?.hook_event_id || payload?.hookEventId || payload?.generation_id ||
      payload?.call_id || payload?.callId || payload?.execution_id,
    timestamp: payload?.timestamp,
    action: payload?.agent_action_name,
    agent: payload?.agentName || payload?.agent_name || payload?.agentDisplayName,
    session: hookSessionId(provider, payload),
    tool: payload?.toolName || payload?.tool_name || payload?.tool_info,
    text: payload?.prompt || payload?.text || payload?.response || payload?.transcriptPath,
  })).digest("hex").slice(0, 16);
}

function readCopilotVisibleResponse(file, options = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.basename(file) !== "events.jsonl") {
    return { text: "", model: null };
  }
  const maxBytes = options.maxBytes || 2 * 1024 * 1024;
  let descriptor;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { text: "", model: null };
    const size = stat.size;
    const offset = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - offset);
    descriptor = fs.openSync(file, "r");
    fs.readSync(descriptor, buffer, 0, buffer.length, offset);
    let lines = buffer.toString("utf8").split(/\r?\n/);
    if (offset > 0) lines = lines.slice(1);
    let model = null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let row;
      try {
        row = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (row?.agentId || row?.ephemeral === true) continue;
      if (!model && row?.type === "assistant.usage") {
        model = text(row?.data?.model, 52) || null;
      }
      if (row?.type !== "assistant.message" || row?.data?.phase === "thinking") continue;
      const visible = messageText(row?.data?.content);
      if (visible) return { text: visible, model };
    }
    return { text: "", model };
  } catch {
    return { text: "", model: null };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isSubagentEvent(eventName, payload) {
  return /subagent/i.test(eventName) || payload?.isSubagent === true ||
    payload?.is_subagent === true || Boolean(parentSessionId(payload));
}

function hookModelLabel(payload) {
  const raw = payload?.model || payload?.modelName || payload?.model_name ||
    payload?.model?.displayName || payload?.model?.name;
  const label = text(raw, 52);
  const known = normalizeWorkerLabel(label.toLowerCase());
  if (known) return known;
  const gpt = label.match(/^gpt[-_/](.+)$/i);
  if (gpt) return `GPT ${gpt[1].replace(/^(\d+)-(\d+)/, "$1.$2")}`;
  const gemini = label.match(/^gemini[-_/](.+)$/i);
  if (gemini) return `Gemini ${gemini[1].replace(/[-_/]+/g, " ")}`;
  const claude = label.match(/^claude[-_/](.+)$/i);
  if (claude) return `Claude ${claude[1].replace(/[-_/]+/g, " ")}`;
  return /^(?:Gemini|Claude|GPT|Kimi|Copilot|Cursor|OpenCode|Windsurf)(?:\s|$)/i.test(label)
    ? label.replace(/^gpt\b/i, "GPT")
    : null;
}

function toolInput(payload) {
  const info = payload?.tool_info && typeof payload.tool_info === "object" ? payload.tool_info : {};
  const args = payload?.toolArgs || payload?.tool_args || payload?.toolInput || payload?.tool_input ||
    info.tool_args || info.args || info.mcp_tool_arguments || {};
  const safeArgs = args && typeof args === "object" ? args : {};
  return text(redactActivityDetail(
    info.command_line || info.file_path || safeArgs.command || safeArgs.filePath ||
      safeArgs.file_path || safeArgs.path || safeArgs.pattern || safeArgs.query || "",
  ), 220);
}

function hookToolName(eventName, payload) {
  const info = payload?.tool_info && typeof payload.tool_info === "object" ? payload.tool_info : {};
  if (/read/i.test(eventName)) return "파일 읽기";
  if (/write|edit/i.test(eventName)) return "파일 수정";
  if (/runcommand|shell/i.test(eventName)) return "명령";
  if (/mcp/i.test(eventName)) return text(info.mcp_tool_name || "MCP", 80);
  return text(payload?.toolName || payload?.tool_name || info.tool_name || "도구", 80);
}

function hookToolKind(eventName, toolName) {
  if (/write|edit|patch/i.test(`${eventName} ${toolName}`)) return "patch";
  if (/read/i.test(`${eventName} ${toolName}`)) return "read";
  if (/grep|glob|search/i.test(toolName)) return "search";
  return "command";
}

function lastPlannerResponse(value) {
  const source = messageText(value);
  if (!source) return "";
  const sections = source.split(/^###\s+Planner Response\s*$/gim);
  if (sections.length < 2) return "";
  return messageText(sections.at(-1).replace(/^\s+|\s+$/g, ""));
}

function parseProviderHookEvent(provider, eventName, payload = {}) {
  if (!provider || !eventName || !payload || isSubagentEvent(eventName, payload)) return null;
  const sessionId = hookSessionId(provider, payload);
  if (!sessionId) return null;
  const cwd = hookCwd(payload);
  const common = {
    sessionId: String(sessionId),
    eventId: hookEventId(provider, eventName, payload),
    cwd,
    sectionLabel: projectLabelFromCwd(cwd, providerFallbackLabel(provider)),
    clientKind: provider === "copilot" ? "cli" : "app",
    workerLabel: hookModelLabel(payload),
  };
  const normalized = String(eventName).toLowerCase();

  if (normalized === "sessionstart") return null;

  const userText = provider === "windsurf"
    ? payload?.tool_info?.user_prompt
    : payload?.prompt || payload?.user_prompt || payload?.initialPrompt || payload?.initial_prompt;
  if (
    normalized === "userpromptsubmitted" || normalized === "userpromptsubmit" ||
    normalized === "beforesubmitprompt" || normalized === "pre_user_prompt"
  ) {
    const visible = messageText(userText);
    return visible ? { ...common, type: "user", text: visible, finished: false } : null;
  }

  if (provider === "windsurf" && normalized === "post_cascade_response") {
    const visible = lastPlannerResponse(payload?.tool_info?.response);
    return visible
      ? { ...common, type: "assistant", text: visible, finished: true }
      : { ...common, type: "lifecycle", text: "", finished: true };
  }

  if (provider === "cursor" && normalized === "afteragentresponse") {
    const visible = messageText(payload?.text || payload?.response || payload?.message);
    return visible ? { ...common, type: "assistant", text: visible, finished: false } : null;
  }

  if (provider === "copilot" && normalized === "agentstop") {
    const visible = messageText(payload?.response || payload?.finalResponse || payload?.final_response);
    return visible
      ? { ...common, type: "assistant", text: visible, finished: true }
      : { ...common, type: "lifecycle", text: "", finished: true };
  }

  if (normalized === "erroroccurred" || normalized === "error") {
    const visible = messageText(redactActivityDetail(
      payload?.error?.message || payload?.error || payload?.message || "작업 중 오류가 발생했습니다."
    ));
    return { ...common, type: "lifecycle", text: visible, finished: true, failed: true };
  }

  if (
    normalized === "stop" || normalized === "sessionend"
  ) {
    const reason = String(payload?.stopReason || payload?.stop_reason || payload?.reason || "");
    const failed = /error|fail|crash/i.test(reason);
    return {
      ...common,
      type: "lifecycle",
      text: failed ? messageText(redactActivityDetail(reason)) : "",
      finished: true,
      failed,
    };
  }

  if (
    /tooluse|shellexecution|readfile|fileedit|read_code|write_code|run_command|mcp_tool_use/.test(normalized)
  ) {
    const name = hookToolName(eventName, payload);
    const detail = toolInput(payload);
    return {
      ...common,
      type: "tool",
      kind: hookToolKind(eventName, name),
      text: [name, detail].filter(Boolean).join(": "),
      finished: false,
    };
  }

  return null;
}

class HookProviderWatcher extends ExternalWatcher {
  constructor(options = {}) {
    super({
      provider: options.provider,
      roots: [],
      findFiles: () => [],
      parseRow: () => null,
      pollMs: options.pollMs || 2000,
      quietMs: options.quietMs || 30000,
    });
    this.subagents = new Map();
    this.readCopilotResponse = options.readCopilotResponse || readCopilotVisibleResponse;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of [...this.sessions]) {
        if (now - session.lastAt > this.quietMs) this.finish(id, "quiet");
      }
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    this.subagents.clear();
    super.stop();
  }

  ingest(eventName, payload, now = Date.now()) {
    if (/^subagent(?:start|stop)$/i.test(String(eventName))) {
      const parentId = parentSessionId(payload) || hookSessionId(this.provider, payload);
      if (!parentId) return;
      const key = String(parentId);
      const eventKey = `${this.provider}:${key}:${hookEventId(this.provider, eventName, payload)}`;
      if (!this.rememberEvent(eventKey)) return;
      const current = this.subagents.get(key) || 0;
      if (/stop$/i.test(eventName) && current === 0) return;
      const next = /start$/i.test(eventName) ? current + 1 : Math.max(0, current - 1);
      if (next > 0) this.subagents.set(key, next);
      else this.subagents.delete(key);
      this.accept({
        sessionId: key,
        type: "context",
        cwd: hookCwd(payload),
        sectionLabel: projectLabelFromCwd(hookCwd(payload), providerFallbackLabel(this.provider)),
        subagentCount: next,
        finished: false,
      }, now);
      return;
    }
    let source = payload;
    if (this.provider === "copilot" && /^agentstop$/i.test(String(eventName))) {
      const transcript = this.readCopilotResponse(
        payload?.transcriptPath || payload?.transcript_path
      );
      source = {
        ...payload,
        finalResponse: transcript?.text || undefined,
        model: payload?.model || transcript?.model || undefined,
      };
    }
    const event = parseProviderHookEvent(this.provider, eventName, source);
    if (!event) return;
    const id = `${this.provider}:${event.sessionId}`;
    if (event.type === "lifecycle" && event.finished && !this.sessions.has(id)) return;
    this.accept(event, now);
  }

  finish(id, reason, message = "") {
    const prefix = `${this.provider}:`;
    const sessionId = String(id).startsWith(prefix) ? String(id).slice(prefix.length) : String(id);
    this.subagents.delete(sessionId);
    super.finish(id, reason, message);
  }
}

module.exports = {
  HookProviderWatcher,
  hookCwd,
  hookSessionId,
  isSubagentEvent,
  lastPlannerResponse,
  parseProviderHookEvent,
  readCopilotVisibleResponse,
};
