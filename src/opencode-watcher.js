"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const { ExternalWatcher, messageText, text } = require("./external-watcher");
const { normalizeReasoningLabel, projectLabelFromCwd } = require("./activity-labels");
const { redactActivityDetail } = require("./activity-redaction");
const { commandNeedsShell } = require("./command-resolution");
const { openCodeStoragePaths } = require("./provider-client-discovery");
const { OpenCodeDbQuery } = require("./opencode-db-query");

const PAGE_SIZE = 300;
const SEED_SQL = `
SELECT time_updated AS cursor_time, id AS cursor_id
FROM part
ORDER BY time_updated DESC, id DESC
LIMIT 1`.trim();

function sqlString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function rowsSql(cursorTime, cursorId = "") {
  const safeCursor = Number.isSafeInteger(Number(cursorTime)) ? Number(cursorTime) : 0;
  const safeId = sqlString(cursorId);
  return `
WITH candidates AS MATERIALIZED (
  SELECT
    p.id AS part_id,
    p.time_updated AS part_updated,
    p.data AS part_data,
    p.message_id AS message_id,
    p.session_id AS session_id
  FROM part p
  WHERE p.time_updated > ${safeCursor}
     OR (p.time_updated = ${safeCursor} AND p.id > ${safeId})
  ORDER BY p.time_updated ASC, p.id ASC
  LIMIT ${PAGE_SIZE}
),
message_ids AS MATERIALIZED (
  SELECT DISTINCT message_id FROM candidates
),
message_meta AS MATERIALIZED (
  SELECT
    m.id,
    json_extract(m.data, '$.role') AS message_role,
    json_extract(m.data, '$.modelID') AS model_id,
    json_extract(m.data, '$.model.modelID') AS nested_model_id,
    json_extract(m.data, '$.variant') AS message_variant
  FROM message m
  JOIN message_ids ids ON ids.message_id = m.id
)
SELECT
  p.part_id,
  p.part_updated,
  p.message_id,
  json_extract(p.part_data, '$.type') AS part_type,
  substr(json_extract(p.part_data, '$.text'), 1, 4000) AS part_text,
  json_extract(p.part_data, '$.tool') AS tool_name,
  substr(COALESCE(
    json_extract(p.part_data, '$.state.input.command'),
    json_extract(p.part_data, '$.state.input.filePath'),
    json_extract(p.part_data, '$.state.input.file_path'),
    json_extract(p.part_data, '$.state.input.path'),
    json_extract(p.part_data, '$.state.input.pattern'),
    json_extract(p.part_data, '$.state.input.query'),
    json_extract(p.part_data, '$.state.input.glob'),
    json_extract(p.part_data, '$.title'),
    json_extract(p.part_data, '$.state.title')
  ), 1, 1000) AS part_detail,
  json_extract(p.part_data, '$.reason') AS part_reason,
  mm.message_role,
  COALESCE(mm.model_id, mm.nested_model_id) AS model_id,
  mm.message_variant,
  s.id AS session_id,
  s.parent_id AS parent_id,
  s.directory AS directory,
  s.title AS title
FROM candidates p
JOIN message_meta mm ON mm.id = p.message_id
JOIN session s ON s.id = p.session_id
ORDER BY p.part_updated ASC, p.part_id ASC`.trim();
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function modelLabel(model) {
  const source = String(model || "").trim().toLowerCase();
  if (!source) return null;
  if (/^(?:kimi-)?k3(?:[-.]\w+)?$/.test(source)) return "Kimi K3";
  const gemini = source.match(/^gemini[-_/](\d+(?:\.\d+)?)[-_/](pro|flash)(?:[-_/](lite))?/);
  if (gemini) {
    return `Gemini ${gemini[1]} ${gemini[2][0].toUpperCase()}${gemini[2].slice(1)}${gemini[3] ? " Lite" : ""}`;
  }
  const claude = source.match(/^claude[-_/]([a-z]+)(?:[-_/](\d+(?:[-.]\d+)?))?/);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1);
    return `Claude ${family}${claude[2] ? ` ${claude[2].replace(/-/g, ".")}` : ""}`;
  }
  const gpt = source.match(/^gpt[-_/](\d+(?:[.-]\d+)?(?:[-_/][a-z0-9]+)?)/);
  if (gpt) return `GPT ${gpt[1].replace(/-/g, ".")}`;
  return `OpenCode ${text(source, 32)}`;
}

