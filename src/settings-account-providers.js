(function (root, factory) {
  const catalog = typeof module !== "undefined" && module.exports
    ? require("./provider-catalog")
    : root?.providerCatalog;
  const api = factory(catalog);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.settingsAccountProviders = api;
})(typeof window !== "undefined" ? window : null, function (catalog) {
  "use strict";

  const ACCOUNT_PROVIDER_DEFINITIONS = Object.freeze(
    (catalog?.listProviderDefinitions?.() || []).map((provider) => Object.freeze({
      ...provider,
      canAddAccount: Boolean(provider.connection),
    }))
  );

  function buildSettingsAccountProviders(accountsByProvider = {}, clientStatusByProvider = {}) {
    return ACCOUNT_PROVIDER_DEFINITIONS.map((definition) => {
      const accounts = Array.isArray(accountsByProvider?.[definition.id])
        ? accountsByProvider[definition.id]
        : [];
      return {
        ...definition,
        accounts,
        clients: Array.isArray(clientStatusByProvider?.[definition.id]?.clients)
          ? clientStatusByProvider[definition.id].clients
          : [],
        detected: clientStatusByProvider?.[definition.id]?.detected === true,
        connected:
          accounts.length > 0 || clientStatusByProvider?.[definition.id]?.connected === true,
      };
    });
  }

  function connectedAccountProviders(providers) {
    if (!Array.isArray(providers)) return [];
    return providers.filter((provider) => provider && (
      (Array.isArray(provider.accounts) && provider.accounts.length > 0) ||
      provider.detected === true ||
      provider.connected === true
    ));
  }

  function accountProviderMenuItems(providers) {
    if (!Array.isArray(providers)) return [];
    const seen = new Set();
    const result = [];
    for (const provider of providers) {
      const id = typeof provider?.id === "string" ? provider.id.trim() : "";
      const label = typeof provider?.label === "string" ? provider.label.trim() : "";
      if (!id || !label || provider.canAddAccount !== true || seen.has(id)) continue;
      seen.add(id);
      result.push({
        id,
        label,
        icon: provider.icon,
        action: { provider: id, action: "login" },
      });
    }
    return result;
  }

  return {
    accountProviderMenuItems,
    buildSettingsAccountProviders,
    connectedAccountProviders,
  };
});
