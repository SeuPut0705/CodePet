# Codex OpenAI·Kimi 병렬 라우팅 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex 데스크톱 앱의 모델 선택기에서 기존 Kimi Code OAuth 계정 모델을 선택하고 OpenAI 작업과 동시에 실행할 수 있게 한다.

**Architecture:** CodePet은 Codex 사용자 설정에 HTTP Responses 전용 `codepet` 공급자와 병합 모델 카탈로그를 등록한다. 로컬 프록시는 요청의 모델 식별자로 기존 OpenAI 계정 로테이션 경로와 Kimi Chat Completions 변환 경로를 나누며, Kimi 자격정보는 기존 관리형 OAuth 갱신 규약을 재사용한다.

**Tech Stack:** Electron 40, Node.js CommonJS, `node:http`, WHATWG `fetch`, Node test runner, Codex Responses API, Kimi OpenAI-compatible Chat Completions API

## Global Constraints

- Kimi API 키를 새로 요구하지 않고 `~/.kimi-code`의 관리형 OAuth 로그인만 사용한다.
- OpenAI와 Kimi는 전역 토글 없이 요청의 `model` 값으로 병렬 라우팅한다.
- Kimi 실패를 OpenAI로 자동 대체하지 않는다.
- access token, refresh token, 계정 식별자와 `reasoning_content`를 renderer·config·카탈로그·로그에 노출하지 않는다.
- 사용자의 기존 `model_catalog_json`, `model_provider`, 같은 이름의 공급자 테이블을 덮어쓰지 않는다.
- 현재 실행 중인 `127.0.0.1:10161` 프록시와 Codex 앱은 구현 작업 중 종료하거나 교체하지 않는다.
- 실제 Kimi 추론은 사용량을 소비하므로 별도 승인 전에는 호출하지 않는다.
- 이번 변경은 사용자 요청 전까지 커밋하거나 푸시하지 않는다.

---

### Task 1: 관리형 Kimi 모델 발견과 허용 매핑

**Files:**
- Create: `src/kimi-codex-models.js`
- Create: `test/kimi-codex-models.test.js`

**Interfaces:**
- Produces: `KIMI_CODEX_MODELS`, `resolveKimiCodexModel(slug)`, `discoverManagedKimiModels({ configPath, readFileSync })`
- `resolveKimiCodexModel(slug)` returns `{ slug, displayName, upstreamModel, contextWindow, reasoningEfforts } | null`.
- `discoverManagedKimiModels(...)` returns the allowlisted mappings that are present under the managed `kimi-code` provider only.

- [x] **Step 1: Write the failing model mapping tests**

Test literal mappings for `codepet-kimi-k3`, `codepet-kimi-k3-256k`, `codepet-kimi-k2-7-coding`, and `codepet-kimi-k2-7-coding-fast`; assert an arbitrary `codepet-kimi-*` value returns `null`.

- [x] **Step 2: Run the model test and verify RED**

Run: `node --test test/kimi-codex-models.test.js`

Expected: FAIL because `../src/kimi-codex-models` does not exist.

- [x] **Step 3: Implement the fixed allowlist and minimal TOML discovery**

The parser recognizes section headers and safe keys only:

```js
const KIMI_CODEX_MODELS = Object.freeze([
  { slug: "codepet-kimi-k3", upstreamModel: "k3", displayName: "Kimi K3", contextWindow: 1048576, reasoningEfforts: ["low", "high", "max"] },
  { slug: "codepet-kimi-k3-256k", upstreamModel: "k3-256k", displayName: "Kimi K3 256K", contextWindow: 262144, reasoningEfforts: ["low", "high", "max"] },
  { slug: "codepet-kimi-k2-7-coding", upstreamModel: "kimi-for-coding", displayName: "Kimi K2.7 Coding", contextWindow: 262144, reasoningEfforts: ["low", "high", "max"] },
  { slug: "codepet-kimi-k2-7-coding-fast", upstreamModel: "kimi-for-coding-highspeed", displayName: "Kimi K2.7 Coding Fast", contextWindow: 262144, reasoningEfforts: ["low", "high", "max"] },
]);
```

Discovery must require the provider section for `managed:kimi-code`, Base URL `https://api.kimi.com/coding/v1`, and a matching configured upstream model. It never returns raw config content.

- [x] **Step 4: Run the model test and verify GREEN**

Run: `node --test test/kimi-codex-models.test.js`

Expected: all tests pass.

### Task 2: Codex 카탈로그와 CodePet 공급자 설정

**Files:**
- Create: `src/codex-model-catalog.js`
- Create: `test/codex-model-catalog.test.js`
- Modify: `src/codex-proxy.js`
- Modify: `test/codex-proxy.test.js`