function safeToolDetail(part) {
  const state = part?.state && typeof part.state === "object" ? part.state : {};
  const input = state.input && typeof state.input === "object" ? state.input : {};
  return text(redactActivityDetail(
    input.command || input.filePath || input.file_path || input.path ||
      input.pattern || input.query || input.glob || part?.detail || part?.title || state.title || "",
  ), 220);
}

function openCodeToolKind(name, partType) {
  if (partType === "patch" || /write|edit|patch/i.test(name)) return "patch";
  if (/grep|glob|search/i.test(name)) return "search";
  if (/read|list/i.test(name)) return "read";
  return "command";
}

function parseOpenCodeRow(row) {
  if (!row) return null;
  const message = row.message_data !== undefined
    ? parseJsonObject(row.message_data)
    : {
        role: row.message_role,
        modelID: row.model_id,
        variant: row.message_variant,
      };
  const part = row.part_data !== undefined
    ? parseJsonObject(row.part_data)
    : {
        type: row.part_type,
        text: row.part_text,
        tool: row.tool_name,
        detail: row.part_detail,
        reason: row.part_reason,
      };
  const partType = String(part.type || "");
  if (!row.session_id || !partType || partType === "reasoning") return null;

  const common = {
    sessionId: String(row.session_id),
    eventId: `${row.part_id || row.message_id || "part"}:${row.part_updated || 0}`,
    cwd: typeof row.directory === "string" ? row.directory : null,
    sectionLabel: projectLabelFromCwd(row.directory, "OpenCode"),
    clientKind: "app-cli",
    workerLabel: modelLabel(message.modelID || message.model?.modelID || message.model),
    reasoningLabel: normalizeReasoningLabel(message.variant),
  };

  if (row.parent_id) {
    return {
      ...common,
      type: "subagent",
      sessionId: String(row.parent_id),
      childSessionId: String(row.session_id),
      action: partType === "step-finish" && part.reason === "stop" ? "stop" : "start",
      finished: false,
    };
  }

  if (partType === "text") {
    const visible = messageText(part.text);
    if (!visible) return null;
    if (message.role === "user") return { ...common, type: "user", text: visible, finished: false };
    if (message.role === "assistant") {
      return {
        ...common,
        type: "assistant",
        text: visible,
        // OpenCode는 같은 message에 text part가 여러 개일 수 있습니다. 실제 턴 완료는
        // 뒤따르는 step-finish가 담당해야 마지막 보이는 응답을 보존할 수 있습니다.
        finished: false,
      };
    }
    return null;
  }

  if (partType === "tool") {
    const name = text(part.tool || "도구", 80);
    const detail = safeToolDetail(part);
    return {
      ...common,
      type: "tool",
      kind: openCodeToolKind(name, partType),
      text: [name, detail].filter(Boolean).join(": "),
      finished: false,
    };
  }

  if (partType === "patch") {
    return { ...common, type: "tool", kind: "patch", text: "파일 수정", finished: false };
  }
  if (partType === "step-start") {
    return { ...common, type: "lifecycle", text: "", finished: false };
  }
  if (partType === "step-finish") {
    return {
      ...common,
      type: "lifecycle",
      text: "",
      finished: part.reason === "stop",
    };
  }
  return null;
}

function execQuery(command, sql) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ["db", "--format", "json", sql],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024,
        shell: commandNeedsShell(command, process.platform),
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

