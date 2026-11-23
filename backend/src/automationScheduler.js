"use strict";

// Keep the scheduled Lambda entry point on the same lease-aware worker used
// for queue processing. The previous scheduler duplicated send logic and
// could resend a message if Meta accepted it but Firestore persistence failed.
const { processAutomationQueue } = require("./automationWorker");

async function runScheduledAutomationSteps(options = {}) {
  return processAutomationQueue(options);
}

module.exports = { runScheduledAutomationSteps };
