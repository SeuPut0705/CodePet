const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  sha256File,
  snapshotEntryHash,
  snapshotEntryMode,
  verifyVendoredSnapshot,
} = require("../../src/open-codex/upstream-provenance");

const DEFAULT_REPOSITORY = "https://github.com/lidge-jun/opencodex.git";
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_DESTINATION = path.join(PROJECT_ROOT, "vendor", "opencodex");
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const METADATA_FILES = new Set(["FILES.sha256", "UPSTREAM.json"]);

function runGit(args, { cwd } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "unknown git error").trim();
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function parseSyncArgs(argv) {
  const values = {
    repository: DEFAULT_REPOSITORY,
    destination: DEFAULT_DESTINATION,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${key || "argument"} requires a value`);
    if (key === "--tag") values.tag = value;
    else if (key === "--commit") values.commit = value;
    else if (key === "--repository") values.repository = value;
    else if (key === "--destination") values.destination = path.resolve(value);
    else if (key === "--synced-at") values.syncedAt = value;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (typeof values.tag !== "string" || !/^v\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(values.tag)) {
    throw new Error("tag is required and must be a version tag");
  }
  if (typeof values.commit !== "string" || !GIT_SHA_PATTERN.test(values.commit)) {
    throw new Error("commit is required and must be a 40-character SHA");
  }
  if (path.resolve(values.destination) !== path.resolve(DEFAULT_DESTINATION)) {
    throw new Error(`destination must be ${DEFAULT_DESTINATION}`);
  }
  return {
    ...values,
    destination: DEFAULT_DESTINATION,
    projectRoot: PROJECT_ROOT,
    syncedAt: values.syncedAt || new Date().toISOString(),
  };
}

function safeTrackedPath(relativePath) {
  if (!relativePath || relativePath.includes("\\") || relativePath.includes("\n") || relativePath.includes("\r")) {
    return false;
  }
  if (path.posix.isAbsolute(relativePath)) return false;
  return path.posix.normalize(relativePath) === relativePath && !relativePath.startsWith("../");
}

function trackedFiles(checkoutDir) {
  const output = runGit(["ls-files", "-z"], { cwd: checkoutDir });
  const files = output.split("\0").filter(Boolean).sort();
  for (const relativePath of files) {
    if (!safeTrackedPath(relativePath)) throw new Error(`unsafe tracked path: ${relativePath}`);
    if (METADATA_FILES.has(relativePath)) throw new Error(`reserved tracked path: ${relativePath}`);
  }
  return files;
}

function copyTrackedFiles(checkoutDir, stagingDir, files) {
  for (const relativePath of files) {
    const sourcePath = path.join(checkoutDir, ...relativePath.split("/"));
    const sourceStat = fs.lstatSync(sourcePath);
    const targetPath = path.join(stagingDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (sourceStat.isSymbolicLink()) {
      const target = fs.readlinkSync(sourcePath);
      const resolvedTarget = path.resolve(path.dirname(sourcePath), target);
      const relativeTarget = path.relative(checkoutDir, resolvedTarget);
      if (path.isAbsolute(target) || relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`)) {
        throw new Error(`tracked symbolic link escapes checkout: ${relativePath}`);
      }
      fs.symlinkSync(target, targetPath);
    } else if (sourceStat.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
      fs.chmodSync(targetPath, sourceStat.mode & 0o777);
    } else {
      throw new Error(`tracked path is not a file: ${relativePath}`);
    }
  }
}

function writeInventory(stagingDir, files) {
  const inventory = files
    .map((relativePath) => {
      const filePath = path.join(stagingDir, ...relativePath.split("/"));
      const mode = snapshotEntryMode(filePath);
      const hash = snapshotEntryHash({ rootDir: stagingDir, filePath, expectedMode: mode });
      if (!mode || !hash) throw new Error(`cannot inventory tracked path: ${relativePath}`);
      return `${hash}  ${mode}  ${relativePath}`;
    })
    .join("\n");
  fs.writeFileSync(path.join(stagingDir, "FILES.sha256"), `${inventory}\n`);
}

