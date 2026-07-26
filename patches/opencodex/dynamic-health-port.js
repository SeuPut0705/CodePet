const fs = require("node:fs");
const path = require("node:path");

const PATCH_ID = "dynamic-health-port";
const FETCH_ORIGINAL = "async fetch(req, requestServer): Promise<Response> {\n      const url";
const FETCH_PATCHED = [
  "async fetch(req, requestServer): Promise<Response> {",
  "      const actualRequestPort = requestServer.port ?? listenPort;",
  "      if (actualRequestPort !== listenPort) setCorsOrigin(actualRequestPort);",
  "      const url",
].join("\n");
const HEALTH_ORIGINAL = "port: listenPort }, 200, req, config);";
const HEALTH_PATCHED = "port: actualRequestPort }, 200, req, config);";

function applyDynamicHealthPort({ vendorDir }) {
  const relativePath = "src/server/index.ts";
  const filePath = path.join(vendorDir, ...relativePath.split("/"));
  const original = fs.readFileSync(filePath, "utf8");
  if (original.includes(FETCH_PATCHED) && original.includes(HEALTH_PATCHED)) {
    return { changed: false, id: PATCH_ID, relativePath };
  }

  const fetchMatches = original.split(FETCH_ORIGINAL).length - 1;
  const healthMatches = original.split(HEALTH_ORIGINAL).length - 1;
  if (fetchMatches !== 1 || healthMatches !== 1) {
    throw new Error(`${PATCH_ID}: expected one fetch and health port expression, found ${fetchMatches}/${healthMatches}`);
  }
  fs.writeFileSync(
    filePath,
    original.replace(FETCH_ORIGINAL, FETCH_PATCHED).replace(HEALTH_ORIGINAL, HEALTH_PATCHED)
  );
  return { changed: true, id: PATCH_ID, relativePath };
}

module.exports = {
  apply: applyDynamicHealthPort,
  applyDynamicHealthPort,
};
