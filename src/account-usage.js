function usageCardBase(providerId, providerLabel, profile) {
  return {
    id: `${providerId}:${profile.key}`,
    providerId,
    providerLabel,
    accountLabel: profile.label,
    active: Boolean(profile.active),
  };
}

async function loadAccountUsageCards({ providerId, providerLabel, profiles, loadUsage }) {
  if (!profiles.length) return [];

  return Promise.all(profiles.map(async (profile) => {
    const base = usageCardBase(providerId, providerLabel, profile);
    try {
      const usage = await loadUsage(profile);
      return { ...base, gauges: usage?.gauges || [] };
    } catch (error) {
      const displayMessage = typeof error?.displayMessage === "string"
        ? error.displayMessage
        : "조회 불가";
      return { ...base, error: displayMessage, gauges: [] };
    }
  }));
}

module.exports = { loadAccountUsageCards };