**Interfaces:**
- Consumes: `discoverManagedKimiModels(...)` from Task 1.
- Produces: `buildMergedModelCatalog(bundled, kimiModels)`, `prepareCodexModelCatalog(options)`, `injectCodePetProvider(content, { port, catalogPath })`, `stripCodePetProvider(content)`.
- `prepareCodexModelCatalog` returns `{ catalogPath, kimiModelCount }` and writes JSON atomically.
- Config injection returns `{ content, conflict }`; conflict is one of `null`, `model_provider`, `model_catalog_json`, or `model_providers.codepet`.

- [x] **Step 1: Write failing catalog merge tests**

Use a hand-authored bundled fixture with one OpenAI model. Assert it stays deeply equal, Kimi entries have literal slug/display/reasoning/context values, and duplicate Kimi slugs are not added twice.

- [x] **Step 2: Run the catalog tests and verify RED**

Run: `node --test test/codex-model-catalog.test.js`

Expected: FAIL because the catalog module does not exist.

- [x] **Step 3: Implement catalog merge and atomic preparation**

Use `spawnSync(codexCommand, ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 10000 })`, validate `{ models: [...] }`, clone the highest-priority visible OpenAI template, and override only Kimi-owned metadata. Write `codepet-codex-models.json` under the supplied `userDataDir` with `atomicWrite`.

- [x] **Step 4: Write failing provider config tests**

Assert the owned root block is inserted before the first TOML table and the owned provider table is appended:

```toml
# codepet-codex-provider
model_provider = "codepet"
model_catalog_json = "/tmp/codepet-codex-models.json"

[model_providers.codepet]
name = "CodePet OpenAI + Kimi"
base_url = "http://127.0.0.1:10161/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
# /codepet-codex-provider
```

Assert injection is idempotent, stripping removes only this block, and user-owned `model_provider`, `model_catalog_json`, or `[model_providers.codepet]` produces a conflict without changing the user content.

- [x] **Step 5: Run provider config tests and verify RED**

Run: `node --test test/codex-proxy.test.js --test-name-pattern='CodePet 공급자'`

Expected: FAIL because the new exports do not exist.

- [x] **Step 6: Replace Base URL-only injection with owned provider injection**

Keep legacy `# codepet-codex-proxy` cleanup for migration. `enableProxyInConfig` accepts `{ port, catalogPath }`, preserves user-owned conflicts, and writes only after conflict-free transformation. `disableProxyInConfig` removes the owned provider block and legacy proxy block.

- [x] **Step 7: Run catalog and provider tests and verify GREEN**

Run: `node --test test/codex-model-catalog.test.js test/codex-proxy.test.js`

Expected: all tests pass.

### Task 3: Kimi 추론용 OAuth 경계

**Files:**
- Modify: `src/kimi-usage-client.js`
- Modify: `test/kimi-usage-client.test.js`

**Interfaces:**
- Produces: `KimiUsageClient.getAccessToken({ forceRefresh = false, rejectedAccessToken = null } = {})`.
- Returns the access token string to main-process callers only; errors remain sanitized `KimiUsageError` instances.

- [x] **Step 1: Write failing access-token tests**

Assert a fresh credential returns its token without fetch/write, `forceRefresh` performs the existing locked refresh, and a changed token discovered after a rejected token is reused without another refresh.

- [x] **Step 2: Run the OAuth tests and verify RED**

Run: `node --test test/kimi-usage-client.test.js --test-name-pattern='추론 토큰'`

Expected: FAIL because `getAccessToken` is undefined.

- [x] **Step 3: Implement the minimal public auth method**

```js
async getAccessToken({ forceRefresh = false, rejectedAccessToken = null } = {}) {
  const credentials = await this.readCredentials();
  const fresh = forceRefresh
    ? await this.recoverFromAuthFailure({ access_token: rejectedAccessToken || credentials.access_token })
    : await this.ensureFresh(credentials);
  return fresh.access_token;
}
```

Deduplicate simultaneous refreshes with one private in-flight promise and clear it in `finally`.

- [x] **Step 4: Run the full Kimi usage client tests and verify GREEN**

Run: `node --test test/kimi-usage-client.test.js`

Expected: all tests pass.

### Task 4: Responses 입력을 Kimi Chat Completions로 변환

**Files:**
- Create: `src/kimi-codex-adapter.js`
- Create: `test/kimi-codex-adapter.test.js`

