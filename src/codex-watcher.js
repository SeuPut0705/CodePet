const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeReasoningLabel, normalizeWorkerLabel } = require("./activity-labels");
const { SubagentActivityTracker } = require("./subagent-activity-tracker");

// Codex CLI는 모든 세션 이벤트를 CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl에 실시간으로 append합니다.
// 이 모듈은 최근 rollout 파일들을 tail해서 작업 상태/메시지/사용량(rate_limits)을 이벤트로 발행합니다.
// Codex 세션이 동시에 여러 개 돌아갈 수 있으므로 파일 하나가 아니라 최근 파일 여러 개를
// 각자의 오프셋으로 추적합니다.
const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");
const DEFAULT_SESSIONS_DIR = path.join(DEFAULT_CODEX_HOME, "sessions");

const WATCHER_CONFIG = Object.freeze({
  // 파일 크기 변화를 확인하는 주기입니다. 너무 짧으면 IO 낭비, 너무 길면 말풍선 반응이 늦어집니다.
  pollMs: 1500,
  // 사용량/초기 작업 상태를 찾을 때 파일 끝에서 읽을 최대 바이트입니다.
  usageScanBytes: 512 * 1024,
  // 최근 파일에 token_count가 없으면 이전 파일까지 몇 개를 거슬러 올라갈지 정합니다.
  usageScanFiles: 5,
  // Codex Desktop/CLI의 구조화 로그에는 최신 websocket rate limit 이벤트가 들어갑니다.
  // 더블클릭 사용량 조회는 이 로그를 우선 스캔해서 세션 JSONL 캐시보다 최신 값을 가져옵니다.
  logUsageScanBytes: 32 * 1024 * 1024,
  logUsageFiles: ["logs_2.sqlite-wal", "logs_2.sqlite"],
  // Codex Desktop은 오래전에 만든 thread를 오늘 다시 이어도 원래 생성일 폴더에 계속 append합니다.
  // 그래서 "최근 날짜 폴더 N개"만 보면 현재 대화를 놓칠 수 있습니다. day 폴더는 전부 훑고,
  // 실제 tail 대상은 rollout 파일의 수정 시각(mtime) 기준 최신 N개만 고릅니다.
  maxDayDirsToScan: 180,
  // 동시에 tail할 최근 파일 수입니다. 동시 세션이 이보다 많으면 오래된 세션은 놓칠 수 있습니다.
  tailFiles: 10,
  // 서브에이전트가 많아도 사용자 rollout quota를 차지하지 않도록 별도로 제한합니다.
  subagentTailFiles: 40,
  rolloutMetadataLimit: 512,
  // session_meta 분류는 작고 불변이므로 활성 그래프와 분리해 넉넉한 상한으로 재사용합니다.
  rolloutClassificationLimit: 16_384,
  // 작업 중 표시가 이 시간 동안 아무 이벤트 없이 유지되면 Codex가 죽었다고 보고 해제합니다.
  // 정상 작업 중에는 token_count가 주기적으로 기록되므로 이 시간을 넘길 일이 없습니다.
  staleWorkingMs: 5 * 60 * 1000,
});

