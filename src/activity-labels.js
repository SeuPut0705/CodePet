"use strict";

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

function normalizeWorkerLabel(model) {
  return MODEL_LABELS.get(model) || null;
}

function normalizeReasoningLabel(effort) {
  return REASONING_LABELS.get(effort) || null;
}

function safeWorkerLabel(value) {
  return WORKER_DISPLAY_LABELS.has(value) ? value : null;
}

function safeReasoningLabel(value) {
  return REASONING_DISPLAY_LABELS.has(value) ? value : null;
}

function safeSectionLabel(value) {
  if (typeof value !== "string") return null;
  const label = value.replace(/\s+/g, " ").trim();
  return label ? [...label].slice(0, 80).join("") : null;
}

module.exports = {
  normalizeReasoningLabel,
  normalizeWorkerLabel,
  safeReasoningLabel,
  safeSectionLabel,
  safeWorkerLabel,
};