function applyPatchSeries({ projectRoot, vendorDir }) {
  const patchDir = path.join(projectRoot, "patches", "opencodex");
  const seriesPath = path.join(patchDir, "series.json");
  if (!fs.existsSync(seriesPath)) return [];
  const series = JSON.parse(fs.readFileSync(seriesPath, "utf8"));
  if (series.schemaVersion !== 1 || !Array.isArray(series.patches)) {
    throw new Error("OpenCodex patch series must use schemaVersion 1");
  }
  const applied = [];
  for (const patchDefinition of series.patches) {
    if (!patchDefinition || !/^[a-z0-9-]+$/.test(patchDefinition.id || "")) {
      throw new Error("OpenCodex patch id must contain lowercase letters, digits, or hyphens");
    }
    if (path.basename(patchDefinition.module || "") !== patchDefinition.module) {
      throw new Error(`OpenCodex patch module is unsafe: ${patchDefinition.id}`);
    }
    if (typeof patchDefinition.reason !== "string" || !patchDefinition.reason.trim()) {
      throw new Error(`OpenCodex patch reason is required: ${patchDefinition.id}`);
    }
    const patchModule = require(path.join(patchDir, patchDefinition.module));
    if (typeof patchModule.apply !== "function") {
      throw new Error(`OpenCodex patch module must export apply: ${patchDefinition.id}`);
    }
    patchModule.apply({ vendorDir });
    applied.push(patchDefinition.id);
  }
  return applied;
}

function buildManifest({ checkoutDir, repository, tag, commit, syncedAt, trackedFileCount, patches = [] }) {
  return {
    schemaVersion: 1,
    repository,
    tag,
    commit,
    tree: runGit(["rev-parse", "HEAD^{tree}"], { cwd: checkoutDir }),
    license: "MIT",
    licensePath: "LICENSE",
    licenseSha256: sha256File(path.join(checkoutDir, "LICENSE")),
    inventoryPath: "FILES.sha256",
    trackedFiles: trackedFileCount,
    syncedAt,
    patches,
  };
}

function replaceDestination(stagingDir, destination) {
  const backup = `${destination}.backup-${process.pid}-${Date.now()}`;
  const hadDestination = fs.existsSync(destination);
  if (hadDestination) fs.renameSync(destination, backup);
  try {
    fs.renameSync(stagingDir, destination);
    if (hadDestination) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    if (hadDestination && fs.existsSync(backup)) fs.renameSync(backup, destination);
    throw error;
  }
}

function syncUpstream({ repository, tag, commit, destination, projectRoot, syncedAt }) {
  const expectedDestination = path.join(path.resolve(projectRoot), "vendor", "opencodex");
  if (path.resolve(destination) !== expectedDestination) {
    throw new Error(`destination must be ${expectedDestination}`);
  }
  if (!GIT_SHA_PATTERN.test(commit)) throw new Error("commit must be a 40-character SHA");

  const checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-opencodex-checkout-"));
  const vendorParent = path.dirname(expectedDestination);
  fs.mkdirSync(vendorParent, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(vendorParent, ".opencodex-staging-"));
  let stagingMoved = false;
  try {
    runGit(["clone", "--no-checkout", "--single-branch", "--branch", tag, repository, checkoutDir]);
    const tagCommit = runGit(["rev-parse", `${tag}^{commit}`], { cwd: checkoutDir });
    if (tagCommit !== commit) {
      throw new Error(`tag ${tag} commit mismatch: expected ${commit}, found ${tagCommit}`);
    }
    runGit(["checkout", "--detach", commit], { cwd: checkoutDir });
    const files = trackedFiles(checkoutDir);
    copyTrackedFiles(checkoutDir, stagingDir, files);
    const patches = applyPatchSeries({ projectRoot, vendorDir: stagingDir });
    writeInventory(stagingDir, files);
    const manifest = buildManifest({
      checkoutDir,
      repository,
      tag,
      commit,
      syncedAt,
      trackedFileCount: files.length,
      patches,
    });
    fs.writeFileSync(path.join(stagingDir, "UPSTREAM.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const verification = verifyVendoredSnapshot({ vendorDir: stagingDir });
    if (!verification.ok) throw new Error(`staged snapshot verification failed: ${verification.errors.join("; ")}`);
    replaceDestination(stagingDir, expectedDestination);
    stagingMoved = true;
    return manifest;
  } finally {
    fs.rmSync(checkoutDir, { recursive: true, force: true });
    if (!stagingMoved) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function main() {
  const options = parseSyncArgs(process.argv.slice(2));
  const result = syncUpstream(options);
  process.stdout.write(
    `OpenCodex ${result.tag} ${result.commit} synced (${result.trackedFiles} files)\n`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  applyPatchSeries,
  buildManifest,
  parseSyncArgs,
  syncUpstream,
  trackedFiles,
};
