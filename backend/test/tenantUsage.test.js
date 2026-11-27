"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addUtcMonths,
  getUsageWindow,
  reserveOutboundMessage,
  finishOutboundReservation,
  recordInboundMessageUsage,
  getTenantMessageUsage,
  reserveMediaTransfer,
  finishMediaTransfer
} = require("../src/tenantUsage");

function fakeDb() {
  const docs = new Map();
  function doc(path) {
    return {
      path,
      collection(name) { return collection(path + "/" + name); },
      async get() {
        const value = docs.get(path);
        return { exists: Boolean(value), id: path.split("/").pop(), data: () => value, get: key => value?.[key] };
      },
      async set(value, options) { docs.set(path, options ? { ...(docs.get(path) || {}), ...value } : value); }
    };
  }
  function collection(path) { return { doc: id => doc(path + "/" + id) }; }
  let transactionQueue = Promise.resolve();
  return {
    docs,
    collection,
    runTransaction(callback) {
      const run = transactionQueue.then(async () => {
        const writes = [];
        const transaction = {
          async get(ref) {
            const value = docs.get(ref.path);
            return { exists: Boolean(value), data: () => value, get: key => value?.[key] };
          },
          create(ref, value) { writes.push({ type: "create", path: ref.path, value }); },
          set(ref, value, options) { writes.push({ type: "set", path: ref.path, value, merge: options?.merge === true }); }
        };
        const result = await callback(transaction);
        for (const write of writes) {
          if (write.type === "create") {
            if (docs.has(write.path)) throw new Error("document already exists");
            docs.set(write.path, write.value);
          } else {
            docs.set(write.path, write.merge ? { ...(docs.get(write.path) || {}), ...write.value } : write.value);
          }
        }
        return result;
      });
      transactionQueue = run.catch(() => {});
      return run;
    }
  };
}

const plans = [
  { key: "lite", limits: { messages: 10000 } },
  { key: "growth", limits: { messages: 100000 } }
];

