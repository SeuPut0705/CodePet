const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listProviderDefinitions } = require("./provider-catalog");

const APP_LABEL = Object.freeze({ app: "앱", cli: "CLI" });

function appCandidates(providerId, { platform, homeDir, env }) {
  if (platform === "darwin") {
    const names = {
      codex: ["Codex.app", "ChatGPT.app"],
      agy: ["Antigravity.app"],
      claude: ["Claude.app"],
      kimi: ["Kimi.app"],
      cursor: ["Cursor.app"],
      opencode: ["OpenCode.app"],
      windsurf: ["Windsurf.app"],
    }[providerId] || [];
    return names.flatMap((name) => [
      path.join("/Applications", name),
      path.join(homeDir, "Applications", name),
    ]);
  }

  if (platform === "win32") {
    const pathApi = path.win32;
    const local = env.LOCALAPPDATA || pathApi.join(homeDir, "AppData", "Local");
    const programs = env.ProgramFiles || "C:\\Program Files";
    return {
      codex: [pathApi.join(local, "Programs", "Codex", "Codex.exe")],
      agy: [pathApi.join(local, "Programs", "antigravity", "Antigravity.exe")],
      claude: [pathApi.join(local, "Programs", "Claude", "Claude.exe")],
      kimi: [pathApi.join(local, "Programs", "Kimi", "Kimi.exe")],
      cursor: [pathApi.join(local, "Programs", "cursor", "Cursor.exe")],
      opencode: [
        pathApi.join(local, "Programs", "OpenCode", "OpenCode.exe"),
        pathApi.join(homeDir, "scoop", "apps", "opencode-desktop", "current", "OpenCode.exe"),
      ],
      windsurf: [
        pathApi.join(local, "Programs", "Windsurf", "Windsurf.exe"),
        pathApi.join(programs, "Windsurf", "Windsurf.exe"),
      ],
    }[providerId] || [];
  }

  return {
    cursor: ["/usr/bin/cursor", "/usr/local/bin/cursor"],
    opencode: ["/usr/bin/opencode-desktop", "/usr/local/bin/opencode-desktop"],
    windsurf: ["/usr/bin/windsurf", "/usr/local/bin/windsurf"],
  }[providerId] || [];
}

function cliNames(providerId) {
  return {
    codex: ["codex"],
    agy: ["agy", "antigravity"],
    claude: ["claude"],
    kimi: ["kimi"],
    gemini: ["gemini"],
    copilot: ["copilot"],
    // 현재 설치기는 agent와 cursor-agent 둘 다 제공하지만 구버전은 후자만 있습니다.
    cursor: ["agent", "cursor-agent"],
    opencode: ["opencode"],
  }[providerId] || [];
}

function geminiUserDir(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  return path.join(env.GEMINI_CLI_HOME || homeDir, ".gemini");
}

function cliCandidates(name, { platform, homeDir, env }) {
  if (platform === "win32") {
    const pathApi = path.win32;
    const appData = env.APPDATA || pathApi.join(homeDir, "AppData", "Roaming");
    const local = env.LOCALAPPDATA || pathApi.join(homeDir, "AppData", "Local");
    const pnpmHome = env.PNPM_HOME || pathApi.join(local, "pnpm");
    const scoopHome = env.SCOOP || pathApi.join(homeDir, "scoop");
    const candidates = [
      pathApi.join(appData, "npm", `${name}.cmd`),
      pathApi.join(pnpmHome, `${name}.cmd`),
      pathApi.join(homeDir, ".bun", "bin", `${name}.exe`),
      pathApi.join(scoopHome, "shims", `${name}.exe`),
      pathApi.join(scoopHome, "shims", `${name}.cmd`),
      pathApi.join(local, "Programs", name, `${name}.exe`),
      pathApi.join(homeDir, ".local", "bin", `${name}.exe`),
    ];
    if (name === "opencode") {
      if (env.OPENCODE_INSTALL_DIR) {
        candidates.unshift(pathApi.join(env.OPENCODE_INSTALL_DIR, "opencode.exe"));
      }
      candidates.push(pathApi.join(homeDir, ".opencode", "bin", "opencode.exe"));
      candidates.push(pathApi.join(homeDir, "bin", "opencode.exe"));
    }
    return candidates;
  }
  const candidates = [
    path.join(homeDir, ".local", "bin", name),
    path.join(homeDir, ".cursor", "bin", name),
    path.join(homeDir, ".npm-global", "bin", name),
    path.join(homeDir, ".local", "share", "pnpm", name),
    path.join(homeDir, ".bun", "bin", name),
    path.join(homeDir, "bin", name),
    path.join("/opt/homebrew/bin", name),
    path.join("/usr/local/bin", name),
    path.join("/usr/bin", name),
  ];
  if (platform === "darwin") candidates.push(path.join(homeDir, "Library", "pnpm", name));
  if (name === "opencode") {
    if (env.OPENCODE_INSTALL_DIR) {
      candidates.unshift(path.join(env.OPENCODE_INSTALL_DIR, "opencode"));
    }
    if (env.XDG_BIN_DIR) candidates.unshift(path.join(env.XDG_BIN_DIR, "opencode"));
    candidates.push(path.join(homeDir, ".opencode", "bin", "opencode"));
  }
  return candidates;
}

function openCodeStoragePaths(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const dataHome = platform === "win32"
    ? path.win32.join(homeDir, ".local", "share")
    : env.XDG_DATA_HOME || path.join(homeDir, ".local", "share");
  const pathApi = platform === "win32" ? path.win32 : path;
  const root = pathApi.join(dataHome, "opencode");
  return {
    database: pathApi.join(root, "opencode.db"),
    auth: pathApi.join(root, "auth.json"),
  };
}

function discoverProviderClients(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const exists = options.exists || fs.existsSync;
  const resolveCommand = options.resolveCommand || ((_name, candidates) =>
    candidates.find((candidate) => exists(candidate)) || null);
  const result = {};

  for (const provider of listProviderDefinitions()) {
    const clients = [];
    if (
      provider.clients.includes("app") &&
      appCandidates(provider.id, { platform, homeDir, env }).some((candidate) => exists(candidate))
    ) {
      clients.push({ kind: "app", label: APP_LABEL.app, detected: true });
    }
    if (provider.clients.includes("cli")) {
      const command = cliNames(provider.id).find((name) =>
        resolveCommand(name, cliCandidates(name, { platform, homeDir, env }))
      );
      if (command) clients.push({ kind: "cli", label: APP_LABEL.cli, detected: true });
    }
    result[provider.id] = { detected: clients.length > 0, clients };
  }
  return result;
}

module.exports = {
  appCandidates,
  cliCandidates,
  cliNames,
  discoverProviderClients,
  geminiUserDir,
  openCodeStoragePaths,
};
