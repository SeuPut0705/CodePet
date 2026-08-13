# OpenCodex Electron Engine Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and start the pinned OpenCodex server inside a CodePet-owned Electron worker thread, prove `/healthz` and graceful drain, and keep the existing proxy as the active path until parity gates pass.

**Architecture:** A generated ESM bundle imports the vendored OpenCodex server after installing a Node compatibility implementation for the Bun runtime surface. Electron main uses a small CommonJS `EngineHost` interface over `worker_threads`; the host owns startup, status, reload, and drain without exposing provider internals.

**Tech Stack:** Electron 40, Node 24+, worker_threads, esbuild, ws, Web Request/Response/Streams, node:sqlite, node:test

## Global Constraints

- The engine runs inside the CodePet application and is not installed or managed as an external daemon.
- Keep OpenCodex `v2.7.41` commit `ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10` and its declared patch series verifiable.
- Do not cut the live Codex Desktop request path over in this milestone.
- Never stop CodePet while existing proxy HTTP or WebSocket streams are active.
- Preserve unrelated changes in `src/codex-proxy.js` and `test/codex-proxy.test.js`.
- Push only `origin/main`.
- Unsupported compatibility surfaces fail with named capability errors; they are not marked runtime-verified.

---

### Task 1: Runtime compatibility inventory

**Files:**
- Create: `scripts/opencodex/runtime-inventory.js`
- Create: `docs/opencodex-runtime-inventory.json`
- Test: `test/open-codex-runtime-inventory.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `scanRuntimeDependencies({ vendorDir }) -> RuntimeInventory`
- Produces command: `npm run opencodex:runtime-inventory`

- [ ] Write a failing test that scans the real vendor tree and requires entries for `Bun.serve`, `Bun.sleep`, `Bun.Image`, `bun:sqlite`, `bun:ffi`, `bun:jsc`, and `import.meta.dir`.
- [ ] Run `node --test test/open-codex-runtime-inventory.test.js` and confirm the missing-module failure.
- [ ] Implement a deterministic scanner that records safe relative files and line numbers but never source literals or credential values.
- [ ] Generate `docs/opencodex-runtime-inventory.json`; assert the output is byte-stable and every evidence path exists.
- [ ] Run the focused test and commit as `docs(opencodex): Electron 런타임 호환성 기준선 추가`.

### Task 2: ESM engine build boundary

**Files:**
- Create: `src/open-codex/runtime/engine-entry.ts`
- Create: `scripts/opencodex/build-engine.js`
- Create: `test/open-codex-engine-build.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces command: `npm run opencodex:build-engine`
- Produces generated artifact: `build/generated/opencodex-engine.mjs`
- Engine module exports: `startEmbeddedEngine(options)`, `stopEmbeddedEngine(options)`, `getEmbeddedEngineStatus()`

- [ ] Write a failing build test that invokes `buildEngine({ projectRoot, outputPath })` and requires one ESM artifact with no unresolved `bun:` imports.
- [ ] Install exact explicit build dependencies with `npm install --save-dev esbuild@0.28.1` and `npm install ws@8.21.1`.
- [ ] Implement an esbuild bundle using `platform: "node"`, `target: "node24"`, `format: "esm"`, and aliases for `bun:sqlite`, `bun:ffi`, and `bun:jsc`.
- [ ] Make `engine-entry.ts` install the compatibility global before dynamically importing `vendor/opencodex/src/server/index.ts`.
- [ ] Run the build test and commit as `build(opencodex): Electron 엔진 번들 경계 추가`.

### Task 3: Bun primitive compatibility

**Files:**
- Create: `src/open-codex/runtime/bun-compat.ts`
- Create: `test/open-codex-bun-compat.test.js`
- Modify: `scripts/opencodex/build-engine.js`

**Interfaces:**
- Produces: `installBunCompatibility() -> BunCompatibility`
- Supports: `sleep`, `sleepSync`, `file`, `hash`, `CryptoHasher`, `spawnSync`, `version`, `revision`, `inspect`
- Unsupported: `Image` throws `OpenCodexCapabilityError("bun-image")` until the image adapter milestone.

- [ ] Write failing behavior tests for sleep cancellation independence, SHA-256 digest bytes, deterministic hash integer, file body delivery, sanitized spawn result, and named image capability error.
- [ ] Implement primitives with Node timers, Atomics.wait, fs, crypto, child_process, and util.
- [ ] Run focused tests against the built bundle, then run `npm run opencodex:build-engine` twice and assert byte-identical output.
- [ ] Commit as `feat(opencodex): Bun 기본 런타임 호환 계층 추가`.

### Task 4: Bun.serve HTTP and WebSocket adapter

**Files:**
- Create: `src/open-codex/runtime/node-bun-server.ts`
- Create: `test/open-codex-node-server.test.js`
- Modify: `src/open-codex/runtime/bun-compat.ts`

**Interfaces:**
- Produces: `createNodeBunServer(options) -> { port, hostname, upgrade, stop }`
- Adapts Node IncomingMessage to Web `Request` and Web `Response` back to ServerResponse.
- Adapts `ws` sockets to the OpenCodex `open`, `message`, and `close` callbacks with mutable `data`.

- [ ] Write a failing HTTP test for status, repeated headers, streaming body, request abort, and port `0` allocation.
- [ ] Write a failing WebSocket test for `upgrade(req, { data })`, text and binary message delivery, close propagation, and a 426 non-upgrade response.
- [ ] Implement the HTTP conversion and backpressure-aware ReadableStream pump.
- [ ] Implement upgrade correlation from the Web `Request` object to the pending Node upgrade request, then wrap `ws` methods and `data`.
- [ ] Run server tests, leak-check open handles, and commit as `feat(opencodex): Node HTTP WebSocket 서버 어댑터 추가`.

