"use strict";

const MODEL_LABELS = new Map([
  ["gpt-5.6-sol", "Sol"],
  ["gpt-5.6-terra", "Terra"],
  ["gpt-5.6-luna", "Luna"],
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

module.exports = {
  normalizeReasoningLabel,
  normalizeWorkerLabel,
  safeReasoningLabel,
  safeWorkerLabel,
};
