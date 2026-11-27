import assert from "node:assert/strict";
import { test } from "node:test";
import { collectCursorPages } from "../src/services/pagination.ts";

test("collects every cursor page in order", async () => {
  const requests = [];
  const items = await collectCursorPages(async cursor => {
    requests.push(cursor || null);
    if (!cursor) return { items: [1, 2], nextCursor: "page-2" };
    if (cursor === "page-2") return { items: [3, 4], nextCursor: "page-3" };
    return { items: [5], nextCursor: null };
  });
  assert.deepEqual(items, [1, 2, 3, 4, 5]);
  assert.deepEqual(requests, [null, "page-2", "page-3"]);
});

test("rejects repeated cursors rather than looping forever", async () => {
  let calls = 0;
  await assert.rejects(
    () => collectCursorPages(async cursor => {
      calls += 1;
      return { items: [calls], nextCursor: cursor ? "page-1" : "page-1" };
    }),
    /repeated cursor/
  );
  assert.equal(calls, 2);
});

test("propagates page retrieval errors without returning partial results", async () => {
  await assert.rejects(
    () => collectCursorPages(async cursor => {
      if (cursor) throw new Error("Page fetch failed");
      return { items: ["first"], nextCursor: "page-2" };
    }),
    /Page fetch failed/
  );
});
