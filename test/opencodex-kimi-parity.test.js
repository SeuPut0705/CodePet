"use strict";

// Engine-level Kimi parity tests (fixture-only; no real api.kimi.com traffic).
// The engine runs with the exact serving config built by serving-lifecycle's
// buildServingConfig + the KIMI_CODEX_MODELS list, while a fetch-shim worker
// redirects the hardcoded Kimi hosts to a local fixture — same pattern as the
// cutover spike (docs/superpowers/specs/2026-07-28-opencodex-cutover-design.md).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildEngine } = require("../scripts/opencodex/build-engine");
const { createEngineHost } = require("../src/open-codex/engine-host");
const { syncKimiCliCredential } = require("../src/open-codex/kimi-credential-adapter");
const { buildServingConfig } = require("../src/open-codex/serving-lifecycle");
const { KIMI_CODEX_MODELS } = require("../src/kimi-codex-models");

const projectRoot = path.resolve(__dirname, "..");

// Expected upstream model id per CodePet slug (byte-identical to the mapping
// decision in KIMI_ENGINE_MODEL_BY_SLUG, after the k3[1m] bracket strip).
const EXPECTED_UPSTREAM_MODEL = {
  "codepet-kimi-k3": "k3",
  "codepet-kimi-k3-256k": "k3",
  "codepet-kimi-k2-7-coding": "kimi-for-coding",
  "codepet-kimi-k2-7-coding-fast": "kimi-for-coding-highspeed",
};

const FETCH_SHIM = `"use strict";
const FIXTURE_PORT = process.env.OCX_FIXTURE_PORT;
const REDIRECT_HOSTS = ["https://api.kimi.com", "https://auth.kimi.com", "https://chatgpt.com", "https://auth.openai.com"];
const original = globalThis.fetch;
globalThis.fetch = function patchedFetch(input, init) {
  const url = typeof input === "string" ? input : input && input.url;
  if (FIXTURE_PORT && typeof url === "string") {
    for (const host of REDIRECT_HOSTS) {
      if (url.startsWith(host + "/")) return original("http://127.0.0.1:" + FIXTURE_PORT + url.slice(host.length), init);
    }
  }
  return original(input, init);
};
`;

function parityWorkerSource(engineInterfacePath) {
  return `"use strict";
require("./fetch-shim.cjs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { parentPort, workerData } = require("node:worker_threads");
const {
  EngineHostError,
  requirePlainObject,
  serializeEngineError,
} = require(${JSON.stringify(engineInterfacePath)});
if (!parentPort) throw new Error("parity worker requires a parent port");
const enginePath = path.resolve(workerData.enginePath);
let enginePromise;
function loadEngine() {
  if (!enginePromise) enginePromise = import(pathToFileURL(enginePath).href);
  return enginePromise;
}
parentPort.on("message", async (message) => {
  const id = message && message.id;
  if (!Number.isSafeInteger(id) || typeof message.type !== "string") return;
  try {
    const engine = await loadEngine();
    let result;
    if (message.type === "start") result = await engine.startEmbeddedEngine({ port: message.payload.configuration.port });
    else if (message.type === "getStatus") result = engine.getEmbeddedEngineStatus();
    else if (message.type === "quiesceAndStop") result = await engine.stopEmbeddedEngine({ timeoutMs: message.payload.timeoutMs });
    else throw new EngineHostError("ENGINE_UNKNOWN_REQUEST", "unknown parity worker request");
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: serializeEngineError(error) });
  }
});
`;
}

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "fixture",
  ].join(".");
}