class OpenCodeWatcher extends ExternalWatcher {
  constructor(options = {}) {
    super({
      provider: "opencode",
      roots: [],
      findFiles: () => [],
      parseRow: parseOpenCodeRow,
      pollMs: options.pollMs || 1800,
      quietMs: options.quietMs || 15000,
    });
    this.command = options.command || null;
    this.available = options.available ?? Boolean(this.command || options.dbFile);
    this.cursorTime = 0;
    this.cursorId = "";
    this.seeded = false;
    this.polling = false;
    this.started = false;
    this.dbFile = options.dbFile || openCodeStoragePaths({
      platform: options.platform,
      homeDir: options.homeDir,
      env: options.env,
    }).database;
    this.queryIsInjected = typeof options.query === "function";
    this.dbQuery = options.dbQuery || (this.queryIsInjected ? null : new OpenCodeDbQuery(this.dbFile));
    this.query = options.query || ((sql) => this.dbQuery.query(sql));
    this.subagents = new Map();
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.seedDatabase();
    if (!this.started) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    this.started = false;
    this.polling = false;
    this.subagents.clear();
    this.dbQuery?.close();
    super.stop();
  }

  async seedDatabase() {
    if (!fs.existsSync(this.dbFile) && !this.queryIsInjected) {
      this.seeded = false;
      return;
    }
    try {
      const seed = await this.query(SEED_SQL);
      this.cursorTime = Number(seed?.[0]?.cursor_time) || 0;
      this.cursorId = String(seed?.[0]?.cursor_id || "");
      this.seeded = true;
    } catch {
      this.seeded = false;
    }
  }

  async poll() {
    if (!this.started || this.polling) return;
    this.polling = true;
    const now = Date.now();
    try {
      if (!this.seeded) {
        await this.seedDatabase();
        return;
      }
      for (let page = 0; page < 4; page += 1) {
        const rows = await this.query(rowsSql(this.cursorTime, this.cursorId));
        for (const row of rows) {
          const updated = Number(row?.part_updated) || 0;
          const partId = String(row?.part_id || "");
          if (
            updated < this.cursorTime ||
            (updated === this.cursorTime && partId <= this.cursorId)
          ) continue;
          this.cursorTime = updated;
          this.cursorId = partId;
          this.accept(parseOpenCodeRow(row), now);
        }
        if (rows.length < PAGE_SIZE) break;
      }
      for (const [id, session] of [...this.sessions]) {
        if (now - session.lastAt > this.quietMs) this.finish(id, "quiet");
      }
    } catch {
      // CLI가 실행 중 DB를 잠그거나 구버전 schema를 쓰면 다음 poll에서 복구합니다.
      this.seeded = false;
    } finally {
      this.polling = false;
    }
  }

  accept(event, now = Date.now()) {
    if (event?.type !== "subagent") {
      super.accept(event, now);
      return;
    }
    const eventKey = `opencode:${event.sessionId}:${event.childSessionId}:${event.eventId}`;
    if (!this.rememberEvent(eventKey)) return;
    let children = this.subagents.get(event.sessionId);
    if (!children) {
      children = new Set();
      this.subagents.set(event.sessionId, children);
    }
    const before = children.size;
    if (event.action === "stop") children.delete(event.childSessionId);
    else children.add(event.childSessionId);
    if (!children.size) this.subagents.delete(event.sessionId);
    if (children.size === before) return;
    const id = `opencode:${event.sessionId}`;
    if (event.action === "stop" && !this.sessions.has(id)) return;
    super.accept({
      sessionId: event.sessionId,
      type: "context",
      cwd: event.cwd,
      sectionLabel: event.sectionLabel,
      clientKind: "app-cli",
      subagentCount: children.size,
      finished: false,
    }, now);
  }

  finish(id, reason, message = "") {
    const prefix = "opencode:";
    const sessionId = String(id).startsWith(prefix) ? String(id).slice(prefix.length) : String(id);
    this.subagents.delete(sessionId);
    super.finish(id, reason, message);
  }
}

module.exports = {
  OpenCodeWatcher,
  SEED_SQL,
  execQuery,
  modelLabel,
  parseOpenCodeRow,
  rowsSql,
  safeToolDetail,
  sqlString,
};
