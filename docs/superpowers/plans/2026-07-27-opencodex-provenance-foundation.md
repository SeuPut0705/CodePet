# OpenCodex Provenance Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin and vendor the complete OpenCodex v2.7.41 source with verifiable MIT provenance, reproducible sync tooling, an initial parity inventory, and packaged third-party notices.

**Architecture:** Keep the upstream snapshot immutable under `vendor/opencodex` and put all CodePet behavior in CommonJS tooling outside that tree. A small provenance module verifies the manifest, license, tracked-file inventory, and file hashes; sync and parity scripts consume that module without Electron dependencies.

**Tech Stack:** Node.js CommonJS, `node:test`, Git, SHA-256, electron-builder resources, GitHub Actions

## Global Constraints

- Initial upstream baseline is OpenCodex `v2.7.41` at `ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10`.
- Preserve the OpenCodex MIT license text and copyright notice in source and packaged artifacts.
- Do not edit files copied from upstream in place; CodePet changes live outside `vendor/opencodex` or in a declared patch series.
- Preserve unrelated changes in `src/codex-proxy.js` and `test/codex-proxy.test.js`.
- Push only `origin/main`.
- A passing CodePet test suite proves this foundation only; it does not prove runtime OpenCodex parity or production updates.

---

### Task 1: Provenance verifier module

**Files:**
- Create: `src/open-codex/upstream-provenance.js`
- Test: `test/open-codex-upstream-provenance.test.js`

**Interfaces:**
- Produces: `sha256File(filePath) -> string`
- Produces: `parseInventory(text) -> Array<{ hash, relativePath }>`
- Produces: `validateManifest(value) -> normalized manifest or throws Error`
- Produces: `verifyVendoredSnapshot({ vendorDir }) -> { ok, errors, filesChecked, manifest }`

- [ ] **Step 1: Write failing tests for manifest and inventory validation**

```js
test("OpenCodex manifest는 저장소 태그 커밋과 MIT 고지를 요구한다", () => {
  assert.throws(() => validateManifest({ schemaVersion: 1 }), /repository/);
  assert.equal(validateManifest(validManifest).commit, EXPECTED_COMMIT);
});

test("OpenCodex inventory는 경로 이탈과 중복을 거부한다", () => {
  assert.throws(() => parseInventory(`${HASH}  ../secret\n`), /unsafe path/);
  assert.throws(() => parseInventory(`${HASH}  src/a.ts\n${HASH}  src/a.ts\n`), /duplicate/);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/open-codex-upstream-provenance.test.js`

Expected: FAIL because `src/open-codex/upstream-provenance.js` does not exist.

- [ ] **Step 3: Implement strict parsing and verification**

Implement manifest constants for the repository URL, tag, commit, MIT SPDX identifier, license path, license SHA-256, upstream tree SHA, inventory path, and patch list. Reject absolute paths, `..`, malformed hashes, duplicate inventory entries, missing files, extra tracked files, and hash mismatches. Exclude only `UPSTREAM.json` and `FILES.sha256` from the tracked-file comparison because they are CodePet metadata.

- [ ] **Step 4: Add positive and tamper tests**

Create a temporary fixture containing `LICENSE`, `src/index.ts`, `UPSTREAM.json`, and `FILES.sha256`. Assert `ok === true`, then change `src/index.ts` and assert a hash mismatch without exposing file contents.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test test/open-codex-upstream-provenance.test.js`

Commit: `feat(opencodex): 업스트림 출처 검증기 추가`

### Task 2: Reproducible upstream sync command

**Files:**
- Create: `scripts/opencodex/sync.js`
- Create: `scripts/opencodex/verify-provenance.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `test/open-codex-sync.test.js`

**Interfaces:**
- Consumes: `sha256File`, `validateManifest`, `verifyVendoredSnapshot`
- Produces: `parseSyncArgs(argv) -> { tag, commit, repository, destination }`
- Produces: `trackedFiles(checkoutDir) -> string[]`
- Produces: `buildManifest({ checkoutDir, tag, commit, repository, syncedAt }) -> object`
- Produces commands: `npm run opencodex:sync`, `npm run opencodex:verify`

- [ ] **Step 1: Write failing argument and safety tests**

```js
test("sync는 tag와 40자리 commit을 모두 요구한다", () => {
  assert.throws(() => parseSyncArgs(["--tag", "v2.7.41"]), /commit/);
  assert.equal(parseSyncArgs(FULL_ARGS).destination, expectedVendorDir);
});

test("sync 대상은 저장소의 vendor/opencodex로 제한한다", () => {
  assert.throws(() => parseSyncArgs([...FULL_ARGS, "--destination", "/tmp/out"]), /destination/);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/open-codex-sync.test.js`

Expected: FAIL because the sync module does not exist.

- [ ] **Step 3: Implement the sync transaction**

Clone the named tag into a `mkdtempSync` directory, verify `git rev-parse HEAD` equals the requested commit, list files with `git ls-files -z`, copy only those files into a sibling staging directory, write deterministic `FILES.sha256`, write `UPSTREAM.json`, run `verifyVendoredSnapshot`, and replace only the exact `vendor/opencodex` destination after verification. Clean the temporary checkout in `finally`.

- [ ] **Step 4: Implement the read-only verifier command**

`verify-provenance.js` calls `verifyVendoredSnapshot`, prints only counts and safe relative filenames on error, and exits non-zero when verification fails.

- [ ] **Step 5: Add npm commands and run tests**

