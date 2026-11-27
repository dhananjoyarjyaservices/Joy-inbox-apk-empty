import assert from "node:assert/strict";
import { test } from "node:test";
import { moveItem } from "../src/utils/reorder.ts";

test("moves an item in either direction without mutating the original list", () => {
  const source = ["trigger", "branch", "reply"];
  assert.deepEqual(moveItem(source, 0, 2), ["branch", "reply", "trigger"]);
  assert.deepEqual(moveItem(source, 2, 0), ["reply", "trigger", "branch"]);
  assert.deepEqual(source, ["trigger", "branch", "reply"]);
});

test("returns a safe copy for invalid or unchanged indexes", () => {
  const source = [1, 2, 3];
  assert.deepEqual(moveItem(source, -1, 1), source);
  assert.deepEqual(moveItem(source, 0, 3), source);
  assert.deepEqual(moveItem(source, 1.5, 0), source);
  assert.notEqual(moveItem(source, 1, 1), source);
});
