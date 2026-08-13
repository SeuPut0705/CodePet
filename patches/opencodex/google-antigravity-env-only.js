const fs = require("node:fs");
const path = require("node:path");

const PATCH_ID = "google-antigravity-env-only";
const ASSERTION_NAME = "assertGoogleAntigravityOAuthEnvironment";

function replaceOnce(source, pattern, replacement, description) {
  const matches = source.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`));
  if (!matches || matches.length !== 1) {
    throw new Error(`${PATCH_ID}: expected one ${description}, found ${matches?.length || 0}`);
  }
  return source.replace(pattern, replacement);
}

function applyGoogleAntigravityEnvOnly({ vendorDir }) {
  const filePath = path.join(vendorDir, "src", "oauth", "google-antigravity.ts");
  const original = fs.readFileSync(filePath, "utf8");
  if (original.includes(`function ${ASSERTION_NAME}()`)) {
    return { changed: false, id: PATCH_ID, relativePath: "src/oauth/google-antigravity.ts" };
  }

  let patched = replaceOnce(
    original,
    /const CLIENT_ID = process\.env\.GOOGLE_ANTIGRAVITY_CLIENT_ID\s*\|\|\s*"[^"]+";\s*const CLIENT_SECRET = process\.env\.GOOGLE_ANTIGRAVITY_CLIENT_SECRET\s*\|\|\s*"[^"]+";/,
    [
      'const CLIENT_ID = process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID?.trim() || "";',
      'const CLIENT_SECRET = process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET?.trim() || "";',
      "",
      `function ${ASSERTION_NAME}(): void {`,
      "  if (!CLIENT_ID || !CLIENT_SECRET) {",
      '    throw new Error("Google Antigravity OAuth requires GOOGLE_ANTIGRAVITY_CLIENT_ID and GOOGLE_ANTIGRAVITY_CLIENT_SECRET");',
      "  }",
      "}",
    ].join("\n"),
    "static OAuth credential block"
  );

  const entryPoints = [
    {
      pattern: /^([ \t]*async generateAuthUrl[^\n]+\{\r?\n)/m,
      description: "generateAuthUrl entry point",
    },
    {
      pattern: /^([ \t]*async exchangeToken[^\n]+\{\r?\n)/m,
      description: "exchangeToken entry point",
    },
    {
      pattern: /^(export async function refreshAntigravityToken[^\n]+\{\r?\n)/m,
      description: "refreshAntigravityToken entry point",
    },
  ];
  for (const entryPoint of entryPoints) {
    patched = replaceOnce(
      patched,
      entryPoint.pattern,
      `$1  ${ASSERTION_NAME}();\n`,
      entryPoint.description
    );
  }

  fs.writeFileSync(filePath, patched);
  return { changed: true, id: PATCH_ID, relativePath: "src/oauth/google-antigravity.ts" };
}

module.exports = {
  apply: applyGoogleAntigravityEnvOnly,
  applyGoogleAntigravityEnvOnly,
};
