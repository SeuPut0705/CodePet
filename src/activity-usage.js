const TARGET_WINDOWS = Object.freeze([
  { minutes: 300, key: "5h", accessibleName: "5시간" },
  { minutes: 10080, key: "7d", accessibleName: "7일" },
]);

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

function resetAtMilliseconds(rateWindow) {
  const resetAt = Number(rateWindow?.resets_at ?? rateWindow?.reset_at);
  return Number.isFinite(resetAt) ? resetAt * 1000 : null;
}

function badgeForWindow(rateWindow, target, nowMs) {
  if (!rateWindow || rateWindow.scope) return null;
  if (Number(rateWindow.window_minutes) !== target.minutes) return null;

  const rawUsedPercent = Number(rateWindow.used_percent ?? rateWindow.usedPercent);
  if (!Number.isFinite(rawUsedPercent)) return null;

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
