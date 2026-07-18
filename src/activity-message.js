function stripMarkdown(value) {
  const source = String(value ?? "")
    .replace(/```[^\n]*\n?[\s\S]*?```/g, "\n[코드]\n")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:strong|b|em|i|p|div|span)(?:\s[^<>]*?)?\/?>/g, "");

  const lines = source.split(/\r?\n/).map((line) => line.replace(/[ \t]+/g, " ").trim());
  const normalized = [];
  for (const line of lines) {
    if (!line && normalized.at(-1) === "") continue;
    normalized.push(line);
  }
  return normalized.join("\n").trim();
}

function graphemes(value) {
  if (typeof Intl?.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
    return [...segmenter.segment(value)].map((entry) => entry.segment);
  }
  return Array.from(value);
}

function takeGraphemes(value, limit) {
  return graphemes(String(value ?? "")).slice(0, limit).join("");
}

function formatActivityMessage(value, { maxChars = 240 } = {}) {
  const plainText = stripMarkdown(value);
  const characters = graphemes(plainText);
  if (characters.length <= maxChars) return plainText;
  return `${takeGraphemes(plainText, maxChars).trimEnd()}…`;
}

module.exports = { formatActivityMessage, stripMarkdown, takeGraphemes };