function chatChunk({ content, reasoning, toolCalls, finishReason = null, usage = null }) {
  const delta = {};
  if (content !== undefined) delta.content = content;
  if (reasoning !== undefined) delta.reasoning_content = reasoning;
  if (toolCalls !== undefined) delta.tool_calls = toolCalls;
  const chunk = {
    id: "chatcmpl-parity",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-kimi",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

const state = {
  root: null,
  host: null,
  port: null,
  fixture: null,
  fixturePort: null,
  behavior: () => ({ kind: "sse", chunks: [chatChunk({ content: "kimi-ok", finishReason: null }), chatChunk({ finishReason: "stop" })] }),
  kimiAccessToken: null,
};

function createFixture() {
  const log = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, "http://fixture");
    log.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.authorization ?? null,
      body: rawBody,
    });

    if (url.pathname === "/backend-api/wham/usage") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 5 } } }));
      return;
    }
    if (url.pathname === "/api/oauth/token") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_grant", error_description: "refresh token expired" }));
      return;
    }
    if (url.pathname === "/coding/v1/models") {
      // The engine's Codex catalog omits combos whose target model is unknown to
      // provider capabilities; the real Kimi discovery lists these ids, so the
      // fixture must too (registry alone lacks kimi-for-coding-highspeed).
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: [
          { id: "k3", object: "model", context_length: 262_144 },
          { id: "kimi-for-coding", object: "model", context_length: 262_144 },
          { id: "kimi-for-coding-highspeed", object: "model", context_length: 262_144 },
        ],
      }));
      return;
    }
    if (url.pathname === "/coding/v1/chat/completions") {
      const behavior = state.behavior(request, rawBody);
      if (behavior.kind === "error") {
        response.writeHead(behavior.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: behavior.message, type: "fixture_error" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`${behavior.chunks.join("")}data: [DONE]\n\n`);
      return;
    }
    if (url.pathname === "/backend-api/codex/responses") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("event: response.completed\ndata: {}\n\n");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: `fixture no-route: ${request.method} ${url.pathname}` }));
  });
  return { server, log };
}

async function postResponses(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function kimiRequests() {
  return state.fixture.log.filter((entry) => entry.path === "/coding/v1/chat/completions");
}

function setSseBehavior(chunks) {
  state.behavior = () => ({ kind: "sse", chunks });
}

test.before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-kimi-parity-"));
  state.root = root;
  const openCodexHome = path.join(root, "opencodex");
  const codexHome = path.join(root, "codex");
  const kimiHome = path.join(root, "kimi");
  fs.mkdirSync(openCodexHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(kimiHome, "credentials"), { recursive: true });

  state.kimiAccessToken = jwt({ user_id: "parity-user", email: "parity@example.com" });
  fs.writeFileSync(path.join(kimiHome, "credentials", "kimi-code.json"), `${JSON.stringify({
    access_token: state.kimiAccessToken,
    refresh_token: jwt({ user_id: "parity-user" }),
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    scope: "openid",
    token_type: "Bearer",
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(kimiHome, "device_id"), "parity-device\n", { mode: 0o600 });
  const sync = syncKimiCliCredential({ kimiHome, openCodexHome });
  assert.equal(sync.status, "synced");

  // Serving config, exactly as serving-lifecycle builds it (plus one pool account
  // so the 401 test can prove Kimi failures never touch the ChatGPT pool).
  const config = buildServingConfig({
    port: 0,
    codexAccounts: [{ id: "acct-a", email: "a@example.com", isMain: false, plan: "plus" }],
    kimiModels: KIMI_CODEX_MODELS.map((model) => ({ ...model })),
  });
  fs.writeFileSync(path.join(openCodexHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(openCodexHome, "codex-accounts.json"), `${JSON.stringify({
    "acct-a": {
      accessToken: "pool-token-a",
      refreshToken: "pool-rt-a",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "chatgpt-acct-a",
    },
  }, null, 2)}\n`, { mode: 0o600 });

  state.fixture = createFixture();
  await new Promise((resolve, reject) => {
    state.fixture.server.once("error", reject);
    state.fixture.server.listen(0, "127.0.0.1", resolve);
  });
  state.fixturePort = state.fixture.server.address().port;

  const enginePath = path.join(root, "opencodex-engine.mjs");
  await buildEngine({ projectRoot, outputPath: enginePath });
  fs.writeFileSync(path.join(root, "fetch-shim.cjs"), FETCH_SHIM);
  const workerPath = path.join(root, "parity-worker.js");
  fs.writeFileSync(workerPath, parityWorkerSource(path.join(projectRoot, "src", "open-codex", "engine-interface.js")));

  state.host = createEngineHost({
    workerPath,
    startupTimeoutMs: 20_000,
    workerData: { enginePath },
    workerEnv: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: openCodexHome,
      OCX_FIXTURE_PORT: String(state.fixturePort),
    },
  });
  const status = await state.host.start({ port: 0 });
  state.port = status.port;
});

test.after(async () => {
  try { await state.host?.quiesceAndStop({ timeoutMs: 2_000 }); } catch { /* best effort */ }
  state.fixture?.server.closeAllConnections?.();
  await new Promise((resolve) => state.fixture?.server.close(() => resolve()) ?? resolve());
  fs.rmSync(state.root, { recursive: true, force: true });
});

test("all 4 codepet-kimi-* slugs are advertised and map to the decided upstream ids", async () => {
  // Codex Desktop discovers models through the client_version catalog, which lists
  // combo aliases without the capability gate (codex/catalog/aggregation.ts:155-167).
  // The plain /v1/models list omits capability-incomplete combos instead — see the
  // parity report note about kimi-for-coding-highspeed.
  const catalog = await fetch(`http://127.0.0.1:${state.port}/v1/models?client_version=0.87.0`)
    .then((response) => response.text());
  for (const slug of Object.keys(EXPECTED_UPSTREAM_MODEL)) {
    assert.ok(catalog.includes(slug), `client_version catalog missing ${slug}`);
  }

  for (const [slug, upstreamModel] of Object.entries(EXPECTED_UPSTREAM_MODEL)) {
    state.fixture.log.length = 0;
    setSseBehavior([chatChunk({ content: `ok-${slug}` }), chatChunk({ finishReason: "stop" })]);
    const result = await postResponses(state.port, {
      model: slug,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
    });
    assert.equal(result.status, 200, `${slug} status`);
    assert.ok(result.text.includes("response.completed"), `${slug} completed event`);
    assert.ok(result.text.includes(`ok-${slug}`), `${slug} streamed content`);
    const upstream = kimiRequests();
    assert.equal(upstream.length, 1, `${slug} upstream call count`);
    const body = JSON.parse(upstream[0].body);
    assert.equal(body.model, upstreamModel, `${slug} upstream model id`);
    assert.equal(upstream[0].authorization, `Bearer ${state.kimiAccessToken}`, `${slug} auth header`);
    assert.equal(body.stream, true, `${slug} streaming`);
  }
});

