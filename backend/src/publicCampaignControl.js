"use strict";

const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function buildPublicCampaignTransition(action, campaign, scheduledAtInput, now = new Date()) {
  const transitions = {
    start: { from: ["draft"], to: "queued" },
    schedule: { from: ["draft"], to: "scheduled" },
    pause: { from: ["queued", "sending", "scheduled"], to: "paused" },
    resume: { from: ["paused"], to: "queued" },
    cancel: { from: ["draft", "scheduled", "queued", "sending", "paused"], to: "cancelled" }
  };
  const transition = transitions[action];
  if (!transition) throw httpError("Unsupported campaign action.", 400);
  const currentStatus = String(campaign?.status || "draft");
  if (!transition.from.includes(currentStatus)) {
    throw httpError(`Campaign cannot ${action} while status is ${currentStatus}.`, 409);
  }
  if ((action === "start" || action === "schedule" || action === "resume") &&
      (!Number.isSafeInteger(Number(campaign?.recipientCount)) || Number(campaign.recipientCount) < 1)) {
    throw httpError("A campaign must contain at least one eligible recipient before it can be queued.", 409);
  }
  const patch = { status: transition.to, updatedAt: now };
  if (action === "start" || action === "resume") patch.queuedAt = now;
  if (action === "schedule") {
    const scheduledAt = new Date(scheduledAtInput);
    if (!scheduledAtInput || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= now.getTime()) {
      throw httpError("Choose a future campaign schedule time.", 400);
    }
    patch.scheduledAt = scheduledAt;
  }
  if (action === "cancel") patch.cancelledAt = now;
  if (action === "pause") patch.pausedAt = now;
  return patch;
}

module.exports = { CAMPAIGN_ID_PATTERN, buildPublicCampaignTransition };