### Task 5: Built-in module aliases

**Files:**
- Create: `src/open-codex/runtime/node-sqlite.ts`
- Create: `src/open-codex/runtime/node-jsc.ts`
- Create: `src/open-codex/runtime/node-ffi.ts`
- Create: `test/open-codex-runtime-aliases.test.js`
- Modify: `scripts/opencodex/build-engine.js`

**Interfaces:**
- `node-sqlite.ts` exports `Database` and constants compatible with the OpenCodex calls found in the runtime inventory.
- `node-jsc.ts` exports `heapStats()` backed by `process.memoryUsage()` and V8 heap statistics.
- `node-ffi.ts` exports a Windows TCP-drop adapter or a named unavailable result without loading a foreign process.

- [ ] Write failing tests using the actual OpenCodex storage/history queries against a temporary SQLite database.
- [ ] Implement only the Bun Database methods exercised by those queries and preserve transaction/error behavior.
- [ ] Write and pass system-memory response tests for the JSC alias.
- [ ] Write and pass platform-gated FFI tests; non-Windows returns unavailable, Windows invokes the explicit adapter.
- [ ] Build with zero unresolved `bun:` imports and commit as `feat(opencodex): Node 내장 모듈 어댑터 추가`.

### Task 6: Worker protocol and deep EngineHost module

**Files:**
- Create: `src/open-codex/engine-interface.js`
- Create: `src/open-codex/engine-worker.js`
- Create: `src/open-codex/engine-host.js`
- Test: `test/open-codex-engine-host.test.js`

**Interfaces:**
- `createEngineHost({ workerPath, startupTimeoutMs })`
- Host methods: `start(configuration)`, `getStatus()`, `getCapabilities()`, `reload(configuration)`, `quiesceAndStop({ timeoutMs })`
- Worker messages use `{ id, type, payload }`; replies use `{ id, ok, result }` or `{ id, ok: false, error: { code, message } }`.

- [ ] Write failing tests with a real fixture worker for start idempotence, startup timeout, crash isolation, request correlation, and drain timeout.
- [ ] Implement interface validation and safe error serialization with no stacks, tokens, or OAuth URLs crossing IPC.
- [ ] Implement the worker loading `build/generated/opencodex-engine.mjs` and returning the actual bound port.
- [ ] Implement host lifecycle state `stopped | starting | ready | draining | failed` and reject invalid ordering.
- [ ] Run host tests with no leaked worker or port and commit as `feat(opencodex): Electron worker 엔진 호스트 추가`.

### Task 7: Embedded engine health and drain smoke

**Files:**
- Create: `test/open-codex-engine-smoke.test.js`
- Create: `scripts/opencodex/engine-smoke.js`
- Modify: `package.json`
- Modify: `docs/opencodex-parity.json`

**Interfaces:**
- Produces command: `npm run opencodex:engine-smoke`
- Proves `/healthz` returns OpenCodex identity, version, PID, and actual port from the worker-owned listener.

- [ ] Write a failing smoke test that starts on port `0`, fetches `/healthz`, opens one delayed streaming request fixture, requests drain, and proves the worker stays alive until the stream closes.
- [ ] Implement the smoke command with isolated `CODEX_HOME` and `OPENCODEX_HOME` temporary directories and no live credentials.
- [ ] Update only proven engine/build/transport parity entries from `imported` to `contract-tested`; keep provider and OAuth runtime entries unverified.
- [ ] Run `npm run opencodex:engine-smoke` and commit as `test(opencodex): 내장 엔진 health와 drain 검증`.

### Task 8: Electron shadow lifecycle and package audit

**Files:**
- Modify: `src/main.js`
- Modify: `package.json`
- Modify: `scripts/build.js`
- Create: `test/open-codex-main-shadow.test.js`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Main starts the embedded engine only when `CODEPET_OPENCODEX_SHADOW=1`.
- Shadow engine receives no Codex Desktop traffic and stops through the existing proxy shutdown coordinator.
- Packaged resources include `build/generated/opencodex-engine.mjs`.

- [ ] Write a failing main lifecycle test proving the feature flag, no config injection, ready diagnostics, and drain-before-exit ordering.
- [ ] Wire `EngineHost` behind the shadow flag without changing the existing proxy address.
- [ ] Add the engine build before electron-builder and include the generated artifact in package files.
- [ ] Add engine build and smoke checks to macOS and Windows CI before packaging.
- [ ] Run `npm ci`, provenance checks, engine build, engine smoke, `npm test`, and macOS package creation.
- [ ] Inspect the packaged app for the engine artifact and MIT notices; report unsigned macOS status separately.
- [ ] Commit as `feat(opencodex): Electron shadow 엔진 수명주기 연결` and push `origin/main`.

### Task 9: Engine-host completion audit

**Files:**
- Modify generated evidence only when commands produce a deterministic change.

**Interfaces:**
- Produces the evidence boundary for the Responses/provider cutover plan.

- [ ] Confirm no external OpenCodex or Bun executable is started by source scan and runtime process observation.
- [ ] Confirm the worker PID equals the Electron/Node process PID and the listener closes after drain.
- [ ] Confirm the existing CodePet proxy remains the only configured Codex Desktop destination.
- [ ] Confirm all runtime inventory entries are either implemented or carry an explicit named capability error and remain unverified in parity.
- [ ] Re-run `npm test`, `npm run opencodex:verify`, `npm run opencodex:engine-smoke`, and package inspection.
- [ ] Push only `origin/main`; do not claim provider/OAuth parity until the cutover plan supplies real evidence.
