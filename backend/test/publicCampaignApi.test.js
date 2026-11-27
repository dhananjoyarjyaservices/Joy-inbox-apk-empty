"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { listPublicCampaigns, normalizeCampaignPageSize } = require("../src/publicCampaignApi");

function fakeDb(seed) {
  const records = new Map(Object.entries(seed));
  function doc(path) {
    return {
      id: path.split("/").pop(),
      async get() {
        const value = records.get(path);
        return { exists: Boolean(value), id: path.split("/").pop(), data: () => value };
      },
      collection(name) { return collection(path + "/" + name); }
    };
  }
  function collection(path) {
    return {
      doc(id) { return doc(path + "/" + id); },
      orderBy() {
        let cursorId = null;
        let pageLimit = 50;
        const query = {
          startAfter(snapshot) { cursorId = snapshot.id; return query; },
          limit(value) { pageLimit = value; return query; },
          async get() {
            const prefix = path + "/";
            const docs = [...records.entries()]
              .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
              .map(([key, value]) => ({ id: key.slice(prefix.length), data: () => value }))
              .sort((a, b) => String(b.data().createdAt).localeCompare(String(a.data().createdAt)));
            const start = cursorId ? docs.findIndex(item => item.id === cursorId) + 1 : 0;
            return { docs: docs.slice(start, start + pageLimit) };
          }
        };
        return query;
      }
    };
  }
  return { collection };
}

test("campaign page size is bounded", () => {
  assert.equal(normalizeCampaignPageSize(undefined), 50);
  assert.equal(normalizeCampaignPageSize("100"), 100);
  assert.throws(() => normalizeCampaignPageSize(101), { statusCode: 400 });
  assert.throws(() => normalizeCampaignPageSize("many"), { statusCode: 400 });
});

test("lists only the selected workspace campaign summaries with a stable next cursor", async () => {
  const db = fakeDb({
    "organizations/org_a/campaigns/c1": {
      name: "November offer", status: "completed", templateName: "nov_offer",
      recipientCount: 12, sentCount: 10, deliveredCount: 8, createdAt: "2026-11-24T10:00:00.000Z"
    },
    "organizations/org_a/campaigns/c2": {
      name: "December offer", status: "draft", templateName: "dec_offer",
      recipientCount: 20, createdAt: "2026-11-25T10:00:00.000Z"
    },
    "organizations/org_b/campaigns/secret": {
      name: "Other tenant", status: "completed", createdAt: "2026-11-26T10:00:00.000Z"
    }
  });
  const first = await listPublicCampaigns(db, "org_a", { limit: 1 });
  assert.equal(first.data.length, 1);
  assert.equal(first.data[0].id, "c2");
  assert.equal(first.data[0].recipientCount, 20);
  assert.equal(first.pagination.hasMore, true);
  assert.equal(first.pagination.nextCursor, "c2");
  const second = await listPublicCampaigns(db, "org_a", { limit: 1, cursor: first.pagination.nextCursor });
  assert.equal(second.data.length, 1);
  assert.equal(second.data[0].id, "c1");
  assert.equal(second.pagination.hasMore, false);
  assert.equal(second.data[0].sentCount, 10);
  assert.equal(second.data[0].deliveredCount, 8);
});

test("campaign listing rejects invalid workspaces and foreign or malformed cursors", async () => {
  const db = fakeDb({ "organizations/org_a/campaigns/c1": { createdAt: "2026-11-24" } });
  await assert.rejects(() => listPublicCampaigns(db, "../org_a"), { statusCode: 403 });
  await assert.rejects(() => listPublicCampaigns(db, "org_a", { cursor: "missing" }), { statusCode: 400 });
  await assert.rejects(() => listPublicCampaigns(db, "org_a", { cursor: "../other" }), { statusCode: 400 });
});
