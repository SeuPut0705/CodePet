const fs = require("node:fs");
const path = require("node:path");

const PATCH_ID = "redact-upstream-credential-literals";
const REPLACEMENTS = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]"],
  [/GOCSPX-[A-Za-z0-9_-]{10,}/g, "[REDACTED_GOOGLE_CLIENT_SECRET]"],
  [/AIza[0-9A-Za-z_-]{30,}/g, "[REDACTED_GOOGLE_API_KEY]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
];

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function applyUpstreamCredentialRedaction({ vendorDir }) {
  let filesChanged = 0;
  for (const filePath of listFiles(vendorDir)) {
    const bytes = fs.readFileSync(filePath);
    if (bytes.includes(0)) continue;
    const original = bytes.toString("utf8");
    let redacted = original;
    for (const [pattern, replacement] of REPLACEMENTS) {
      redacted = redacted.replace(pattern, replacement);
    }
    if (redacted !== original) {
      fs.writeFileSync(filePath, redacted);
      filesChanged += 1;
    }
  }
  return {
    changed: filesChanged > 0,
    filesChanged,
    id: PATCH_ID,
  };
}

module.exports = {
  apply: applyUpstreamCredentialRedaction,
  applyUpstreamCredentialRedaction,
};
