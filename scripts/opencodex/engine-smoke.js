const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createEngineHost } = require("../../src/open-codex/engine-host");
const { syncKimiCliCredential } = require("../../src/open-codex/kimi-credential-adapter");
const { buildEngine } = require("./build-engine");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function fixtureChunk({ content, finishReason = null }) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-codepet-smoke",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, delta: content === undefined ? {} : { content }, finish_reason: finishReason }],
  })}\n\n`;
}

function fixtureJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "fixture",
  ].join(".");
}

function createHeldUpstream() {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the synthetic request body before streaming the fixture response.
    }
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fixture-model", owned_by: "codepet" }] }));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(fixtureChunk({ content: "stream-held" }));
    await released;
    response.write(fixtureChunk({ finishReason: "stop" }));
    response.end("data: [DONE]\n\n");
  });
  return { release, server };
}

async function listenerIsClosed(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

async function runEngineSmoke({ enginePath, projectRoot = path.resolve(__dirname, "..", "..") } = {}) {
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencodex-engine-smoke-"));
  const codexHome = path.join(smokeRoot, "codex");
  const openCodexHome = path.join(smokeRoot, "opencodex");
  const kimiHome = path.join(smokeRoot, "kimi");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(openCodexHome, { recursive: true });
  fs.mkdirSync(path.join(kimiHome, "credentials"), { recursive: true });

  const kimiAccessToken = fixtureJwt({ user_id: "codepet-smoke-user", email: "smoke@example.com" });
  const kimiRefreshToken = fixtureJwt({ user_id: "codepet-smoke-user" });
  fs.writeFileSync(path.join(kimiHome, "credentials", "kimi-code.json"), `${JSON.stringify({
    access_token: kimiAccessToken,
    refresh_token: kimiRefreshToken,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    scope: "openid",
    token_type: "Bearer",
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(kimiHome, "device_id"), "codepet-smoke-device\n", { mode: 0o600 });
  const credentialSync = syncKimiCliCredential({ kimiHome, openCodexHome });
  if (credentialSync.status !== "synced") throw new Error("OpenCodex smoke Kimi credential sync failed");

  const upstream = createHeldUpstream();
  const upstreamPort = await listen(upstream.server);
  fs.writeFileSync(path.join(openCodexHome, "config.json"), `${JSON.stringify({
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "smoke",
    providers: {
      smoke: {
        adapter: "openai-chat",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        authMode: "key",
        apiKey: "fixture",
        models: ["fixture-model"],
        defaultModel: "fixture-model",
      },
      kimi: {
        adapter: "openai-chat",
        baseUrl: "https://api.kimi.com/coding/v1",
        authMode: "oauth",
        liveModels: false,
        models: ["k3"],
        defaultModel: "k3",
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const resolvedEnginePath = enginePath || path.join(projectRoot, "build", "generated", "opencodex-engine.mjs");
  const host = createEngineHost({
    startupTimeoutMs: 10_000,
    workerData: { enginePath: resolvedEnginePath },
    workerEnv: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: openCodexHome,
    },
  });
  let reader;
  let released = false;
  try {
    const status = await host.start({ port: 0 });
    const healthPayload = await fetch(`http://127.0.0.1:${status.port}/healthz`).then((response) => response.json());
    const kimiStatusResponse = await fetch(`http://127.0.0.1:${status.port}/api/oauth/status?provider=kimi`);
    const kimiStatus = await kimiStatusResponse.json();
    if (!kimiStatusResponse.ok || kimiStatus.loggedIn !== true || kimiStatus.source !== "local-cli") {
      throw new Error("OpenCodex smoke did not load the imported Kimi credential");
    }
    const serializedKimiStatus = JSON.stringify(kimiStatus);
    if (serializedKimiStatus.includes(kimiAccessToken) || serializedKimiStatus.includes(kimiRefreshToken)) {
      throw new Error("OpenCodex smoke OAuth status exposed a Kimi token");
    }
    const modelsResponse = await fetch(`http://127.0.0.1:${status.port}/v1/models`);
    const modelsPayload = await modelsResponse.json();
    const kimiK3Selectable = modelsResponse.ok
      && Array.isArray(modelsPayload.data)
      && modelsPayload.data.some((model) => model?.id === "kimi/k3");
    if (!kimiK3Selectable) throw new Error("OpenCodex smoke catalog did not expose kimi/k3");
    const response = await fetch(`http://127.0.0.1:${status.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "smoke/fixture-model",
        input: "hold this synthetic stream",
        stream: true,
      }),
    });
    if (!response.ok || !response.body) {
      const detail = (await response.text()).replace(/https?:\/\/[^\s"]+/g, "[redacted-url]").slice(0, 300);
      throw new Error(`OpenCodex smoke response failed with HTTP ${response.status}: ${detail}`);
    }
    reader = response.body.getReader();
    const first = await reader.read();
    if (first.done || !first.value?.length) throw new Error("OpenCodex smoke stream produced no first chunk");
    const activeStatus = await host.getStatus();
    if (activeStatus.activeTurns < 1) throw new Error("OpenCodex smoke stream was not tracked as active");

    let stopSettled = false;
    let stopError;
    const stopPromise = host.quiesceAndStop({ timeoutMs: 2_000 })
      .catch((error) => { stopError = error; })
      .finally(() => { stopSettled = true; });
    await delay(75);
    const streamHeldDrain = !stopSettled;
    if (!streamHeldDrain) {
      await stopPromise;
      throw stopError || new Error("OpenCodex engine stopped before active stream completed");
    }

    upstream.release();
    released = true;
    while (!(await reader.read()).done) {
      // Consume the remaining SSE so its active turn can unregister.
    }
    await stopPromise;
    if (stopError) throw stopError;
    const listenerClosed = await listenerIsClosed(status.port);
    if (!listenerClosed) throw new Error("OpenCodex listener stayed open after drain");

    return {
      health: {
        pidMatches: healthPayload.pid === process.pid,
        portMatches: healthPayload.port === status.port,
        service: healthPayload.service,
      },
      kimi: {
        credentialLoaded: kimiStatus.loggedIn === true,
        modelSelectable: kimiK3Selectable,
        statusTokenSafe: true,
      },
      listenerClosed,
      streamHeldDrain,
    };
  } finally {
    if (!released) upstream.release();
    try { await reader?.cancel(); } catch { /* stream already closed */ }
    try { await host.quiesceAndStop({ timeoutMs: 500 }); } catch { /* original failure is authoritative */ }
    await close(upstream.server);
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const enginePath = path.join(projectRoot, "build", "generated", "opencodex-engine.mjs");
  await buildEngine({ projectRoot, outputPath: enginePath });
  const result = await runEngineSmoke({ enginePath, projectRoot });
  process.stdout.write(`OpenCodex engine smoke passed: ${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runEngineSmoke };
