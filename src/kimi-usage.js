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
  if (unit === "MINUTE" || unit === "TIME_UNIT_MINUTE") return duration;
  if (unit === "HOUR" || unit === "TIME_UNIT_HOUR") return duration === null ? null : duration * 60;
  if (unit === "DAY" || unit === "TIME_UNIT_DAY") return duration === null ? null : duration * 1440;
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

function buildKimiUsageGauges(windows) {
  if (!Array.isArray(windows)) return [];
  return windows.flatMap((window) => {
    const meta = TARGETS.get(window?.minutes);
    const used = finiteNumber(window?.used);
    const limit = finiteNumber(window?.limit);
    if (!meta || used === null || limit === null || limit <= 0) return [];
    const [, name] = meta;
    const usedPercent = Math.round(Math.min(100, Math.max(0, (used / limit) * 100)));
    return [{ label: `${name} 한도`, usedPercent, resetText: `${name} 주기` }];
  });
}

module.exports = { buildKimiUsageBadges, buildKimiUsageGauges, parseKimiUsageWindows };