test("production usage gates fail closed without an active trial or subscription", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const db = fakeDb();
    const now = new Date("2026-11-24T00:00:00.000Z");
    await assert.rejects(
      () => reserveOutboundMessage(db, "org_one", "no-plan-message", now),
      { statusCode: 402, code: "SUBSCRIPTION_REQUIRED" }
    );
    await assert.rejects(
      () => reserveMediaTransfer(db, "org_one", "no-plan-media", 10, now),
      { statusCode: 402, code: "SUBSCRIPTION_REQUIRED" }
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("service-month boundaries preserve month-end dates", () => {
  assert.equal(addUtcMonths(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString(), "2026-02-28T00:00:00.000Z");
  const window = getUsageWindow({
    status: "active", plan: "growth",
    currentPeriodStart: new Date("2026-01-15T00:00:00.000Z"),
    currentPeriodEnd: new Date("2027-01-15T00:00:00.000Z")
  }, new Date("2026-03-20T00:00:00.000Z"), plans);
  assert.equal(window.start.toISOString(), "2026-03-15T00:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-04-15T00:00:00.000Z");
  assert.equal(window.limit, 100000);
});

test("annual service months stay anchored to the original cycle day after February", () => {
  const window = getUsageWindow({
    status: "active", plan: "growth",
    currentPeriodStart: new Date("2026-01-31T00:00:00.000Z"),
    currentPeriodEnd: new Date("2027-01-31T00:00:00.000Z")
  }, new Date("2026-03-20T00:00:00.000Z"), plans);
  assert.equal(window.start.toISOString(), "2026-02-28T00:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-03-31T00:00:00.000Z");
});

test("trial message allowance is 25 percent rounded up", () => {
  const window = getUsageWindow({
    status: "trialing", plan: "lite",
    trialStart: new Date("2026-11-01T00:00:00.000Z"),
    trialEnd: new Date("2026-11-08T00:00:00.000Z")
  }, new Date("2026-11-03T00:00:00.000Z"), plans);
  assert.equal(window.limit, 2500);
  assert.equal(window.trial, true);
});

test("outbound reservations enforce quota and commit exactly once", async () => {
  const db = fakeDb();
  const org = db.collection("organizations").doc("org_one");
  await org.collection("billing").doc("subscription").set({
    status: "active", plan: "lite",
    currentPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z")
  });
  const now = new Date("2026-11-24T00:00:00.000Z");
  const reservation = await reserveOutboundMessage(db, "org_one", "client-1", now);
  assert.equal(reservation.enforced, true);
  assert.equal(reservation.duplicate, false);
  const duplicate = await reserveOutboundMessage(db, "org_one", "client-1", now);
  assert.equal(duplicate.duplicate, true);
  assert.equal(await finishOutboundReservation(db, reservation, "sent", now), true);
  assert.equal(await finishOutboundReservation(db, reservation, "sent", now), false);
  const usage = db.docs.get(reservation.usageRef.path);
  assert.equal(usage.messagesUsed, 1);
  assert.equal(usage.messagesReserved, 0);
});

test("outbound reservation blocks at the hard limit and usage exposes 80/95/100 thresholds", async () => {
  const db = fakeDb();
  const org = db.collection("organizations").doc("org_one");
  await org.collection("billing").doc("subscription").set({
    status: "active", plan: "lite",
    currentPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z")
  });
  const usageRef = org.collection("billingUsage").doc("month_" + new Date("2026-11-01T00:00:00.000Z").getTime());
  await usageRef.set({ messagesUsed: 9500, messagesReserved: 0 });
  const summary = await getTenantMessageUsage(db, "org_one", {
    status: "active", plan: "lite",
    currentPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z")
  }, new Date("2026-11-24T00:00:00.000Z"));
  assert.equal(summary.percent, 95);
  assert.deepEqual(summary.thresholdsReached, [80, 95]);
  await usageRef.set({ messagesUsed: 10000, messagesReserved: 0 }, { merge: true });
  await assert.rejects(
    () => reserveOutboundMessage(db, "org_one", "client-at-limit", new Date("2026-11-24T00:00:00.000Z")),
    { statusCode: 429, code: "MESSAGE_QUOTA_EXCEEDED" }
  );
});

test("media transfer reservations count actual bytes and enforce the plan allowance", async () => {
  const db = fakeDb();
  const org = db.collection("organizations").doc("org_one");
  await org.collection("billing").doc("subscription").set({
    status: "active", plan: "lite",
    currentPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z")
  });
  const now = new Date("2026-11-24T00:00:00.000Z");
  const reservation = await reserveMediaTransfer(db, "org_one", "upload-1", 100, now);
  assert.equal(reservation.enforced, true);
  await finishMediaTransfer(db, reservation, "sent", 80, now);
  const usage = db.docs.get(reservation.usageRef.path);
  assert.equal(usage.mediaBytesUsed, 80);
  assert.equal(usage.mediaBytesReserved, 0);
  const fullLimit = 1024 * 1024 * 1024;
  const full = await reserveMediaTransfer(db, "org_one", "upload-full", fullLimit - 80, now);
  await assert.rejects(
    () => reserveMediaTransfer(db, "org_one", "upload-over", 1, now),
    { statusCode: 429, code: "MEDIA_QUOTA_EXCEEDED" }
  );
  await finishMediaTransfer(db, full, "failed", 0, now);
});

test("failed sends release reserved quota without consuming messages", async () => {
  const db = fakeDb();
  const org = db.collection("organizations").doc("org_one");
  await org.collection("billing").doc("subscription").set({
    status: "active", plan: "lite",
    currentPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z")
  });
  const reservation = await reserveOutboundMessage(db, "org_one", "client-2", new Date("2026-11-24T00:00:00.000Z"));
  await finishOutboundReservation(db, reservation, "failed");
  const usage = db.docs.get(reservation.usageRef.path);
  assert.equal(usage.messagesUsed, 0);
  assert.equal(usage.messagesReserved, 0);
});

test("inbound provider message usage is idempotent and does not reject inbound messages at quota", async () => {
  const db = fakeDb();
  const org = db.collection("organizations").doc("org_one");
  await org.collection("billing").doc("subscription").set({
    status: "trialing", plan: "lite",
    trialStart: new Date("2026-11-01T00:00:00.000Z"),
    trialEnd: new Date("2026-11-08T00:00:00.000Z")
  });
  const now = new Date("2026-11-03T00:00:00.000Z");
  assert.equal(await recordInboundMessageUsage(db, "org_one", "wamid.abc", now), true);
  assert.equal(await recordInboundMessageUsage(db, "org_one", "wamid.abc", now), false);
  const usage = [...db.docs.entries()].find(([path]) => path.includes("/billingUsage/"))[1];
  assert.equal(usage.messagesUsed, 1);
});


test("concurrent outbound reservations cannot exceed the final available message quota", async () => {
  const db = fakeDb();
  const now = new Date("2026-11-24T00:00:00.000Z");
  const subscription = {
    status: "active",
    plan: "lite",
    currentPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z")
  };
  const organization = db.collection("organizations").doc("org_one");
  await organization.collection("billing").doc("subscription").set(subscription);
  const window = getUsageWindow(subscription, now);
  db.docs.set(`organizations/org_one/billingUsage/${window.key}`, {
    plan: "lite",
    periodKey: window.key,
    messageLimit: window.limit,
    messagesUsed: window.limit - 1,
    messagesReserved: 0
  });

  const results = await Promise.allSettled([
    reserveOutboundMessage(db, "org_one", "concurrent-message-a", now),
    reserveOutboundMessage(db, "org_one", "concurrent-message-b", now)
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.statusCode === 429).length, 1);
  const usage = db.docs.get(`organizations/org_one/billingUsage/${window.key}`);
  assert.equal(usage.messagesUsed + usage.messagesReserved, window.limit);
  assert.equal(usage.messagesReserved, 1);
});