const THREAD_ID_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// rollout 파일명 끝의 UUID는 Codex Desktop이 쓰는 로컬 thread id입니다.
function extractThreadIdFromRolloutPath(filePath) {
  const match = String(filePath || "").match(THREAD_ID_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

// shell 명령 원문을 말풍선 상태로만 분류합니다. 명령 전체는 full 모드에서만 main이 표시합니다.
function classifyShellCommand(command) {
  const text = String(command || "").trim();
  if (!text) return { kind: "command", command: null };

  const normalized = text.toLowerCase();
  const isTest = [
    /(^|[;&|]\s*)npm\s+(run\s+)?test\b/,
    /(^|[;&|]\s*)pnpm\s+(run\s+)?test\b/,
    /(^|[;&|]\s*)yarn\s+(run\s+)?test\b/,
    /(^|[;&|]\s*)node\s+--test\b/,
    /\b(vitest|jest|pytest|playwright\s+test|cargo\s+test|dotnet\s+test)\b/,
  ].some((pattern) => pattern.test(normalized));
  if (isTest) return { kind: "test", command: text };

  const isBuild = [
    /(^|[;&|]\s*)npm\s+run\s+(build|dist|package)\b/,
    /(^|[;&|]\s*)pnpm\s+(run\s+)?(build|dist|package)\b/,
    /(^|[;&|]\s*)yarn\s+(run\s+)?(build|dist|package)\b/,
    /\b(tsc|cargo\s+build|dotnet\s+build)\b/,
  ].some((pattern) => pattern.test(normalized));
  if (isBuild) return { kind: "build", command: text };

  const isRead = [
    /\b(get-content|select-string|get-childitem|measure-object)\b/,
    /(^|[;&|]\s*)(rg|grep|findstr|dir|ls)\b/,
    /(^|[;&|]\s*)git\s+(status|diff|show|log|ls-files)\b/,
  ].some((pattern) => pattern.test(normalized));
  if (isRead) return { kind: "read", command: text };

  return { kind: "command", command: text };
}

function parseFunctionArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

// Codex 버전에 따라 reset_at 또는 resets_at으로 필드명이 다를 수 있어 둘 다 같은 값으로 맞춥니다.
function normalizeRateLimitWindow(window) {
  if (!window || typeof window !== "object") return null;

  const resetAt = Number(window.resets_at ?? window.reset_at);

  return {
    ...window,
    reset_at: Number.isFinite(resetAt) ? resetAt : window.reset_at,
    resets_at: Number.isFinite(resetAt) ? resetAt : window.resets_at,
  };
}

// token_count payload와 websocket codex.rate_limits payload의 모양이 달라서
// 화면에서 쓰는 { primary, secondary, plan_type } 형태로 통일합니다.
function normalizeUsage(rateLimits, recordedAt = null, source = "sessions") {
  if (!rateLimits || typeof rateLimits !== "object") return null;

  const envelope = rateLimits.rate_limits ? rateLimits : null;
  const limits = envelope ? envelope.rate_limits : rateLimits;

  if (!limits || typeof limits !== "object") return null;

  return {
    rateLimits: {
      ...limits,
      plan_type: limits.plan_type || envelope?.plan_type || rateLimits.plan_type || null,
      primary: normalizeRateLimitWindow(limits.primary),
      secondary: normalizeRateLimitWindow(limits.secondary),
    },
    recordedAt,
    source,
  };
}

// sessions/YYYY/MM/DD 구조에서 day 폴더를 찾습니다.
// 폴더명 날짜가 아니라 rollout 파일 수정 시각이 "현재 활성 대화"를 가리키므로,
// 여기서는 넓게 모으고 listRecentRolloutFiles()에서 mtime 기준으로 다시 자릅니다.
function listSessionDayDirs(limit = WATCHER_CONFIG.maxDayDirsToScan, sessionsDir = DEFAULT_SESSIONS_DIR) {
  const dayDirs = [];

  let years;
  try {
    years = fs.readdirSync(sessionsDir).filter((n) => /^\d{4}$/.test(n)).sort().reverse();
  } catch {
    return dayDirs;
  }

  for (const year of years) {
    const yearPath = path.join(sessionsDir, year);
    let months;
    try {
      months = fs.readdirSync(yearPath).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
    } catch {
      continue;
    }

    for (const month of months) {
      const monthPath = path.join(yearPath, month);
      let days;
      try {
        days = fs.readdirSync(monthPath).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
      } catch {
        continue;
      }

      for (const day of days) {
        dayDirs.push(path.join(monthPath, day));
        if (dayDirs.length >= limit) return dayDirs;
      }
    }
  }

  return dayDirs;
}

// day 폴더들에서 rollout 파일을 수정 시각 내림차순으로 모아 돌려줍니다.
// 오래된 thread가 오늘 append되는 경우 폴더명은 오래됐지만 mtime은 최신이므로 반드시 mtime을 기준으로 합니다.
function listRecentRolloutFiles(
  limit,
  sessionsDir = DEFAULT_SESSIONS_DIR,
  includeFile = () => true
) {
  const files = [];

  for (const dayDir of listSessionDayDirs(WATCHER_CONFIG.maxDayDirsToScan, sessionsDir)) {
    let names;
    try {
      names = fs.readdirSync(dayDir);
    } catch {
      continue;
    }

    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;

      const filePath = path.join(dayDir, name);
      try {
        const stat = fs.statSync(filePath);
        files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // 파일이 방금 지워졌을 수 있으므로 무시하고 계속 진행합니다.
      }
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = [];
  for (const file of files) {
    if (!includeFile(file.filePath)) continue;
    selected.push(file);
    if (selected.length >= limit) break;
  }
  return selected;
}

// 첫 session_meta 줄이 완전히 기록된 뒤 실제 payload.thread_source만 신뢰합니다.
// 부분 기록은 다음 poll로 미뤄 subagent 이벤트가 한 번이라도 사용자 화면에 새는 것을 막습니다.
function readRolloutMetadata(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const size = Math.min(fs.fstatSync(fd).size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buffer, 0, size, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const newlineIndex = text.indexOf("\n");
    if (newlineIndex < 0) return null;

    const entry = JSON.parse(text.slice(0, newlineIndex));
    if (entry?.type !== "session_meta" || !entry.payload?.id) return null;
    return {
      threadId: entry.payload.id,
      threadSource: entry.payload.thread_source || "user",
      parentThreadId: entry.payload.parent_thread_id || null,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// 파일 끝에서 usageScanBytes만 읽어 줄 단위로 돌려줍니다. 뒤에서부터 스캔하는 용도입니다.
function readTailLines(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return [];
  }

  try {
    const size = fs.fstatSync(fd).size;
    const readBytes = Math.min(size, WATCHER_CONFIG.usageScanBytes);
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, size - readBytes);
    return buffer.toString("utf8").split("\n");
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

// 한 파일에서 마지막 token_count 이벤트의 rate_limits를 찾아냅니다.
function extractUsageFromFile(filePath) {
  const lines = readTailLines(filePath);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"rate_limits"')) continue;

    try {
      const entry = JSON.parse(lines[i]);
      const payload = entry?.payload;
      if (payload?.type === "token_count" && payload.rate_limits) {
        return normalizeUsage(payload.rate_limits, entry.timestamp || null, "sessions");
      }
    } catch {
      // 잘린 줄이거나 다른 형식이면 다음 줄을 계속 확인합니다.
    }
  }
  return null;
}

// 문자열 안의 JSON 객체 하나를 중괄호 균형으로 잘라냅니다.
// sqlite 로그 파일은 바이너리 데이터 사이에 plain text 로그가 섞여 있어서 줄 단위 JSON 파싱을 할 수 없습니다.
function extractJsonObjectAt(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

// sqlite/wal 텍스트 조각에서 가장 뒤에 있는 codex.rate_limits 이벤트를 찾습니다.
function extractUsageFromLogText(text, recordedAt, source) {
  let fromIndex = text.length;
  const marker = "{\"type\":\"codex.rate_limits\"";

  while (fromIndex > 0) {
    const startIndex = text.lastIndexOf(marker, fromIndex);
    if (startIndex < 0) return null;

    const jsonText = extractJsonObjectAt(text, startIndex);
    if (jsonText) {
      try {
        const event = JSON.parse(jsonText);
        const usage = normalizeUsage(event, recordedAt, source);
        if (usage?.rateLimits?.primary || usage?.rateLimits?.secondary) {
          return usage;
        }
      } catch {
        // 잘린 이벤트면 앞쪽 이벤트를 계속 찾습니다.
      }
    }

    fromIndex = startIndex;
  }

  return null;
}

// Codex 구조화 로그 파일의 끝부분에서 최신 rate limit 이벤트를 읽습니다.
function extractUsageFromLogFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }

  try {
    const stat = fs.fstatSync(fd);
    const readBytes = Math.min(stat.size, WATCHER_CONFIG.logUsageScanBytes);
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, stat.size - readBytes);

    return extractUsageFromLogText(
      buffer.toString("utf8"),
      new Date(stat.mtimeMs).toISOString(),
      path.basename(filePath)
    );
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// wal이 있으면 보통 sqlite 본문보다 최신입니다. 그래도 수정 시각 내림차순으로 확인합니다.
function extractLatestUsageFromLogs() {
  const files = WATCHER_CONFIG.logUsageFiles
    .map((name) => path.join(DEFAULT_CODEX_HOME, name))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => {
      try {
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of files) {
    const usage = extractUsageFromLogFile(file.filePath);
    if (usage) return usage;
  }

  return null;
}

function extractLatestUsageFromSessions() {
  const recentFiles = listRecentRolloutFiles(WATCHER_CONFIG.usageScanFiles);
  for (const file of recentFiles) {
    const usage = extractUsageFromFile(file.filePath);
    if (usage) return usage;
  }

  return null;
}

// 파일 끝부분에서 마지막 작업 상태 이벤트를 찾아, 파일이 "작업 중" 상태로 끝나 있는지 판단합니다.
// 앱 시작 시점에 Codex가 이미 작업 중이면 이 함수로 초기 상태를 복원합니다.
function detectWorkingFromFile(filePath) {
  const lines = readTailLines(filePath);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const isStart =
      line.includes('"task_started"') ||
      line.includes('"user_message"') ||
      line.includes('"agent_message"') ||
      line.includes('"token_count"') ||
      line.includes('"patch_apply_end"') ||
      line.includes('"web_search_end"') ||
      line.includes('"image_generation_end"');
    const isEnd = line.includes('"task_complete"') || line.includes('"turn_aborted"');
    if (!isStart && !isEnd) continue;

    try {
      const entry = JSON.parse(line);
      const payloadType = entry?.payload?.type;
      if (payloadType === "task_started") return true;
      if (
        payloadType === "user_message" ||
        payloadType === "agent_message" ||
        payloadType === "token_count" ||
        payloadType === "patch_apply_end" ||
        payloadType === "web_search_end" ||
        payloadType === "image_generation_end"
      ) {
        return true;
      }
      if (payloadType === "task_complete" || payloadType === "turn_aborted") return false;
    } catch {
      // 잘린 줄이면 다음 줄을 계속 확인합니다.
    }
  }
  return false;
}

// 서브에이전트 lifecycle은 파일 전체를 메모리에 올리지 않고 뒤에서부터 찾습니다.
// 긴 비수명주기 로그가 tail 한도를 넘겨도 초기 task_started를 복원해야 합니다.
function findLatestSubagentLifecycleType(filePath) {
  const lifecycleTypes = ["task_started", "task_complete", "turn_aborted"];
  const lifecycleTypeSet = new Set(lifecycleTypes);
  const chunkBytes = 64 * 1024;
  const maxLineBytes = WATCHER_CONFIG.usageScanBytes;
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }

  try {
    let position = fs.fstatSync(fd).size;
    let suffix = Buffer.from("\n");
    let discardingLongLine = false;

    while (position > 0) {
      const readBytes = Math.min(chunkBytes, position);
      position -= readBytes;
      const chunk = Buffer.alloc(readBytes);
      fs.readSync(fd, chunk, 0, readBytes, position);

      let data;
      if (discardingLongLine) {
        const boundary = chunk.lastIndexOf(0x0a);
        if (boundary < 0) continue;
        data = chunk.subarray(0, boundary + 1);
        discardingLongLine = false;
      } else {
        data = Buffer.concat([chunk, suffix]);
      }
      if (position === 0) data = Buffer.concat([Buffer.from("\n"), data]);

      const firstNewline = data.indexOf(0x0a);
      if (firstNewline < 0) {
        if (data.length > maxLineBytes) {
          suffix = Buffer.alloc(0);
          discardingLongLine = true;
        } else {
          suffix = data;
        }
        continue;
      }

      const lines = data.subarray(firstNewline + 1).toString("utf8").split("\n");
      for (let index = lines.length - 2; index >= 0; index -= 1) {
        const line = lines[index];
        if (!lifecycleTypes.some((type) => line.includes(`"${type}"`))) continue;
        try {
          const entry = JSON.parse(line);
          const type = entry?.type === "event_msg" ? entry.payload?.type : null;
          if (lifecycleTypeSet.has(type)) return type;
        } catch {
          // 잘린 줄이면 이전의 완전한 수명 주기 이벤트를 봅니다.
        }
      }

      if (position > 0) {
        const prefixBytes = firstNewline + 1;
        if (prefixBytes > maxLineBytes) {
          suffix = Buffer.alloc(0);
          discardingLongLine = true;
        } else {
          suffix = Buffer.from(data.subarray(0, prefixBytes));
        }
      }
    }
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

// 서브에이전트 복원은 메시지나 도구 이벤트가 아니라 명시적 수명 주기만 신뢰합니다.
function detectSubagentWorkingFromFile(filePath) {
  return findLatestSubagentLifecycleType(filePath) === "task_started";
}

// 이미 실행 중인 rollout을 복원할 때는 최근 task_started의 구조화 시각을 보존합니다.
// tail에 시작 이벤트가 없으면 ActivityBubbleState가 결정적 first-seen 순서를 사용합니다.
function extractActiveTaskStartedAtFromFile(filePath) {
  const lines = readTailLines(filePath);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry?.payload?.type === "task_started" && entry.timestamp) return entry.timestamp;
    } catch {
      // 잘린 줄은 무시하고 더 이전의 완전한 이벤트를 봅니다.
    }
  }
  return null;
}

function activityLabelsFromTurnContext(payload = {}) {
  return {
    workerLabel: normalizeWorkerLabel(payload.model),
    reasoningLabel: normalizeReasoningLabel(
      payload.effort || payload.collaboration_mode?.settings?.reasoning_effort
    ),
  };
}

function extractLatestActivityLabelsFromFile(filePath) {
  const lines = readTailLines(filePath);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry?.type === "turn_context") {
        return activityLabelsFromTurnContext(entry.payload);
      }
    } catch {
      // 잘린 줄이면 이전 줄을 계속 확인합니다.
    }
  }
  return { workerLabel: null, reasoningLabel: null };
}

