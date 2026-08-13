const TARGET_WINDOWS = Object.freeze([
  { minutes: 300, key: "5h", accessibleName: "5시간", priority: 0 },
  { minutes: 10080, key: "7d", accessibleName: "7일", priority: 1 },
]);
const MAX_ACTIVITY_USAGE_BADGES = 2;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

function normalizeFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;

  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function resetAtMilliseconds(rateWindow) {
  const resetAt = normalizeFiniteNumber(rateWindow?.resets_at ?? rateWindow?.reset_at);
  return resetAt === null ? null : resetAt * 1000;
}

function targetForWindow(rateWindow) {
  const minutes = normalizeFiniteNumber(rateWindow?.window_minutes);
  if (minutes === null || minutes <= 0) return null;

  const known = TARGET_WINDOWS.find((target) => target.minutes === minutes);
  if (known) return known;

  if (minutes >= 28 * 1440 && minutes <= 31 * 1440) {
    return { minutes, key: "1mo", accessibleName: "월간", priority: 2 };
  }
  if (Number.isInteger(minutes / 1440) && minutes / 1440 <= 999) {
    const days = minutes / 1440;
    return { minutes, key: `${days}d`, accessibleName: `${days}일`, priority: 3 };
  }
  if (Number.isInteger(minutes / 60) && minutes / 60 <= 999) {
    const hours = minutes / 60;
    return { minutes, key: `${hours}h`, accessibleName: `${hours}시간`, priority: 4 };
  }
  if (Number.isInteger(minutes) && minutes <= 999) {
    return { minutes, key: `${minutes}m`, accessibleName: `${minutes}분`, priority: 5 };
  }
  return null;
}

function badgeForWindow(rateWindow, target, nowMs) {
  if (!rateWindow || rateWindow.scope) return null;
  if (normalizeFiniteNumber(rateWindow.window_minutes) !== target.minutes) return null;

  const rawUsedPercent = normalizeFiniteNumber(
    rateWindow.used_percent ?? rateWindow.usedPercent
  );
  if (rawUsedPercent === null) return null;

  const resetAtMs = resetAtMilliseconds(rateWindow);
  if (resetAtMs === null) return null;

  const usedPercent = resetAtMs <= nowMs
    ? 0
    : clampPercent(rawUsedPercent);
  const remainingPercent = Math.round(100 - usedPercent);
  return {
    key: target.key,
    remainingPercent,
    ariaLabel: `Codex ${target.accessibleName} ${remainingPercent}% 남음`,
  };
}

function rateLimitWindows(usage) {
  const rateLimits = usage?.rateLimits;
  if (!rateLimits || typeof rateLimits !== "object") return [];
  return Array.isArray(rateLimits.windows)
    ? rateLimits.windows
    : [rateLimits.primary, rateLimits.secondary].filter(Boolean);
}

function buildActivityUsageBadges(usage, nowMs = Date.now()) {
  const windows = rateLimitWindows(usage);
  const candidates = windows.flatMap((rateWindow, index) => {
    const target = targetForWindow(rateWindow);
    const badge = target ? badgeForWindow(rateWindow, target, nowMs) : null;
    return badge ? [{ badge, target, index }] : [];
  });
  candidates.sort((left, right) => (
    left.target.priority - right.target.priority ||
    left.target.minutes - right.target.minutes ||
    left.index - right.index
  ));

  const seen = new Set();
  const badges = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.badge.key)) continue;
    seen.add(candidate.badge.key);
    badges.push(candidate.badge);
    if (badges.length >= MAX_ACTIVITY_USAGE_BADGES) break;
  }
  return badges;
}

function usageBadgesEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((badge, index) => (
      badge.key === right[index].key &&
      badge.remainingPercent === right[index].remainingPercent &&
      badge.ariaLabel === right[index].ariaLabel
    ))
  );
}

class ActivityUsageState {
  constructor() {
    this.sessions = new Map();
    this.sequence = 0;
    this.observedBadges = [];
  }

  update(threadId, usage, nowMs = Date.now()) {
    if (typeof threadId !== "string" || !threadId) return false;
    this.sessions.set(threadId, { usage, sequence: ++this.sequence });
    return this.refresh(nowMs);
  }

  remove(threadId, nowMs = Date.now()) {
    if (!this.sessions.delete(threadId)) return false;
    return this.refresh(nowMs);
  }

  clear(nowMs = Date.now()) {
    this.sessions.clear();
    return this.refresh(nowMs);
  }

