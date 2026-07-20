function roundedFinite(value) {
  if (typeof value === "string" && !value.trim()) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeBubbleSize(payload, options) {
  const {
    workArea,
    currentWidth,
    currentHeight,
    minWidth,
    maxWidth,
    minHeight,
    maxHeight,
    marginPx,
  } = options;
  const report = typeof payload === "number" ? { height: payload } : (payload || {});
  const workWidth = Math.max(1, roundedFinite(workArea?.width) || minWidth);
  const availableWidth = Math.max(1, workWidth - marginPx * 2);
  const effectiveMaxWidth = Math.min(maxWidth, availableWidth);
  const effectiveMinWidth = Math.min(minWidth, effectiveMaxWidth);
  const reportedWidth = roundedFinite(report.width);
  const reportedHeight = roundedFinite(report.height);
  const safeCurrentWidth = clamp(
    roundedFinite(currentWidth) || effectiveMinWidth,
    effectiveMinWidth,
    effectiveMaxWidth
  );
  return {
    width: reportedWidth === null
      ? safeCurrentWidth
      : clamp(reportedWidth, effectiveMinWidth, effectiveMaxWidth),
    height: reportedHeight === null
      ? clamp(roundedFinite(currentHeight) || minHeight, minHeight, maxHeight)
      : clamp(reportedHeight, minHeight, maxHeight),
  };
}

function positionBubbleBounds({ petBounds, workArea, bubbleSize, gapPx }) {
  const maxX = workArea.x + workArea.width - bubbleSize.width;
  const centeredX = Math.round(
    petBounds.x + petBounds.width / 2 - bubbleSize.width / 2
  );
  const x = clamp(centeredX, workArea.x, maxX);
  let y = Math.round(petBounds.y - bubbleSize.height - gapPx);
  if (y < workArea.y) {
    y = Math.round(petBounds.y + petBounds.height + gapPx);
  }
  y = clamp(y, workArea.y, workArea.y + workArea.height - bubbleSize.height);
  return { x, y, width: bubbleSize.width, height: bubbleSize.height };
}

module.exports = { normalizeBubbleSize, positionBubbleBounds };