**Interfaces:**
- Produces: `responsesRequestToChat(body, modelConfig)` and `createKimiResponsesStream(options)`.
- `responsesRequestToChat` returns a JSON-serializable Chat Completions body and throws `KimiCodexAdapterError(code, message, status)` for unsupported required input.
- `createKimiResponsesStream({ requestBody, modelConfig, accessToken, fetchImpl, signal })` returns `{ status, headers, body }`, where `body` is a Node-readable Responses SSE stream.

- [x] **Step 1: Write failing input conversion tests**

Use literal Responses fixtures for instructions, developer/user/assistant messages, `input_text`, `input_image`, function tools, `function_call`, and `function_call_output`. Assert the exact Chat Completions messages/tools/model and literal reasoning effort.

- [x] **Step 2: Run adapter input tests and verify RED**

Run: `node --test test/kimi-codex-adapter.test.js --test-name-pattern='입력'`

Expected: FAIL because the adapter module does not exist.

- [x] **Step 3: Implement input conversion**

Normalize string input and Responses item arrays. Map `instructions` to a developer message, `input_text` to text content, `input_image.image_url` to `image_url`, function tools to Chat Completions functions, function calls to assistant `tool_calls`, and function outputs to tool messages. Reject unsupported tool types with HTTP 400 instead of dropping them.

- [x] **Step 4: Run adapter input tests and verify GREEN**

Run: `node --test test/kimi-codex-adapter.test.js --test-name-pattern='입력'`

Expected: input tests pass.

### Task 5: Kimi SSE를 Responses SSE로 변환

**Files:**
- Modify: `src/kimi-codex-adapter.js`
- Modify: `test/kimi-codex-adapter.test.js`

**Interfaces:**
- Consumes: `responsesRequestToChat(...)` from Task 4 and `fetchImpl` compatible with WHATWG fetch.
- Produces standard Responses event frames as `event: <type>\ndata: <json>\n\n` and terminal `data: [DONE]\n\n`.

- [x] **Step 1: Write failing text streaming tests**

Feed split Kimi `data:` chunks containing role, content deltas, usage, finish reason, and `[DONE]`. Assert event order: `response.created`, item added, content part added, text deltas, text done, content part done, item done, `response.completed`, `[DONE]`.

- [x] **Step 2: Run text streaming tests and verify RED**

Run: `node --test test/kimi-codex-adapter.test.js --test-name-pattern='텍스트 스트림'`

Expected: FAIL because streaming conversion is absent.

- [x] **Step 3: Implement incremental SSE parsing and text events**

Use `TextDecoder` streaming mode, retain incomplete lines between reads, validate JSON per `data:` frame, and create stable `resp_`, `msg_`, and output indexes. Never include `reasoning_content` in emitted events.

- [x] **Step 4: Write failing tool streaming tests**

Feed two interleaved tool calls with arguments split across chunks. Assert stable call IDs, independent argument accumulation, exact `response.function_call_arguments.delta/done`, output item completion, and response completion status.

- [x] **Step 5: Run tool streaming tests and verify RED**

Run: `node --test test/kimi-codex-adapter.test.js --test-name-pattern='도구 스트림'`

Expected: FAIL because tool events are not implemented.

- [x] **Step 6: Implement tool events, errors, usage, and cancellation**

Map each upstream tool index to one Responses function-call item. An upstream non-2xx response becomes sanitized JSON with the same meaningful status. Invalid SSE or premature EOF emits an error and must not emit `response.completed`. Pass the client AbortSignal into fetch so cancellation aborts Kimi.

- [x] **Step 7: Run all adapter tests and verify GREEN**

Run: `node --test test/kimi-codex-adapter.test.js`

Expected: all tests pass.

### Task 6: 프록시의 요청별 OpenAI·Kimi 라우팅

**Files:**
- Modify: `src/codex-proxy.js`
- Modify: `test/codex-proxy.test.js`

**Interfaces:**
- Consumes: `resolveKimiCodexModel(slug)`, injected `kimiClient.getAccessToken(...)`, and injected `createKimiStream(...)`.
- `CodexProxy` constructor gains `kimiClient`, `resolveKimiModel`, and `createKimiStream` dependencies.
- Produces: Kimi HTTP Responses route without calling `resolveAccounts` or OpenAI quota rotation.

- [x] **Step 1: Write the failing Kimi routing integration test**

Start a real local proxy and fake Kimi stream. Send `{"model":"codepet-kimi-k3","input":"hi","stream":true}` and assert the Kimi stream is returned, OpenAI account resolution count stays zero, and stale client OpenAI headers do not reach Kimi.

- [x] **Step 2: Run the Kimi routing test and verify RED**

Run: `node --test test/codex-proxy.test.js --test-name-pattern='Kimi 모델'`

Expected: FAIL because all requests still use the OpenAI path.

- [x] **Step 3: Implement model-aware buffered dispatch**