  latestUsage() {
    let latest = null;
    for (const session of this.sessions.values()) {
      if (!latest || session.sequence > latest.sequence) latest = session;
    }
    return latest?.usage || null;
  }

  buildBadges(nowMs = Date.now()) {
    return buildActivityUsageBadges(this.latestUsage(), nowMs);
  }

  refresh(nowMs = Date.now()) {
    const nextBadges = this.buildBadges(nowMs);
    const changed = !usageBadgesEqual(this.observedBadges, nextBadges);
    this.observedBadges = nextBadges;
    return changed;
  }

  nextResetAt(nowMs = Date.now()) {
    let nextResetAt = null;
    const visibleKeys = new Set(this.buildBadges(nowMs).map((badge) => badge.key));
    for (const rateWindow of rateLimitWindows(this.latestUsage())) {
      const target = targetForWindow(rateWindow);
      if (
        !target ||
        !visibleKeys.has(target.key) ||
        !badgeForWindow(rateWindow, target, nowMs)
      ) continue;
      const resetAtMs = resetAtMilliseconds(rateWindow);
      if (resetAtMs <= nowMs) continue;
      if (nextResetAt === null || resetAtMs < nextResetAt) nextResetAt = resetAtMs;
    }
    return nextResetAt;
  }
}

class ActivityUsageController {
  constructor({
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onBadgesChanged = () => {},
  } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onBadgesChanged = onBadgesChanged;
    this.state = new ActivityUsageState();
    this.timerId = null;
    this.disposed = false;
  }

  cancelTimer() {
    if (this.timerId === null) return;
    this.clearTimer(this.timerId);
    this.timerId = null;
  }

  scheduleReset() {
    this.cancelTimer();
    if (this.disposed) return;
    const nowMs = this.now();
    const resetAtMs = this.state.nextResetAt(nowMs);
    if (!Number.isFinite(resetAtMs)) return;
    this.timerId = this.setTimer(() => {
      this.timerId = null;
      if (this.disposed) return;
      const changed = this.state.refresh(this.now());
      this.scheduleReset();
      if (changed) this.onBadgesChanged(this.buildBadges());
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, resetAtMs - nowMs)));
  }

  update(threadId, usage) {
    if (this.disposed) return false;
    const changed = this.state.update(threadId, usage, this.now());
    this.scheduleReset();
    if (changed) this.onBadgesChanged(this.buildBadges());
    return changed;
  }

  remove(threadId) {
    if (this.disposed) return false;
    const changed = this.state.remove(threadId, this.now());
    this.scheduleReset();
    if (changed) this.onBadgesChanged(this.buildBadges());
    return changed;
  }

  clear() {
    if (this.disposed) return false;
    const changed = this.state.clear(this.now());
    this.scheduleReset();
    if (changed) this.onBadgesChanged(this.buildBadges());
    return changed;
  }

  buildBadges() {
    return this.state.buildBadges(this.now());
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    this.state.clear(this.now());
  }
}

function decorateActivityBubbleWithProviderUsage(data, usageByProvider = {}) {
  if (!data) return data;
  const seen = new Set();
  const decorate = (section) => {
    const provider = section?.provider;
    const badges = Array.isArray(usageByProvider?.[provider])
      ? usageByProvider[provider]
      : [];
    const usageEligible = provider !== "kimi" || section?.managedUsageEligible === true;
    if (!provider || !usageEligible || seen.has(provider) || badges.length === 0) {
      return { ...section, usageBadges: [] };
    }
    seen.add(provider);
    return { ...section, usageBadges: badges.map((badge) => ({ ...badge })) };
  };
  if (Array.isArray(data.sections)) {
    return { ...data, sections: data.sections.map(decorate) };
  }
  return decorate(data);
}

// 기존 Codex watcher lifecycle은 다음 단계에서 provider별 controller로 교체합니다.
// 그 전까지 현재 Codex 사용량도 새 section-scoped renderer 계약을 따르게 합니다.
function decorateActivityBubbleWithUsage(data, usageBadges, { codexWorking = false } = {}) {
  return decorateActivityBubbleWithProviderUsage(data, {
    codex: codexWorking && Array.isArray(usageBadges) ? usageBadges : [],
  });
}

module.exports = {
  ActivityUsageState,
  ActivityUsageController,
  MAX_TIMER_DELAY_MS,
  buildActivityUsageBadges,
  decorateActivityBubbleWithProviderUsage,
  decorateActivityBubbleWithUsage,
};
