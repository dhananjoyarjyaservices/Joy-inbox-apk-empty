"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_NOTIFICATION_PREFERENCES,
  normalizeNotificationPreferences
} = require("../src/notificationPreferences");

test("CRM follow-up alerts are enabled by default alongside existing notifications", () => {
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.crm, true);
  assert.equal(normalizeNotificationPreferences().crm, true);
});

test("members can disable CRM follow-up alerts without changing other preferences", () => {
  const result = normalizeNotificationPreferences({ crm: false, sla: true, soundEnabled: false });
  assert.equal(result.crm, false);
  assert.equal(result.sla, true);
  assert.equal(result.soundEnabled, false);
  assert.equal(result.assignment, true);
  assert.equal(result.status, true);
});
