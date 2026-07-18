const { createActivityHeading } = require("./activity-title");
const { safeReasoningLabel, safeSectionLabel, safeWorkerLabel } = require("./activity-labels");

function updatedLabel(context, key, normalize, previous = null) {
  if (!Object.hasOwn(context, key)) return previous;
  return normalize(context[key]);
}

function safeSubagentCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function updatedSubagentCount(context, previous = 0) {
  if (!Object.hasOwn(context, "subagentCount")) return previous;
  return safeSubagentCount(context.subagentCount);
}

// Watcher 활동을 rollout thread 단위로 보관합니다. 화면은 이 상태의 스냅샷만 렌더링하므로
// 한 세션의 새 이벤트가 다른 세션의 내용을 덮어쓰지 않습니다.
class ActivityBubbleState {
  constructor() {
    this.activities = new Map();
    this.pendingSubagentCounts = new Map();
    this.sequence = 0;
  }

  upsert(threadId, data, context = {}) {
    if (!threadId || !data) return false;

    const existing = this.activities.get(threadId);
    const pendingSubagentCount = this.pendingSubagentCounts.get(threadId);
    this.pendingSubagentCounts.delete(threadId);
    const firstSeen = existing?.firstSeen || ++this.sequence;
    const startedAt = existing?.startedAt ?? normalizeStartedAt(context.taskStartedAt);
    this.activities.set(threadId, {
      threadId,
      data: { ...data },
      sectionLabel: updatedLabel(
        context,
        "sectionLabel",
        safeSectionLabel,
        existing?.sectionLabel
      ),
      workerLabel: updatedLabel(context, "workerLabel", safeWorkerLabel, existing?.workerLabel),
      reasoningLabel: updatedLabel(
        context,
        "reasoningLabel",
        safeReasoningLabel,
        existing?.reasoningLabel
      ),
      subagentCount: Object.hasOwn(context, "subagentCount")
        ? safeSubagentCount(context.subagentCount)
        : pendingSubagentCount ?? existing?.subagentCount ?? 0,
      startedAt,
      firstSeen,
    });
    return true;
  }

  remove(threadId) {
    this.pendingSubagentCounts.delete(threadId);
    return this.activities.delete(threadId);
  }

  // turn_context처럼 상세 활동이 없는 이벤트는 기존 내용을 보존합니다. 시작 순서는 절대 바꾸지 않습니다.
  refresh(threadId, context = {}) {
    const existing = this.activities.get(threadId);
    if (!existing) {
      if (Object.hasOwn(context, "subagentCount")) {
        const subagentCount = safeSubagentCount(context.subagentCount);
        if (subagentCount > 0) this.pendingSubagentCounts.set(threadId, subagentCount);
        else this.pendingSubagentCounts.delete(threadId);
      }
      return false;
    }

    existing.sectionLabel = updatedLabel(
      context,
      "sectionLabel",
      safeSectionLabel,
      existing.sectionLabel
    );
    existing.workerLabel = updatedLabel(
      context,
      "workerLabel",
      safeWorkerLabel,
      existing.workerLabel
    );
    existing.reasoningLabel = updatedLabel(
      context,
      "reasoningLabel",
      safeReasoningLabel,
      existing.reasoningLabel
    );
    existing.subagentCount = updatedSubagentCount(context, existing.subagentCount);
    existing.startedAt ??= normalizeStartedAt(context.taskStartedAt);
    return true;
  }

  clear() {
    this.activities.clear();
    this.pendingSubagentCounts.clear();
  }

  get size() {
    return this.activities.size;
  }

  orderedEntries() {
    return [...this.activities.values()].sort((a, b) => {
      if (a.startedAt !== null && b.startedAt !== null && a.startedAt !== b.startedAt) {
        return a.startedAt - b.startedAt;
      }
      if (a.startedAt !== null && b.startedAt === null) return -1;
      if (a.startedAt === null && b.startedAt !== null) return 1;
      return a.firstSeen - b.firstSeen;
    });
  }

  getVisibleThreadIds() {
    return this.orderedEntries().slice(0, 5).map((entry) => entry.threadId);
  }

  // 여러 작업도 제목과 내용을 같은 section에 묶어 어느 세션의 대화인지 바로 알 수 있게 합니다.
  toBubbleData() {
    const entries = this.orderedEntries();
    if (entries.length === 0) return null;

    const activeTaskCount = entries.length;
    const visibleEntries = entries.slice(0, 5);
    const sections = visibleEntries.map((entry) => {
      const titleContext = {
        sectionLabel: entry.sectionLabel,
        workerLabel: entry.workerLabel,
        reasoningLabel: entry.reasoningLabel,
      };
      const heading = createActivityHeading(entry.data.title, titleContext);
      return {
        ...entry.data,
        ...heading,
        threadId: entry.threadId,
        subagentCount: entry.subagentCount,
        titleLabel:
          entry.subagentCount > 0
            ? `${heading.titleLabel} · 활성 서브에이전트 ${entry.subagentCount}개`
            : heading.titleLabel,
      };
    });

    if (sections.length === 1) return sections[0];
    return {
      kind: "activity",
      title: `총 ${activeTaskCount}개 작업 중`,
      activeTaskCount,
      sections,
    };
  }
}

function normalizeStartedAt(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// full은 각 제목 아래 실제 대화를, status는 각 제목 아래 상태 문구만 표시합니다.
function applyActivityPrivacy(data, mode) {
  if (!data || mode === "off") return null;

  const applyToSection = (section) => {
    const visible = { ...section };
    if (mode === "status") {
      visible.text = section.statusText || section.title || "Codex가 작업 중입니다.";
    }
    delete visible.statusText;
    return visible;
  };

  if (Array.isArray(data.sections)) {
    return {
      ...data,
      sections: data.sections.map((section) => applyToSection(section)),
    };
  }

  return applyToSection(data);
}

function shouldRestoreActiveActivityBubble({ activeActivityCount, anyProviderWorking }) {
  return Boolean(anyProviderWorking && activeActivityCount > 0);
}

module.exports = {
  ActivityBubbleState,
  applyActivityPrivacy,
  shouldRestoreActiveActivityBubble,
};
