const DEFAULT_SLA_SETTINGS = Object.freeze({ enabled: true, targetMinutes: 5 });
const MIN_SLA_MINUTES = 1;
const MAX_SLA_MINUTES = 120;

function normalizeSlaSettings(value = {}) {
  const rawMinutes = Number(value.targetMinutes);
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_SLA_SETTINGS.enabled,
    targetMinutes: Number.isInteger(rawMinutes) && rawMinutes >= MIN_SLA_MINUTES && rawMinutes <= MAX_SLA_MINUTES
      ? rawMinutes : DEFAULT_SLA_SETTINGS.targetMinutes
  };
}

async function getOrganizationSlaSettings(db, organizationId) {
  const snapshot = await db.collection("organizations").doc(organizationId)
    .collection("settings").doc("sla").get();
  return normalizeSlaSettings(snapshot.exists ? snapshot.data() : undefined);
}

module.exports = { DEFAULT_SLA_SETTINGS, MIN_SLA_MINUTES, MAX_SLA_MINUTES, normalizeSlaSettings, getOrganizationSlaSettings };
