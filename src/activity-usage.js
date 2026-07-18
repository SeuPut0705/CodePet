const TARGET_WINDOWS = Object.freeze([
  { minutes: 300, key: "5h", accessibleName: "5시간" },
  { minutes: 10080, key: "7d", accessibleName: "7일" },
]);
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
    ariaLabel: `${target.accessibleName} ${remainingPercent}% 남음`,
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

  return TARGET_WINDOWS.flatMap((target) => {
    for (const rateWindow of windows) {
      const badge = badgeForWindow(rateWindow, target, nowMs);
      if (badge) return [badge];
    }
    return [];
  });
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
    for (const rateWindow of rateLimitWindows(this.latestUsage())) {
      const target = TARGET_WINDOWS.find(
        ({ minutes }) => normalizeFiniteNumber(rateWindow?.window_minutes) === minutes
      );
      if (!target || !badgeForWindow(rateWindow, target, nowMs)) continue;
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

function decorateActivityBubbleWithUsage(
  data,
  usageBadges,
  { codexWorking = false } = {}
) {
  if (
    !data ||
    !codexWorking ||
    !Array.isArray(data.sections) ||
    data.sections.length < 2 ||
    !Array.isArray(usageBadges) ||
    usageBadges.length === 0
  ) {
    return data;
  }
  return { ...data, usageBadges: usageBadges.map((badge) => ({ ...badge })) };
}

module.exports = {
  ActivityUsageState,
  ActivityUsageController,
  MAX_TIMER_DELAY_MS,
  buildActivityUsageBadges,
  decorateActivityBubbleWithUsage,
};
