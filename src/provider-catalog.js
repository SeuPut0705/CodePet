(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.providerCatalog = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const DEFINITIONS = [
    {
      id: "codex",
      label: "Codex",
      icon: "./provider-icons/codex.svg",
      clients: ["app", "cli"],
      capabilities: { activity: true, accounts: true, usage: true },
      connection: "login",
    },
    {
      id: "agy",
      label: "Antigravity",
      icon: "./provider-icons/antigravity.svg",
      clients: ["app"],
      capabilities: { activity: true, accounts: true, usage: true },
      connection: "login",
    },
    {
      id: "claude",
      label: "Claude",
      icon: "./provider-icons/claude.svg",
      clients: ["app", "cli"],
      capabilities: { activity: true, accounts: true, usage: true },
      connection: "login",
    },
    {
      id: "kimi",
      label: "Kimi",
      icon: "./provider-icons/kimi.svg",
      clients: ["cli"],
      capabilities: { activity: true, accounts: true, usage: true },
      connection: "login",
    },
    {
      id: "gemini",
      label: "Gemini",
      icon: "./provider-icons/gemini.svg",
      clients: ["cli"],
      capabilities: { activity: true, accounts: true, usage: false },
      connection: "login",
    },
    {
      id: "copilot",
      label: "GitHub Copilot",
      icon: "./provider-icons/github-copilot.svg",
      clients: ["cli"],
      capabilities: { activity: true, accounts: true, usage: false },
      connection: "bridge-login",
    },
    {
      id: "cursor",
      label: "Cursor",
      icon: "./provider-icons/cursor.svg",
      clients: ["app", "cli"],
      capabilities: { activity: true, accounts: true, usage: false },
      connection: "bridge-login",
    },
    {
      id: "opencode",
      label: "OpenCode",
      icon: "./provider-icons/opencode.svg",
      clients: ["app", "cli"],
      capabilities: { activity: true, accounts: false, usage: false },
      connection: "login",
    },
    {
      id: "windsurf",
      label: "Windsurf",
      icon: "./provider-icons/windsurf.svg",
      clients: ["app"],
      capabilities: { activity: true, accounts: false, usage: false },
      connection: "bridge",
    },
  ].map((definition) => Object.freeze({
    ...definition,
    clients: Object.freeze([...definition.clients]),
    capabilities: Object.freeze({ ...definition.capabilities }),
  }));

  const PROVIDERS = Object.freeze(DEFINITIONS);
  const PROVIDER_IDS = Object.freeze(PROVIDERS.map((provider) => provider.id));
  const PROVIDERS_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

  function listProviderDefinitions() {
    return [...PROVIDERS];
  }

  function getProviderDefinition(id) {
    return PROVIDERS_BY_ID.get(String(id || "")) || null;
  }

  return {
    PROVIDER_IDS,
    getProviderDefinition,
    listProviderDefinitions,
  };
});