For POST `/responses`, buffer once, parse JSON, and route allowlisted Kimi models before resolving OpenAI accounts. Unknown `codepet-kimi-*` models return 400. Kimi auth 401/403 triggers `getAccessToken({ forceRefresh: true, rejectedAccessToken })` and one retry. Kimi 429 is returned directly and never calls `setCooldown`, `shouldRotateForQuota`, or `notifySwitch`.

- [x] **Step 4: Write failing concurrency, cancellation, and error tests**

Run one delayed OpenAI request and one delayed Kimi request concurrently; assert both responses remain distinct and `activeConnectionCount` is two until each stream ends. Abort Kimi and assert only its upstream signal is aborted. Assert Kimi 429 never rotates OpenAI accounts.

- [x] **Step 5: Run the new proxy tests and verify RED**

Run: `node --test test/codex-proxy.test.js --test-name-pattern='병렬|Kimi 429|Kimi 취소'`

Expected: at least one new behavior fails before implementation.

- [x] **Step 6: Complete Kimi response forwarding and lifecycle accounting**

Forward adapter status/headers/body without leaking upstream auth. Reuse the existing outer `beginConnection/finally` accounting; response close destroys the adapter body and aborts the request-local controller.

- [x] **Step 7: Run proxy and shutdown tests and verify GREEN**

Run: `node --test test/codex-proxy.test.js test/codex-proxy-shutdown.test.js`

Expected: all tests pass.

### Task 7: Electron 시작 경로에 카탈로그·Kimi 라우터 연결

**Files:**
- Modify: `src/main.js`
- Modify: `test/kimi-watcher.test.js`
- Modify: `test/codex-proxy.test.js`

**Interfaces:**
- Consumes: shared `kimiUsageClient`, `prepareCodexModelCatalog`, `discoverManagedKimiModels`, and `createKimiResponsesStream`.
- Startup prepares the catalog before `enableProxyInConfig`; proxy receives the same `kimiUsageClient` instance used for usage badges.

- [x] **Step 1: Write failing startup wiring tests**

Assert the main process passes `kimiUsageClient` to `CodexProxy`, prepares a catalog in `app.getPath("userData")`, supplies its absolute path to `enableProxyInConfig`, and uses the same preparation in enable, restore, quit rollback, and teardown paths.

- [x] **Step 2: Run wiring tests and verify RED**

Run: `node --test test/kimi-watcher.test.js test/codex-proxy.test.js --test-name-pattern='카탈로그|Kimi 라우터'`

Expected: FAIL because startup does not prepare or pass the catalog.

- [x] **Step 3: Implement startup preparation and wiring**

Resolve the Codex executable through the existing command-resolution helper. Discover current managed Kimi models, prepare the merged catalog under `app.getPath("userData")`, construct `CodexProxy` with the Kimi dependencies, and call `enableProxyInConfig(port, { catalogPath })`. A catalog or config conflict leaves the proxy disabled with the existing diagnostic bubble instead of partial configuration.

- [x] **Step 4: Run focused startup tests and verify GREEN**

Run: `node --test test/kimi-watcher.test.js test/codex-proxy.test.js test/codex-model-catalog.test.js`

Expected: all tests pass.

### Task 8: 회귀, 보안 검토와 사용자용 패키징

**Files:**
- Modify only files required by failures found in this task.

**Interfaces:**
- Consumes all previous tasks.
- Produces a tested normal macOS app bundle without replacing the currently running proxy process.

- [x] **Step 1: Run source hygiene checks**

Run: `git diff --check && rg -n 'access_token|refresh_token|reasoning_content' src/codex-model-catalog.js src/kimi-codex-models.js src/kimi-codex-adapter.js src/codex-proxy.js`

Expected: no credential value logging or persistence; only necessary field handling references.

- [x] **Step 2: Run the full test suite**

Run: `npm test`

Expected: exit 0 with zero failures.

- [x] **Step 3: Review the complete diff against the approved design**

Inspect `git status --short`, `git diff --stat`, and focused diffs. Verify unrelated files are absent, all four Kimi mappings are allowlisted, config conflicts fail closed, Kimi never invokes OpenAI rotation, and active stream accounting is unchanged.

- [x] **Step 4: Build the normal user app**

Run: `npm run dist`

Expected: exit 0 and a fresh `artifacts/mac-arm64/CodePet.app` bundle. Do not launch it while the current Codex task is connected to port 10161.

- [x] **Step 5: Record the remaining live gates**

Model-picker screen verification requires a safe Codex restart after the active task drains. A real Kimi prompt remains unexecuted until the user separately authorizes quota consumption. Report both gates distinctly from code/test/build completion.