// 계정 전환/로그인 실험 중 CODEX_HOME이 여러 곳으로 갈라진 상태에서도 작업 말풍선을 놓치지 않게
// 기본 ~/.codex 외에 ~/.codex2, ~/.codepet/codex-switch/profiles/* 같은 sessions 폴더도 감시합니다.
function discoverDefaultCodexHomes() {
  const homes = [DEFAULT_CODEX_HOME];
  const userHome = os.homedir();

  try {
    for (const entry of fs.readdirSync(userHome, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.codex\d+$/.test(entry.name)) {
        homes.push(path.join(userHome, entry.name));
      }
    }
  } catch {
    // 홈 디렉터리 열람 실패 시 기본 ~/.codex만 사용합니다.
  }

  const profileRoots = [
    path.join(userHome, ".codepet", "codex-switch", "profiles"),
    path.join(userHome, ".cdx", "profiles"),
  ];

  for (const root of profileRoots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          homes.push(path.join(root, entry.name));
        }
      }
    } catch {
      // 해당 도구를 쓰지 않는 환경이면 폴더가 없는 것이 정상입니다.
    }
  }

  return homes;
}

// Codex 세션 로그를 감시하는 EventEmitter입니다.
// 발행 이벤트:
//  - "working-changed" (isWorking, result, context) : 작업 상태/활성 수 변경
//  - "agent-message" (message, context)     : Codex가 사용자에게 보낸 메시지
//  - "user-message" (message, context)      : 사용자가 Codex에 보낸 요청
//  - "tool-activity" (activity)             : 파일 수정/웹 검색/이미지 생성 등 도구 사용
//  - "waiting" (waiting)                    : 사용자 입력/실행 승인을 기다리는 상태
//  - "task-finished" (result)               : 세션별 완료/중단과 해당 thread id
//  - "usage-updated" (usage, context)       : 세션별 rate_limits 갱신
//  - "subagent-count-changed" (count)       : 사용자 thread별 활성 서브에이전트 수
class CodexWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    // 계정 전환 뒤에도 새 CODEX_HOME의 sessions를 감시할 수 있게 main.js에서 동적으로 주입합니다.
    this.getCodexHomes =
      typeof options.getCodexHomes === "function"
        ? options.getCodexHomes
        : discoverDefaultCodexHomes;
    this.pollTimer = null;
    // filePath -> { offset, buffer } : 파일별 읽기 위치입니다.
    // 동시 세션이 번갈아 기록해도 각 파일을 이어서 읽을 수 있습니다.
    this.tails = new Map();
    // 현재 task_started 상태인 파일들입니다. 하나라도 있으면 "작업 중"으로 봅니다.
    this.workingFiles = new Set();
    // rollout 파일별 검증된 모델·추론 라벨입니다. 세션 간 라벨은 공유하지 않습니다.
    this.activityLabels = new Map();
    // 동시 작업 하나만 멈춰도 개별적으로 stale 해제할 수 있게 파일별 최근 활동 시각을 둡니다.
    this.lastEventAtByFile = new Map();
    this.taskStartedAtByFile = new Map();
    // session_meta의 thread 관계를 파일별로 캐시하고 활성 자손을 최상위 사용자 thread에 합산합니다.
    this.rolloutMetadata = new Map();
    // tail/graph 대상에서 밀려난 파일도 매 poll마다 다시 열지 않도록 분류만 별도로 보존합니다.
    this.rolloutClassifications = new Map();
    this.subagents = new SubagentActivityTracker({
      maxThreads: WATCHER_CONFIG.rolloutMetadataLimit,
    });
    this.activeSubagentFiles = new Set();
    this.lastSubagentCounts = new Map();
    this.firstPoll = true;
    this.cachedUsage = null;
  }

  get working() {
    return this.workingFiles.size > 0;
  }

  start() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), WATCHER_CONFIG.pollMs);
    this.poll();
  }

  stop() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // active 프로필과 발견된 프로필들의 sessions 폴더를 모읍니다.
  // 같은 경로가 여러 번 들어오면 파일 tail 상태가 꼬일 수 있으므로 소문자 절대경로로 중복 제거합니다.
  getSessionDirs() {
    let homes;
    try {
      homes = this.getCodexHomes();
    } catch {
      homes = [DEFAULT_CODEX_HOME];
    }

    const byPath = new Map();
    for (const homePath of Array.isArray(homes) ? homes : []) {
      if (!homePath) continue;
      const sessionsDir = path.join(homePath, "sessions");
      byPath.set(path.resolve(sessionsDir).toLowerCase(), sessionsDir);
    }

    if (byPath.size === 0) {
      byPath.set(path.resolve(DEFAULT_SESSIONS_DIR).toLowerCase(), DEFAULT_SESSIONS_DIR);
    }

    return [...byPath.values()];
  }

  // 모든 CODEX_HOME의 최근 rollout을 합친 뒤 최신 순서로 tail 대상만 고릅니다.
  listRecentRolloutFiles(limit) {
    const files = [];
    for (const sessionsDir of this.getSessionDirs()) {
      files.push(...listRecentRolloutFiles(Infinity, sessionsDir));
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const filesByThreadId = new Map();
    const filesByPath = new Map();
    for (const file of files) {
      filesByPath.set(file.filePath, file);
      const threadId = extractThreadIdFromRolloutPath(file.filePath);
      if (threadId && !filesByThreadId.has(threadId)) filesByThreadId.set(threadId, file);
    }
    const userFiles = [];
    const subagentFiles = [];
    for (const file of files) {
      // quota 분류 중에는 metadata를 cache/tracker에 등록하지 않습니다.
      // 선택되지 않을 오래된 rollout이 최신 선택 항목을 축출하면 subagent를 user로 오분류할 수 있습니다.
      const metadata = this.classificationForRollout(file.filePath);
      if (!metadata) continue;
      if (metadata.threadSource === "user" && userFiles.length < limit) {
        userFiles.push({ file, metadata });
      } else if (
        metadata.threadSource === "subagent" &&
        subagentFiles.length < WATCHER_CONFIG.subagentTailFiles
      ) {
        subagentFiles.push({ file, metadata });
      }
      if (
        userFiles.length >= limit &&
        subagentFiles.length >= WATCHER_CONFIG.subagentTailFiles
      ) {
        break;
      }
    }

    // 최근 discovery quota 밖으로 밀려도 이미 활성으로 확인한 파일은 완료/stale까지 계속 tail합니다.
    // 첫 poll에서는 stale 시간 안의 추가 subagent만 역방향 검사해 동시 활성 수가 40을 넘어도 복원합니다.
    const subagentCandidates = [];
    const candidatePaths = new Set();
    const addSubagentCandidate = (file, metadata) => {
      if (
        !file ||
        metadata?.threadSource !== "subagent" ||
        candidatePaths.has(file.filePath)
      ) {
        return;
      }
      subagentCandidates.push({ file, metadata });
      candidatePaths.add(file.filePath);
    };

    // steady poll에서는 이미 활성인 작업이 최신 완료 로그에 밀려 사라지지 않게 먼저 자리 잡습니다.
    if (!this.firstPoll) {
      const activeFiles = [...this.activeSubagentFiles]
        .map((filePath) => filesByPath.get(filePath))
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const file of activeFiles) {
        addSubagentCandidate(file, this.classificationForRollout(file.filePath));
      }
    }
    for (const { file, metadata } of subagentFiles) {
      addSubagentCandidate(file, metadata);
    }
    if (this.firstPoll) {
      const now = Date.now();
      for (const file of files) {
        if (now - file.mtimeMs >= WATCHER_CONFIG.staleWorkingMs) break;
        if (candidatePaths.has(file.filePath)) continue;
        const metadata = this.classificationForRollout(file.filePath);
        if (
          metadata?.threadSource === "subagent" &&
          detectSubagentWorkingFromFile(file.filePath)
        ) {
          addSubagentCandidate(file, metadata);
        }
      }
    }

    const selectedByPath = new Map();
    const metadataToRegister = new Map();
    const metadataChain = (file, metadata) => {
      const chain = [];
      const visited = new Set();
      let currentFile = file;
      let currentMetadata = metadata;
      while (currentFile && currentMetadata?.threadId && !visited.has(currentMetadata.threadId)) {
        visited.add(currentMetadata.threadId);
        chain.push({ file: currentFile, metadata: currentMetadata });
        if (currentMetadata.threadSource === "user" || !currentMetadata.parentThreadId) break;
        currentFile = filesByThreadId.get(currentMetadata.parentThreadId) || null;
        currentMetadata = currentFile
          ? this.classificationForRollout(currentFile.filePath)
          : null;
      }
      return chain.reverse();
    };
    const selectWithinMetadataCapacity = (file, metadata) => {
      const chain = metadataChain(file, metadata);
      const additionalEntries = chain.filter(
        (entry) => !metadataToRegister.has(entry.file.filePath)
      );
      if (
        metadataToRegister.size + additionalEntries.length >
        WATCHER_CONFIG.rolloutMetadataLimit
      ) {
        return false;
      }
      for (const entry of chain) metadataToRegister.set(entry.file.filePath, entry);
      selectedByPath.set(file.filePath, { file, metadata });
      return true;
    };

    // 사용자 root와 각 subagent의 전체 조상 chain이 함께 들어갈 때만 tail 대상으로 승인합니다.
    // 이 경계를 넘긴 내부 파일은 선택하지 않아 사용자 메시지로 잘못 노출될 가능성을 차단합니다.
    for (const { file, metadata } of userFiles) {
      selectWithinMetadataCapacity(file, metadata);
    }
    for (const { file, metadata } of subagentCandidates) {
      selectWithinMetadataCapacity(file, metadata);
    }
    for (const { file, metadata } of metadataToRegister.values()) {
      this.registerRolloutMetadata(file.filePath, metadata);
    }
    return [...selectedByPath.values()]
      .sort((a, b) => b.file.mtimeMs - a.file.mtimeMs)
      .map(({ file }) => file);
  }

  isUserFacingRollout(filePath) {
    return this.metadataForRollout(filePath)?.threadSource === "user";
  }

  metadataForRollout(filePath) {
    if (this.rolloutMetadata.has(filePath)) return this.rolloutMetadata.get(filePath);
    const metadata = this.classificationForRollout(filePath);
    return this.registerRolloutMetadata(filePath, metadata) ? metadata : null;
  }

  classificationForRollout(filePath) {
    if (this.rolloutClassifications.has(filePath)) {
      return this.rolloutClassifications.get(filePath);
    }
    const metadata = readRolloutMetadata(filePath);
    if (!metadata?.threadId) return null;
    this.rolloutClassifications.set(filePath, metadata);
    while (this.rolloutClassifications.size > WATCHER_CONFIG.rolloutClassificationLimit) {
      this.rolloutClassifications.delete(this.rolloutClassifications.keys().next().value);
    }
    return metadata;
  }

  registerRolloutMetadata(filePath, metadata) {
    if (
      !filePath ||
      !metadata?.threadId ||
      !["user", "subagent"].includes(metadata.threadSource)
    ) {
      return false;
    }

    this.rolloutClassifications.set(filePath, metadata);

    const previous = this.rolloutMetadata.get(filePath);
    const unchanged =
      previous?.threadId === metadata.threadId &&
      previous.threadSource === metadata.threadSource &&
      (previous.parentThreadId || null) === (metadata.parentThreadId || null);
    if (unchanged) {
      // 관계가 같으면 tracker를 삭제·재등록하거나 전체 root count를 다시 계산할 필요가 없습니다.
      // Map 순서만 갱신해 현재 tail 대상이 metadata LRU에서 밀리지 않게 합니다.
      this.rolloutMetadata.delete(filePath);
      this.rolloutMetadata.set(filePath, previous);
      return true;
    }
    const preserveActive =
      previous?.threadId === metadata.threadId &&
      metadata.threadSource === "subagent" &&
      this.activeSubagentFiles.has(filePath);
    if (previous?.threadId) {
      this.subagents.removeThread(previous.threadId);
    }
    if (previous?.threadId && previous.threadId !== metadata.threadId) {
      this.activeSubagentFiles.delete(filePath);
      this.lastEventAtByFile.delete(filePath);
    }
    this.subagents.registerThread(metadata);
    this.rolloutMetadata.delete(filePath);
    this.rolloutMetadata.set(filePath, metadata);
    if (preserveActive) this.subagents.setActive(metadata.threadId, true);

    while (this.rolloutMetadata.size > WATCHER_CONFIG.rolloutMetadataLimit) {
      const oldestPath = this.rolloutMetadata.keys().next().value;
      const oldest = this.rolloutMetadata.get(oldestPath);
      this.rolloutMetadata.delete(oldestPath);
      this.activeSubagentFiles.delete(oldestPath);
      this.lastEventAtByFile.delete(oldestPath);
      if (oldest?.threadId) this.subagents.removeThread(oldest.threadId);
    }
    this.emitChangedSubagentCounts();
    return true;
  }

  setSubagentActive(filePath, active) {
    const metadata = this.rolloutMetadata.get(filePath);
    if (metadata?.threadSource !== "subagent") return false;
    if (active) {
      this.activeSubagentFiles.add(filePath);
      this.lastEventAtByFile.set(filePath, Date.now());
    } else {
      this.activeSubagentFiles.delete(filePath);
      this.lastEventAtByFile.delete(filePath);
    }
    this.subagents.setActive(metadata.threadId, active);
    this.emitChangedSubagentCounts();
    return true;
  }

  emitChangedSubagentCounts() {
    const next = this.subagents.countsByRoot();
    const roots = new Set([...this.lastSubagentCounts.keys(), ...next.keys()]);
    for (const threadId of roots) {
      const subagentCount = next.get(threadId) || 0;
      if ((this.lastSubagentCounts.get(threadId) || 0) !== subagentCount) {
        this.emit("subagent-count-changed", { threadId, subagentCount });
      }
    }
    this.lastSubagentCounts = next;
  }

  // tail 중 캐시된 값이 있으면 그대로 쓰고,
  // 없으면(앱 시작 직후 등) 최근 로그/세션 파일들을 뒤에서부터 스캔합니다.
  getUsage() {
    if (this.cachedUsage) return this.cachedUsage;
    return this.refreshUsage();
  }

  // 더블클릭 사용량 조회용입니다.
  // 캐시를 무시하고 Codex sqlite/wal 로그를 먼저 다시 스캔한 뒤, 없으면 세션 JSONL을 스캔합니다.
  refreshUsage() {
    const usage = extractLatestUsageFromLogs() || extractLatestUsageFromSessions();

    if (usage) {
      this.cachedUsage = usage;
      return usage;
    }

    return null;
  }

  poll() {
    const recentFiles = this.listRecentRolloutFiles(WATCHER_CONFIG.tailFiles);
    const recentPaths = new Set(recentFiles.map((f) => f.filePath));

    // 최근 목록에서 밀려난 파일은 추적을 정리합니다.
    for (const filePath of [...this.tails.keys()]) {
      if (!recentPaths.has(filePath)) {
        this.tails.delete(filePath);
        if (this.rolloutMetadata.get(filePath)?.threadSource === "subagent") {
          this.setSubagentActive(filePath, false);
        } else {
          this.clearWorking(filePath, { reason: "stale", message: null });
        }
      }
    }

    // recentFiles는 최신순입니다. 첫 복원만 오래된 파일부터 등록해 두면 구조화된 시작 시각이
    // 없는 세션도 first-seen fallback에서 시작 순서에 가깝게 고정됩니다.
    const filesToPoll = this.firstPoll ? [...recentFiles].reverse() : recentFiles;
    for (const file of filesToPoll) {
      let tail = this.tails.get(file.filePath);

      if (!tail) {
        // 처음 보는 파일: 앱 시작 시점에 이미 있던 파일은 과거 기록을 재생하지 않도록
        // 끝에서 시작하고, 실행 중 새로 생긴 세션 파일은 처음부터 읽습니다.
        tail = { offset: this.firstPoll ? file.size : 0, buffer: "" };
        this.tails.set(file.filePath, tail);

        // 앱 시작 시점에 "작업 중" 상태로 끝난 최근 파일은 각각 복원합니다.
        // 그래야 CodePet보다 먼저 시작한 동시 작업 수도 첫 화면부터 맞습니다.
        const metadata = this.rolloutMetadata.get(file.filePath);
        if (this.firstPoll && Date.now() - file.mtimeMs < WATCHER_CONFIG.staleWorkingMs) {
          if (
            metadata?.threadSource === "subagent" &&
            detectSubagentWorkingFromFile(file.filePath)
          ) {
            this.setSubagentActive(file.filePath, true);
          } else if (
            metadata?.threadSource !== "subagent" &&
            detectWorkingFromFile(file.filePath)
          ) {
            const labels = extractLatestActivityLabelsFromFile(file.filePath);
            this.activityLabels.set(file.filePath, labels);
            this.setWorking(file.filePath, extractActiveTaskStartedAtFromFile(file.filePath));
          }
        }
      }

      if (this.activeSubagentFiles.has(file.filePath)) {
        this.lastEventAtByFile.set(file.filePath, file.mtimeMs);
      }

      // 파일이 줄어들었다면(비정상 케이스) 처음부터 다시 읽습니다.
      if (file.size < tail.offset) {
        tail.offset = 0;
        tail.buffer = "";
      }

      if (file.size > tail.offset) {
        this.readAppended(file.filePath, tail, file.size);
      }
    }

    this.firstPoll = false;

    // 동시 작업 중 하나만 멈춘 경우에도 그 파일만 활성 수에서 빼야 합니다.
    const now = Date.now();
    for (const filePath of [...this.workingFiles]) {
      const lastEventAtMs = this.lastEventAtByFile.get(filePath) || 0;
      if (now - lastEventAtMs > WATCHER_CONFIG.staleWorkingMs) {
        this.clearWorking(filePath, { reason: "stale", message: null });
      }
    }
    for (const filePath of [...this.activeSubagentFiles]) {
      const lastEventAtMs = this.lastEventAtByFile.get(filePath) || 0;
      if (now - lastEventAtMs > WATCHER_CONFIG.staleWorkingMs) {
        this.setSubagentActive(filePath, false);
      }
    }
  }

  readAppended(filePath, tail, currentSize) {
    let fd;
    try {
      fd = fs.openSync(filePath, "r");
    } catch {
      return;
    }

    try {
      const chunkSize = currentSize - tail.offset;
      const buffer = Buffer.alloc(chunkSize);
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, tail.offset);
      tail.offset += bytesRead;

      tail.buffer += buffer.toString("utf8", 0, bytesRead);
      const lines = tail.buffer.split("\n");
      tail.buffer = lines.pop(); // 마지막 조각은 아직 안 끝난 줄일 수 있으므로 버퍼에 남깁니다.

      for (const line of lines) {
        this.handleLine(filePath, line);
      }
    } catch (error) {
      console.warn("[desktop-pet] Codex session read failed.", error.message);
    } finally {
      fs.closeSync(fd);
    }
  }

  contextFor(filePath, labels = this.activityLabels.get(filePath) || {}) {
    const taskStartedAt = this.taskStartedAtByFile.get(filePath) || null;
    return {
      // rollout 파일명에서만 얻은 검증된 id입니다. 모델명은 세션 식별자로 쓰지 않습니다.
      threadId: extractThreadIdFromRolloutPath(filePath),
      workerLabel: labels.workerLabel || null,
      ...(labels.reasoningLabel ? { reasoningLabel: labels.reasoningLabel } : {}),
      activeTaskCount: this.workingFiles.size,
      ...(taskStartedAt ? { taskStartedAt } : {}),
    };
  }

  // 중복 시작은 무시하고, 새 작업/작업 종료는 전체 활성 수가 바뀌었다는 이벤트를 발행합니다.
  setWorking(filePath, taskStartedAt = null) {
    this.lastEventAtByFile.set(filePath, Date.now());
    const learnedStartedAt = !this.taskStartedAtByFile.has(filePath) && taskStartedAt;
    if (learnedStartedAt) {
      this.taskStartedAtByFile.set(filePath, taskStartedAt);
    }
    if (this.workingFiles.has(filePath)) {
      const context = this.contextFor(filePath);
      // 일부 rollout은 tool/user 이벤트가 task_started보다 먼저 올 수 있습니다.
      // 이때도 실제 시작 시각을 state에 전달해 first-seen fallback을 바로잡습니다.
      if (learnedStartedAt) this.emit("working-changed", true, null, context);
      return context;
    }
    this.workingFiles.add(filePath);
    const context = this.contextFor(filePath);
    this.emit("working-changed", true, null, { ...context, activityChange: "started" });
    return context;
  }

  clearWorking(filePath, result) {
    const labels = this.activityLabels.get(filePath) || {};
    this.lastEventAtByFile.delete(filePath);
    if (!this.workingFiles.delete(filePath)) {
      this.taskStartedAtByFile.delete(filePath);
      this.activityLabels.delete(filePath);
      return null;
    }

    const context = this.contextFor(filePath, labels);
    this.taskStartedAtByFile.delete(filePath);
    this.activityLabels.delete(filePath);

    // 다른 작업이 남아 있으면 방금 끝난 파일의 작업자 이름을 전역 작업 말풍선에 재사용하지 않습니다.
    // 남은 작업의 다음 이벤트가 도착하기 전까지는 활성 수만 안전하게 표시합니다.
    const remainingContext = this.working
      ? { workerLabel: null, activeTaskCount: this.workingFiles.size }
      : context;
    this.emit("working-changed", this.working, this.working ? null : result, {
      ...remainingContext,
      threadId: context.threadId,
      activityChange: "removed",
    });
    return context;
  }

  handleResponseItem(filePath, payload) {
    if (!payload || (payload.type !== "function_call" && payload.type !== "custom_tool_call")) {
      return;
    }

    const name = String(payload.name || "").toLowerCase();
    const args = parseFunctionArguments(payload.arguments || payload.input);
    const threadId = extractThreadIdFromRolloutPath(filePath);

    if (name.includes("request_user_input") || name.includes("ask_user")) {
      const context = this.setWorking(filePath);
      this.emit("waiting", { kind: "user-input", threadId, ...context });
      return;
    }

    if (name.includes("approval") || name.includes("request_permission")) {
      const context = this.setWorking(filePath);
      this.emit("waiting", { kind: "approval", threadId, ...context });
      return;
    }

    if (name === "shell_command" || name.endsWith("shell_command")) {
      const context = this.setWorking(filePath);
      this.emit("tool-activity", {
        ...classifyShellCommand(args.command),
        threadId,
        ...context,
      });
      return;
    }

    if (/(^|__)(read|open|find|search|list|view_image)/.test(name)) {
      const context = this.setWorking(filePath);
      this.emit("tool-activity", {
        kind: "read",
        command: null,
        threadId,
        ...context,
      });
    }
  }

  handleSubagentLine(filePath, entry) {
    const type = entry?.type === "event_msg" ? entry.payload?.type : null;
    if (type === "task_started") {
      this.setSubagentActive(filePath, true);
    } else if (type === "task_complete" || type === "turn_aborted") {
      this.setSubagentActive(filePath, false);
    }
  }

  handleLine(filePath, line) {
    if (!line.trim()) return;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }

    if (entry?.type === "session_meta") {
      this.registerRolloutMetadata(filePath, {
        threadId: entry.payload?.id,
        threadSource: entry.payload?.thread_source || "user",
        parentThreadId: entry.payload?.parent_thread_id || null,
      });
      return;
    }

    if (this.rolloutMetadata.get(filePath)?.threadSource === "subagent") {
      this.handleSubagentLine(filePath, entry);
      return;
    }

    if (entry?.type === "response_item") {
      this.handleResponseItem(filePath, entry.payload);
      return;
    }

    if (entry?.type === "turn_context") {
      const labels = activityLabelsFromTurnContext(entry.payload);
      this.activityLabels.set(filePath, labels);
      if (this.workingFiles.has(filePath)) {
        this.lastEventAtByFile.set(filePath, Date.now());
        this.emit("working-changed", true, null, {
          ...this.contextFor(filePath),
          reasoningLabel: labels.reasoningLabel,
        });
      }
      return;
    }

    if (entry?.type !== "event_msg") return;
    const payload = entry.payload;
    if (!payload?.type) return;

    const threadId = extractThreadIdFromRolloutPath(filePath);

    switch (payload.type) {
      case "task_started":
        this.setWorking(filePath, entry.timestamp || null);
        break;

      case "task_complete": {
        const labels = this.activityLabels.get(filePath) || {};
        const context = this.clearWorking(filePath, {
          reason: "complete",
          message: null,
          threadId,
        });
        this.emit("task-finished", {
          reason: "complete",
          message: payload.last_agent_message || null,
          threadId,
          otherTasksWorking: this.working,
          workerLabel: labels.workerLabel || null,
          ...(labels.reasoningLabel ? { reasoningLabel: labels.reasoningLabel } : {}),
          activeTaskCount: context?.activeTaskCount || 0,
        });
        break;
      }

      case "turn_aborted": {
        const labels = this.activityLabels.get(filePath) || {};
        const context = this.clearWorking(filePath, {
          reason: "aborted",
          message: null,
          threadId,
        });
        this.emit("task-finished", {
          reason: "aborted",
          message: null,
          threadId,
          otherTasksWorking: this.working,
          workerLabel: labels.workerLabel || null,
          ...(labels.reasoningLabel ? { reasoningLabel: labels.reasoningLabel } : {}),
          activeTaskCount: context?.activeTaskCount || 0,
        });
        break;
      }

      case "agent_message": {
        const context = this.setWorking(filePath);
        if (payload.message) {
          this.emit("agent-message", payload.message, context);
        }
        break;
      }

      case "user_message": {
        const context = this.setWorking(filePath);
        if (payload.message) {
          this.emit("user-message", payload.message, context);
        }
        break;
      }

      case "patch_apply_end": {
        const context = this.setWorking(filePath);
        // changes의 key가 수정된 파일의 절대 경로입니다. 파일명만 추려서 보냅니다.
        const files = Object.keys(payload.changes || {}).map((p) => path.basename(p));
        if (files.length > 0) {
          this.emit("tool-activity", {
            kind: "patch",
            files,
            success: payload.success !== false,
            threadId,
            ...context,
          });
        }
        break;
      }

      case "web_search_end": {
        const context = this.setWorking(filePath);
        this.emit("tool-activity", {
          kind: "search",
          query: payload.query || null,
          threadId,
          ...context,
        });
        break;
      }

      case "image_generation_end": {
        const context = this.setWorking(filePath);
        this.emit("tool-activity", { kind: "image", threadId, ...context });
        break;
      }

      case "exec_approval_request":
      case "apply_patch_approval_request":
      case "approval_requested": {
        const context = this.setWorking(filePath);
        this.emit("waiting", { kind: "approval", threadId, ...context });
        break;
      }

      case "request_user_input":
      case "user_input_requested": {
        const context = this.setWorking(filePath);
        this.emit("waiting", { kind: "user-input", threadId, ...context });
        break;
      }

      case "token_count": {
        const context = this.setWorking(filePath);
        if (payload.rate_limits) {
          this.cachedUsage = normalizeUsage(
            payload.rate_limits,
            entry.timestamp || null,
            "sessions-tail"
          );
          this.emit("usage-updated", this.cachedUsage, context);
        }
        break;
      }

      default:
        break;
    }
  }
}

module.exports = {
  CodexWatcher,
  classifyShellCommand,
  extractThreadIdFromRolloutPath,
  normalizeReasoningLabel,
  normalizeWorkerLabel,
};
