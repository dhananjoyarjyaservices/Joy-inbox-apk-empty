const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  assignment: true,
  status: true,
  sla: true,
  soundEnabled: true,
  desktopEnabled: true
});

function normalizeNotificationPreferences(value = {}) {
  return {
    assignment: value.assignment !== false,
    status: value.status !== false,
    sla: value.sla !== false,
    soundEnabled: value.soundEnabled !== false,
    desktopEnabled: value.desktopEnabled !== false
  };
}

async function getTenantNotificationPreferences(db, organizationId, uid) {
  const snapshot = await db.collection("organizations").doc(organizationId)
    .collection("members").doc(uid).collection("settings").doc("notifications").get();
  return normalizeNotificationPreferences(snapshot.exists ? snapshot.data() : undefined);
}

module.exports = {
  DEFAULT_NOTIFICATION_PREFERENCES,
  normalizeNotificationPreferences,
  getTenantNotificationPreferences
};
