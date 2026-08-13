const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  parseSyncArgs,
  syncUpstream,
} = require("../scripts/opencodex/sync");
const { verifyVendoredSnapshot } = require("../src/open-codex/upstream-provenance");

const EXPECTED_COMMIT = "ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createUpstreamFixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencodex-sync-"));
  const upstreamDir = path.join(rootDir, "upstream");
  const projectRoot = path.join(rootDir, "codepet");
  fs.mkdirSync(upstreamDir);
  fs.mkdirSync(projectRoot);
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  git(upstreamDir, ["init"]);
  git(upstreamDir, ["config", "user.email", "test@example.invalid"]);
  git(upstreamDir, ["config", "user.name", "CodePet Test"]);
  fs.mkdirSync(path.join(upstreamDir, "src"));
  fs.writeFileSync(path.join(upstreamDir, "LICENSE"), "MIT License\nfixture\n");
  fs.writeFileSync(path.join(upstreamDir, "src", "index.ts"), "export const fixture = true;\n");
  fs.symlinkSync("index.ts", path.join(upstreamDir, "src", "entry.ts"));
  git(upstreamDir, ["add", "."]);
  git(upstreamDir, ["commit", "-m", "fixture"]);
  git(upstreamDir, ["tag", "v1.0.0"]);

  return {
    commit: git(upstreamDir, ["rev-parse", "HEAD"]),
    projectRoot,
    upstreamDir,
  };
}

test("sync 인자는 tag와 40자리 commit을 모두 요구한다", () => {
  assert.throws(
    () => parseSyncArgs(["--tag", "v2.7.41"]),
    /commit/
  );

  const parsed = parseSyncArgs([
    "--tag",
    "v2.7.41",
    "--commit",
    EXPECTED_COMMIT,
  ]);
  assert.equal(parsed.tag, "v2.7.41");
  assert.equal(parsed.commit, EXPECTED_COMMIT);
  assert.match(parsed.destination, /vendor\/opencodex$/);
});

test("sync 대상은 project root의 vendor/opencodex로 제한한다", () => {
  assert.throws(
    () => parseSyncArgs([
      "--tag",
      "v2.7.41",
      "--commit",
      EXPECTED_COMMIT,
      "--destination",
      "/tmp/out",
    ]),
    /destination/
  );
});

test("sync는 지정 commit의 tracked files만 복사하고 검증 가능한 metadata를 만든다", (t) => {
  const fixture = createUpstreamFixture(t);
  const destination = path.join(fixture.projectRoot, "vendor", "opencodex");

  const result = syncUpstream({
    repository: fixture.upstreamDir,
    tag: "v1.0.0",
    commit: fixture.commit,
    destination,
    projectRoot: fixture.projectRoot,
    syncedAt: "2026-07-27T00:00:00.000Z",
  });

  assert.equal(result.commit, fixture.commit);
  assert.equal(result.trackedFiles, 3);
  assert.equal(fs.existsSync(path.join(destination, ".git")), false);
  assert.equal(fs.readFileSync(path.join(destination, "src", "index.ts"), "utf8"), "export const fixture = true;\n");
  assert.equal(fs.readlinkSync(path.join(destination, "src", "entry.ts")), "index.ts");
  assert.equal(verifyVendoredSnapshot({ vendorDir: destination }).ok, true);
});

test("sync는 tag가 다른 commit을 가리키면 기존 destination을 보존한다", (t) => {
  const fixture = createUpstreamFixture(t);
  const destination = path.join(fixture.projectRoot, "vendor", "opencodex");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "preserved.txt"), "keep\n");
  const wrongCommit = "f".repeat(40);

  assert.throws(
    () => syncUpstream({
      repository: fixture.upstreamDir,
      tag: "v1.0.0",
      commit: wrongCommit,
      destination,
      projectRoot: fixture.projectRoot,
      syncedAt: "2026-07-27T00:00:00.000Z",
    }),
    /commit/
  );
  assert.equal(fs.readFileSync(path.join(destination, "preserved.txt"), "utf8"), "keep\n");
});
