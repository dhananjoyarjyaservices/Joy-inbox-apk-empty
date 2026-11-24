"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  subtractUtcMonths,
  getRetentionCutoff,
  runScheduledHistoryRetention
} = require("../src/historyRetention");

function fakeDb(seed = {}) {
  const records = new Map(Object.entries(seed));
  function makeRef(path) {
    return {
      path,
      id: path.split("/").at(-1),
      collection(name) { return makeCollection(path + "/" + name); },
      async get() {
        const data = records.get(path);
        return { exists: data !== undefined, id: path.split("/").at(-1), data: () => data };
      },
      async set(value, options) {
        records.set(path, options ? { ...(records.get(path) || {}), ...value } : value);
      }
    };
  }
  function makeCollection(path) {
    return {
      path,
      doc(id) { return makeRef(path + "/" + id); },
      where(field, operator, value) { return makeQuery(path, [{ field, operator, value }]); },
      orderBy(field, direction = "asc") { return makeQuery(path, [], { field, direction }); }
    };
  }
  function makeQuery(path, filters = [], ordering = null, afterId = "", max = Infinity) {
    const query = {
      where(field, operator, value) { return makeQuery(path, [...filters, { field, operator, value }], ordering, afterId, max); },
      orderBy(field, direction = "asc") { return makeQuery(path, filters, { field, direction }, afterId, max); },
      startAfter(snapshot) { return makeQuery(path, filters, ordering, snapshot.id, max); },
      limit(value) { return makeQuery(path, filters, ordering, afterId, value); },
      async get() {
        const prefix = path + "/";
        let docs = [...records.entries()]
          .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map(([key, data]) => ({ id: key.slice(prefix.length), ref: makeRef(key), data: () => data }));
        docs = docs.filter(doc => filters.every(filter => {
          const value = doc.data()[filter.field];
          if (filter.operator === "==") return value === filter.value;
          if (filter.operator === "<") return value < filter.value;
          return false;
        }));
        if (ordering) {
          docs.sort((a, b) => {
            const left = ordering.field === "__name__" ? a.id : a.data()[ordering.field]?.getTime?.() ?? 0;
            const right = ordering.field === "__name__" ? b.id : b.data()[ordering.field]?.getTime?.() ?? 0;
            return (ordering.direction === "desc" ? -1 : 1) * (left < right ? -1 : left > right ? 1 : 0);
          });
        }
        if (afterId) docs = docs.filter(doc => doc.id > afterId);
        return { docs: docs.slice(0, max), size: Math.min(docs.length, max) };
      }
    };
    return query;
  }
  return {
    records,
    collection: makeCollection,
    batch() {
      const deletes = [];
      return {
        delete(ref) { deletes.push(ref.path); },
        async commit() { deletes.forEach(path => records.delete(path)); return []; }
      };
    }
  };
}

test("history cutoff follows plan retention months and clamps month-end dates", () => {
  assert.equal(subtractUtcMonths(new Date("2026-03-31T00:00:00.000Z"), 1).toISOString(), "2026-02-28T00:00:00.000Z");
  assert.equal(getRetentionCutoff("lite", new Date("2026-11-24T00:00:00.000Z")).toISOString(), "2026-08-24T00:00:00.000Z");
  assert.equal(getRetentionCutoff("unknown", new Date()), null);
});

test("retention worker deletes only messages older than the active plan window", async () => {
  const db = fakeDb({
    "organizations/org_1": { status: "active", createdBy: "owner_1" },
    "organizations/org_1/billing/subscription": { status: "active", plan: "lite" },
    "organizations/org_1/chats/chat_1": { customerPhone: "919876543210" },
    "organizations/org_1/chats/chat_1/messages/old": { timestamp: new Date("2026-08-01T00:00:00.000Z"), text: "old" },
    "organizations/org_1/chats/chat_1/messages/new": { timestamp: new Date("2026-10-01T00:00:00.000Z"), text: "new" }
  });
  const result = await runScheduledHistoryRetention(db, {
    now: new Date("2026-11-24T00:00:00.000Z"),
    maxOrganizations: 20,
    maxChatsPerOrganization: 50,
    maxMessages: 400
  });
  assert.equal(result.deletedMessages, 1);
  assert.equal(db.records.has("organizations/org_1/chats/chat_1/messages/old"), false);
  assert.equal(db.records.has("organizations/org_1/chats/chat_1/messages/new"), true);
  assert.equal(db.records.has("organizations/org_1/chats/chat_1"), true);
});
