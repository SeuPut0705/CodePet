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
  const report = typeof payload === "number"
    ? { height: payload }
    : (payload && !Array.isArray(payload) ? payload : {});
  const reportedWorkWidth = roundedFinite(workArea?.width);
  const workWidth = Math.max(
    1,
    reportedWorkWidth === null ? minWidth : reportedWorkWidth
  );
  const availableWidth = Math.max(1, workWidth - marginPx * 2);
  const effectiveMaxWidth = Math.min(maxWidth, availableWidth);
  const effectiveMinWidth = Math.min(minWidth, effectiveMaxWidth);
  const reportedWorkHeight = roundedFinite(workArea?.height);
  const workHeight = Math.max(
    1,
    reportedWorkHeight === null ? minHeight : reportedWorkHeight
  );
  const effectiveMaxHeight = Math.min(maxHeight, workHeight);
  const effectiveMinHeight = Math.min(minHeight, effectiveMaxHeight);
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
      ? clamp(
        roundedFinite(currentHeight) || effectiveMinHeight,
        effectiveMinHeight,
        effectiveMaxHeight
      )
      : clamp(reportedHeight, effectiveMinHeight, effectiveMaxHeight),
  };
}

function positionBubbleBounds({ petBounds, workArea, bubbleSize, gapPx }) {
  const workWidth = Math.max(1, roundedFinite(workArea?.width) || 1);
  const workHeight = Math.max(1, roundedFinite(workArea?.height) || 1);
  const safeBubbleSize = {
    width: clamp(roundedFinite(bubbleSize?.width) || 1, 1, workWidth),
    height: clamp(roundedFinite(bubbleSize?.height) || 1, 1, workHeight),
  };
  const maxX = workArea.x + workWidth - safeBubbleSize.width;
  const centeredX = Math.round(
    petBounds.x + petBounds.width / 2 - safeBubbleSize.width / 2
  );
  const x = clamp(centeredX, workArea.x, maxX);
  let y = Math.round(petBounds.y - safeBubbleSize.height - gapPx);
  if (y < workArea.y) {
    y = Math.round(petBounds.y + petBounds.height + gapPx);
  }
  y = clamp(y, workArea.y, workArea.y + workHeight - safeBubbleSize.height);
  return { x, y, width: safeBubbleSize.width, height: safeBubbleSize.height };
}

module.exports = { normalizeBubbleSize, positionBubbleBounds };
