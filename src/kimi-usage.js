"use strict";

const TARGETS = new Map([[300, ["5h", "5시간"]], [10080, ["7d", "7일"]]]);

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowMinutes(item, fallback) {
  if (fallback === 10080) return fallback;
  const window = item?.window && typeof item.window === "object" ? item.window : item;
  const duration = finiteNumber(window?.duration);
  const unit = String(window?.timeUnit || "").toUpperCase();
  if (unit === "MINUTE") return duration;
  if (unit === "HOUR") return duration === null ? null : duration * 60;
  if (unit === "DAY") return duration === null ? null : duration * 1440;
  return null;
}

function usageWindow(raw, minutes) {
  if (!raw || typeof raw !== "object" || !TARGETS.has(minutes)) return null;
  const limit = finiteNumber(raw.limit);
  let used = finiteNumber(raw.used);
  const remaining = finiteNumber(raw.remaining);
  if (used === null && remaining !== null && limit !== null) used = limit - remaining;
  if (used === null || limit === null || limit <= 0) return null;
  return { minutes, used, limit };
}

function parseKimiUsageWindows(payload) {
  if (!payload || typeof payload !== "object") return [];
  const byMinutes = new Map();
  for (const item of Array.isArray(payload.limits) ? payload.limits : []) {
    const detail = item?.detail && typeof item.detail === "object" ? item.detail : item;
    const parsed = usageWindow(detail, windowMinutes(item, null));
    if (parsed) byMinutes.set(parsed.minutes, parsed);
  }
  const weekly = usageWindow(payload.usage, 10080);
  if (weekly) byMinutes.set(10080, weekly);
  return [...TARGETS.keys()].flatMap((minutes) => byMinutes.has(minutes) ? [byMinutes.get(minutes)] : []);
}

function buildKimiUsageBadges(payload) {
  return parseKimiUsageWindows(payload).map(({ minutes, used, limit }) => {
    const [key, name] = TARGETS.get(minutes);
    const remainingPercent = Math.round(Math.min(100, Math.max(0, (limit - used) / limit * 100)));
    return { key, remainingPercent, ariaLabel: `Kimi ${name} ${remainingPercent}% 남음` };
  });
}

module.exports = { buildKimiUsageBadges, parseKimiUsageWindows };
