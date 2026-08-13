"use strict";

const path = require("node:path");

const MODEL_LABELS = new Map([
  ["gpt-5.6-sol", "Sol"],
  ["gpt-5.6-terra", "Terra"],
  ["gpt-5.6-luna", "Luna"],
  ["k3", "K3"],
  ["kimi-code/k3", "K3"],
  ["kimi-for-coding", "K2.7 Coding"],
  ["kimi-code/kimi-for-coding", "K2.7 Coding"],
  ["kimi-for-coding-highspeed", "K2.7 Coding Highspeed"],
  ["kimi-code/kimi-for-coding-highspeed", "K2.7 Coding Highspeed"],
]);
const REASONING_LABELS = new Map([
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "XHigh"],
  ["max", "Max"],
  ["ultra", "Ultra"],
]);

const WORKER_DISPLAY_LABELS = new Set(MODEL_LABELS.values());
const REASONING_DISPLAY_LABELS = new Set(REASONING_LABELS.values());
const EXTERNAL_MODEL_LABEL = /^(?:Gemini|Claude|GPT|Kimi|Copilot|Cursor|OpenCode|Windsurf)(?:[ A-Za-z0-9._+/-]{1,48})?$/;

function normalizeWorkerLabel(model) {
  return MODEL_LABELS.get(model) || null;
}

function normalizeReasoningLabel(effort) {
  return REASONING_LABELS.get(effort) || null;
}

function safeWorkerLabel(value) {
  if (WORKER_DISPLAY_LABELS.has(value)) return value;
  const label = safeSectionLabel(value);
  return label && EXTERNAL_MODEL_LABEL.test(label) ? label : null;
}

function safeReasoningLabel(value) {
  return REASONING_DISPLAY_LABELS.has(value) ? value : null;
}

function safeSectionLabel(value) {
  if (typeof value !== "string") return null;
  const label = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return label ? [...label].slice(0, 80).join("") : null;
}

function projectLabelFromCwd(cwd, fallback = null) {
  if (typeof cwd !== "string" || !cwd.trim()) return safeSectionLabel(fallback);
  const normalized = cwd.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const basename = path.posix.basename(normalized);
  if (/^[a-z]:$/i.test(basename)) return safeSectionLabel(fallback);
  return safeSectionLabel(basename) || safeSectionLabel(fallback);
}

module.exports = {
  normalizeReasoningLabel,
  normalizeWorkerLabel,
  projectLabelFromCwd,
  safeReasoningLabel,
  safeSectionLabel,
  safeWorkerLabel,
};