test("tool calls: Responses items flatten to namespace__name on the wire and map back", async () => {
  state.fixture.log.length = 0;
  setSseBehavior([
    chatChunk({
      toolCalls: [{
        index: 0,
        id: "call_read",
        type: "function",
        function: { name: "fs__read", arguments: "" },
      }],
    }),
    chatChunk({ toolCalls: [{ index: 0, function: { arguments: "{\"path\":\"/tmp/a\"}" } }] }),
    chatChunk({ finishReason: "tool_calls" }),
  ]);

  const result = await postResponses(state.port, {
    model: "codepet-kimi-k2-7-coding",
    instructions: "sys",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "read /tmp/a" }] },
      { type: "function_call", call_id: "call_prev", name: "read", namespace: "fs", arguments: "{\"path\":\"/tmp/a\"}" },
      { type: "function_call_output", call_id: "call_prev", output: [{ type: "input_text", text: "file-contents" }] },
    ],
    tools: [{
      type: "namespace",
      name: "fs",
      tools: [{
        type: "function",
        name: "read",
        description: "read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      }],
    }],
    stream: true,
  });

  assert.equal(result.status, 200);
  const upstream = kimiRequests();
  assert.equal(upstream.length, 1);
  const body = JSON.parse(upstream[0].body);

  // Request side: function_call -> assistant tool_calls (namespace__name flattening,
  // identical to the legacy adapter), function_call_output -> tool message,
  // tools -> chat completions function tools with the flattened name.
  const assistantCall = body.messages.find((message) => message.role === "assistant" && message.tool_calls);
  if (process.env.PARITY_DEBUG) {
    console.log("UPSTREAM MESSAGES", JSON.stringify(body.messages));
    console.log("UPSTREAM TOOLS", JSON.stringify(body.tools));
    console.log("CLIENT SSE", result.text.slice(0, 4000));
  }
  assert.equal(assistantCall.tool_calls[0].function.name, "fs__read");
  const toolMessage = body.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage.tool_call_id, "call_prev");
  assert.equal(toolMessage.content, "file-contents");
  assert.equal(body.tools[0].function.name, "fs__read");

  // Response side: the client consumes Responses function_call events with the
  // namespace/name pair restored, ending in a real response.completed.
  assert.ok(result.text.includes('"type":"function_call"'), "function_call item in Responses stream");
  assert.ok(result.text.includes('"name":"read"'), "restored tool name");
  assert.ok(result.text.includes('"namespace":"fs"'), "restored tool namespace");
  assert.ok(result.text.includes("response.completed"), "terminal completed event");
  assert.ok(!result.text.includes("KIMI_STREAM_ERROR"), "no stream error");
});