Add:

```json
"opencodex:sync": "node scripts/opencodex/sync.js",
"opencodex:verify": "node scripts/opencodex/verify-provenance.js"
```

Run: `node --test test/open-codex-sync.test.js test/open-codex-upstream-provenance.test.js`

Commit: `build(opencodex): 재현 가능한 동기화 명령 추가`

### Task 3: Vendor the pinned OpenCodex snapshot

**Files:**
- Create: `vendor/opencodex/**`

**Interfaces:**
- Consumes: `npm run opencodex:sync -- --tag v2.7.41 --commit ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10`
- Produces: immutable upstream source plus `UPSTREAM.json` and `FILES.sha256`

- [ ] **Step 1: Resolve and record the upstream tree SHA**

Run: `git -C /tmp/codepet-opencodex.mDSYCg rev-parse 'HEAD^{tree}'`

Expected: a 40-character SHA recorded in `UPSTREAM.json`.

- [ ] **Step 2: Run the pinned sync command**

Run: `npm run opencodex:sync -- --tag v2.7.41 --commit ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10`

Expected: the destination contains the full tracked worktree and no `.git` directory.

- [ ] **Step 3: Verify the vendored source**

Run: `npm run opencodex:verify`

Expected: PASS with repository, tag, commit, file count, and zero mismatches.

- [ ] **Step 4: Verify legal files and tree shape**

Run: `test -f vendor/opencodex/LICENSE && test -f vendor/opencodex/src/index.ts && test -f vendor/opencodex/tests/codex-routing.test.ts && test ! -d vendor/opencodex/.git`

- [ ] **Step 5: Commit the snapshot separately**

Commit: `chore(opencodex): v2.7.41 원본 스냅샷 추가`

### Task 4: Initial feature parity inventory

**Files:**
- Create: `scripts/opencodex/parity-report.js`
- Create: `docs/opencodex-parity.json`
- Test: `test/open-codex-parity-report.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `buildParityReport({ vendorDir, codePetRoot }) -> ParityReport`
- Produces command: `npm run opencodex:parity`
- `ParityReport` contains `upstreamCommit`, category arrays, upstream evidence paths, CodePet evidence paths, and one of `imported`, `contract-tested`, `runtime-verified`.

- [ ] **Step 1: Write failing category coverage tests**

Assert the report contains non-empty `providers`, `adapters`, `oauth`, `transports`, `codexIntegration`, `claudeIntegration`, `usage`, `management`, and `cliRuntime` categories. Assert every evidence path exists and no entry begins as `runtime-verified`.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/open-codex-parity-report.test.js`

- [ ] **Step 3: Implement deterministic discovery**

Discover upstream modules and tests from the vendored tree, sort all names and paths, attach current CodePet evidence only when an existing test or source file explicitly covers that capability, and write stable JSON ending in one newline.

- [ ] **Step 4: Generate and verify the report**

Run: `npm run opencodex:parity`

Run: `node --test test/open-codex-parity-report.test.js`

- [ ] **Step 5: Commit**

Commit: `docs(opencodex): 기능 동등성 기준선 추가`

### Task 5: Package notices and CI provenance gate

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/open-codex-package-metadata.test.js`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm run opencodex:verify`
- Produces packaged resources `third-party/opencodex/LICENSE`, `UPSTREAM.json`, and `FILES.sha256`
- Produces CI jobs for macOS and Windows using Node 24 and `npm ci`

- [ ] **Step 1: Write failing package metadata tests**

Read `package.json` and assert `build.extraResources` maps the three provenance files to `third-party/opencodex`. Read `.github/workflows/ci.yml` and assert both `macos-latest` and `windows-latest` run `npm test` and `npm run opencodex:verify`.

- [ ] **Step 2: Run focused test and confirm RED**

Run: `node --test test/open-codex-package-metadata.test.js`

- [ ] **Step 3: Add package resources without changing current targets**

Append three exact file mappings to `build.extraResources`. Do not add updater dependencies or change portable/DMG targets in this foundation milestone.

- [ ] **Step 4: Add cross-platform CI**

Create one matrix job with `os: [macos-latest, windows-latest]`, `actions/checkout`, `actions/setup-node` Node 24, `npm ci`, `npm run opencodex:verify`, and `npm test`.

- [ ] **Step 5: Run all foundation verification**

Run: `npm run opencodex:verify`

Run: `npm run opencodex:parity`

Run: `npm test`

Run: `git diff --check`

- [ ] **Step 6: Commit and push only main**

Commit: `ci(opencodex): 출처와 라이선스 검증 추가`

Run: `git push origin main`

### Task 6: Foundation completion audit

**Files:**
- Modify: `docs/opencodex-parity.json` only if regenerated evidence differs

**Interfaces:**
- Consumes all outputs from Tasks 1–5.
- Produces the evidence boundary for the engine-host implementation plan.

- [ ] **Step 1: Re-run authoritative checks from a clean index state**

Run: `npm ci`

Run: `npm run opencodex:verify`

Run: `npm run opencodex:parity`

Run: `npm test`

- [ ] **Step 2: Confirm scope preservation**

Run: `git status --short` and verify the pre-existing proxy files remain uncommitted unless independently completed and tested.

- [ ] **Step 3: Record the next plan input**

Use the verified manifest, Bun-specific runtime inventory, and parity report to write the engine-host/Node compatibility implementation plan. Do not claim OpenCodex runtime integration complete at this milestone.
