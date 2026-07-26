const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const METADATA_FILES = new Set(["FILES.sha256", "UPSTREAM.json"]);
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SNAPSHOT_MODES = new Set(["100644", "100755", "120000"]);

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256Value(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.includes("\\") || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && !normalized.startsWith("../");
}

function parseInventory(text) {
  const entries = [];
  const paths = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([0-9a-f]{64})  (\d{6})  (.+)$/.exec(line);
    if (!match) throw new Error(`malformed inventory line: ${line}`);
    const [, hash, mode, relativePath] = match;
    if (!SNAPSHOT_MODES.has(mode)) throw new Error(`unsupported mode: ${mode}`);
    if (!safeRelativePath(relativePath)) throw new Error(`unsafe path: ${relativePath}`);
    if (paths.has(relativePath)) throw new Error(`duplicate path: ${relativePath}`);
    paths.add(relativePath);
    entries.push({ hash, mode, relativePath });
  }
  return entries;
}

function snapshotEntryMode(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) return "120000";
  if (!stat.isFile()) return null;
  return stat.mode & 0o111 ? "100755" : "100644";
}

function internalSymlinkTarget(rootDir, filePath, target) {
  if (!target || target.includes("\0") || path.isAbsolute(target)) return null;
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(path.dirname(filePath), target);
  const relativeTarget = path.relative(resolvedRoot, resolvedTarget);
  if (relativeTarget === "" || (!relativeTarget.startsWith(`..${path.sep}`) && relativeTarget !== ".." && !path.isAbsolute(relativeTarget))) {
    return target;
  }
  return null;
}

function snapshotEntryHash({
  rootDir,
  filePath,
  expectedMode,
  allowExecutableMaterialization = false,
  materializedSymlinkTarget,
} = {}) {
  const actualMode = snapshotEntryMode(filePath);
  if (expectedMode === "120000") {
    const target = actualMode === "120000"
      ? fs.readlinkSync(filePath)
      : materializedSymlinkTarget ?? fs.readFileSync(filePath, "utf8");
    if (internalSymlinkTarget(rootDir, filePath, target) === null) return null;
    return sha256Value(`symlink:${target}`);
  }
  const materializedExecutable = allowExecutableMaterialization
    && expectedMode === "100755"
    && actualMode === "100644";
  return actualMode === expectedMode || materializedExecutable ? sha256File(filePath) : null;
}

function requireString(manifest, field) {
  if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
    throw new Error(`manifest ${field} is required`);
  }
}

function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manifest must be an object");
  }
  if (value.schemaVersion !== 1) throw new Error("manifest schemaVersion must be 1");
  for (const field of [
    "repository",
    "tag",
    "commit",
    "tree",
    "license",
    "licensePath",
    "licenseSha256",
    "inventoryPath",
    "syncedAt",
  ]) {
    requireString(value, field);
  }
  if (!GIT_SHA_PATTERN.test(value.commit)) throw new Error("manifest commit must be a 40-character SHA");
  if (!GIT_SHA_PATTERN.test(value.tree)) throw new Error("manifest tree must be a 40-character SHA");
  if (value.license !== "MIT") throw new Error("manifest license must be MIT");
  if (!SHA_PATTERN.test(value.licenseSha256)) throw new Error("manifest licenseSha256 must be SHA-256");
  if (!safeRelativePath(value.licensePath)) throw new Error("manifest licensePath is unsafe");
  if (!safeRelativePath(value.inventoryPath)) throw new Error("manifest inventoryPath is unsafe");
  if (!Number.isInteger(value.trackedFiles) || value.trackedFiles < 1) {
    throw new Error("manifest trackedFiles must be a positive integer");
  }
  if (!Array.isArray(value.patches) || value.patches.some((patchName) => !safeRelativePath(patchName))) {
    throw new Error("manifest patches must contain safe relative paths");
  }
  return { ...value, patches: [...value.patches] };
}

function listSnapshotFiles(rootDir, relativeDir = "") {
  const directory = path.join(rootDir, relativeDir);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      files.push({ relativePath, symbolicLink: true });
    } else if (entry.isDirectory()) {
      files.push(...listSnapshotFiles(rootDir, relativePath));
    } else if (entry.isFile() && !METADATA_FILES.has(relativePath)) {
      files.push({ relativePath, symbolicLink: false });
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function failedVerification(error) {
  return {
    ok: false,
    errors: [error instanceof Error ? error.message : String(error)],
    filesChecked: 0,
    manifest: null,
  };
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function verifyVendoredSnapshot({ vendorDir, platform = process.platform, readMaterializedSymlinkTarget }) {
  try {
    const manifestPath = path.join(vendorDir, "UPSTREAM.json");
    const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    const inventory = parseInventory(fs.readFileSync(path.join(vendorDir, manifest.inventoryPath), "utf8"));
    const errors = [];
    const tracked = new Map(inventory.map((entry) => [entry.relativePath, entry]));

    if (inventory.length !== manifest.trackedFiles) {
      errors.push(`tracked file count mismatch: expected ${manifest.trackedFiles}, found ${inventory.length}`);
    }

    for (const { hash, mode, relativePath } of inventory) {
      const filePath = path.join(vendorDir, ...relativePath.split("/"));
      const fileStat = lstatOrNull(filePath);
      if (!fileStat) {
        errors.push(`missing file: ${relativePath}`);
      } else if (!fileStat.isFile() && !fileStat.isSymbolicLink()) {
        errors.push(`not a regular file: ${relativePath}`);
      } else {
        const actualMode = snapshotEntryMode(filePath);
        const materializedWindowsSymlink = mode === "120000" && actualMode === "100644";
        const materializedWindowsExecutable = platform === "win32"
          && mode === "100755"
          && actualMode === "100644";
        if (actualMode !== mode && !materializedWindowsSymlink && !materializedWindowsExecutable) {
          errors.push(`mode mismatch: ${relativePath}`);
        } else {
          const actualHash = snapshotEntryHash({
            rootDir: vendorDir,
            filePath,
            expectedMode: mode,
            allowExecutableMaterialization: materializedWindowsExecutable,
            materializedSymlinkTarget: materializedWindowsSymlink
              ? readMaterializedSymlinkTarget?.(relativePath)
              : undefined,
          });
          if (actualHash === null && mode === "120000") {
            errors.push(`unsafe symbolic link: ${relativePath}`);
          } else if (actualHash !== hash) {
            errors.push(`hash mismatch: ${relativePath}`);
          }
        }
      }
    }

    for (const entry of listSnapshotFiles(vendorDir)) {
      if (!tracked.has(entry.relativePath)) {
        errors.push(`unexpected file: ${entry.relativePath}`);
      }
    }

    const licensePath = path.join(vendorDir, ...manifest.licensePath.split("/"));
    if (fs.existsSync(licensePath) && sha256File(licensePath) !== manifest.licenseSha256) {
      errors.push(`license hash mismatch: ${manifest.licensePath}`);
    }

    return {
      ok: errors.length === 0,
      errors,
      filesChecked: inventory.length,
      manifest,
    };
  } catch (error) {
    return failedVerification(error);
  }
}

module.exports = {
  parseInventory,
  sha256File,
  snapshotEntryHash,
  snapshotEntryMode,
  validateManifest,
  verifyVendoredSnapshot,
};