test("reasoning: thinking enabled on the wire, raw reasoning not echoed without summary", async () => {
  state.fixture.log.length = 0;
  setSseBehavior([
    chatChunk({ reasoning: "secret-thinking" }),
    chatChunk({ content: "answer-text" }),
    chatChunk({ finishReason: "stop" }),
  ]);

  const result = await postResponses(state.port, {
    model: "codepet-kimi-k3",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "think" }] }],
    reasoning: { effort: "high" },
    stream: true,
  });

  assert.equal(result.status, 200);
  const body = JSON.parse(kimiRequests()[0].body);
  // Engine wire for k3: reasoning_effort mapped through the registry effort map
  // (high -> high). The legacy adapter sent thinking:{type:"enabled",effort} —
  // a deliberate wire-shape difference recorded in the parity report.
  assert.equal(body.reasoning_effort, "high");
  assert.ok(result.text.includes("answer-text"), "content streamed");
  // No reasoning.summary in the request -> hideThinkingSummary, so the raw
  // reasoning content must not reach the client (legacy adapter contract).
  assert.ok(!result.text.includes("secret-thinking"), "raw reasoning leaked to the client");
  assert.ok(result.text.includes("response.completed"));
});

test("upstream errors surface as errors, never as a fake response.completed", async () => {
  // Distinct slugs per status: a hop-classified failure cools the combo target
  // for 60s (see the combo-cooldown test below), which would leak into later tests.
  for (const [slug, status] of [["codepet-kimi-k3", 400], ["codepet-kimi-k3-256k", 500]]) {
    state.fixture.log.length = 0;
    state.behavior = () => ({ kind: "error", status, message: `fixture ${status}` });
    const result = await postResponses(state.port, {
      model: slug,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
    });
    assert.notEqual(result.status, 200, `upstream ${status} must not become 200`);
    assert.ok(!result.text.includes("response.completed"), `upstream ${status} produced a fake completed`);
    const parsed = JSON.parse(result.text);
    assert.ok(parsed.error, `upstream ${status} returned a JSON error body`);
  }
});

test("kimi 401 does not trigger ChatGPT pool rotation", async () => {
  state.fixture.log.length = 0;
  state.behavior = () => ({ kind: "error", status: 401, message: "Invalid Authentication" });

  const result = await postResponses(state.port, {
    model: "codepet-kimi-k2-7-coding",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
  });

  if (process.env.PARITY_DEBUG) {
    console.log("401 CLIENT", result.status, result.text.slice(0, 2000));
  }
  assert.equal(result.status, 401);
  const codexCalls = state.fixture.log.filter((entry) => entry.path === "/backend-api/codex/responses");
  assert.equal(codexCalls.length, 0, "kimi 401 leaked into ChatGPT pool traffic");
  assert.equal(kimiRequests().length, 1, "exactly one kimi attempt, no retry storm");
});

test("a hop-classified failure cools the single combo target for 60s (503, no upstream call)", async () => {
  // Combo failover contract (vendor combos/failover.ts:82-109 + resolve.ts:143-159):
  // 5xx/401/429 "hop" cools the target; with one target the next request short-circuits
  // locally with 503 combo_unavailable. This is why each error test uses its own slug.
  state.fixture.log.length = 0;
  state.behavior = () => ({ kind: "error", status: 500, message: "fixture 500" });
  const request = () => postResponses(state.port, {
    model: "codepet-kimi-k2-7-coding-fast",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
  });

  const first = await request();
  assert.equal(first.status, 500);
  const upstreamAfterFirst = kimiRequests().length;

  const second = await request();
  assert.equal(second.status, 503);
  assert.equal(kimiRequests().length, upstreamAfterFirst, "cooled combo still hit upstream");
  const parsed = JSON.parse(second.text);
  assert.match(JSON.stringify(parsed), /combo|No available targets/i);
});
