const TARGET_WINDOWS = Object.freeze([
  { minutes: 300, key: "5h", accessibleName: "5시간" },
  { minutes: 10080, key: "7d", accessibleName: "7일" },
]);

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

function buildActivityUsageBadges(usage, nowMs = Date.now()) {
  const rateLimits = usage?.rateLimits;
  if (!rateLimits || typeof rateLimits !== "object") return [];

  const windows = Array.isArray(rateLimits.windows)
    ? rateLimits.windows
    : [rateLimits.primary, rateLimits.secondary].filter(Boolean);

  return TARGET_WINDOWS.flatMap((target) => {
    for (const rateWindow of windows) {
      const badge = badgeForWindow(rateWindow, target, nowMs);
      if (badge) return [badge];
    }
    return [];
  });
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
  buildActivityUsageBadges,
  decorateActivityBubbleWithUsage,
};
