import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCrmCsv } from "../src/utils/crmCsv.ts";

test("parses BOM-prefixed CRLF CSV with quoted commas and custom fields", () => {
  const csv = "\uFEFFtitle,source,company,budget,verified\r\n\"Website, redesign\",Website,Acme,1250.5,yes\r\nFollow up,Referral,Beta,900,no";
  const rows = parseCrmCsv(csv, [
    { key: "company", type: "text", active: true },
    { key: "budget", type: "number", active: true },
    { key: "verified", type: "boolean", active: true }
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "Website, redesign");
  assert.deepEqual(rows[0].customFields, { company: "Acme", budget: 1250.5, verified: true });
  assert.deepEqual(rows[1].customFields, { company: "Beta", budget: 900, verified: false });
});

test("accepts custom_ prefixed field headers and preserves invalid typed values for server validation", () => {
  const rows = parseCrmCsv("title,custom_budget\nDeal,not-a-number", [
    { key: "budget", type: "number", active: true }
  ]);
  assert.deepEqual(rows[0].customFields, { budget: "not-a-number" });
});

test("normalizes headers and rejects duplicate headers", () => {
  assert.throws(() => parseCrmCsv("title,stage-id,stage_id\nDeal,new,new"), /duplicate column headers/);
  assert.equal(parseCrmCsv("title,stage-id\nDeal,qualified")[0].stageId, "qualified");
});

test("rejects extra cells, unclosed quotes, missing title and empty data", () => {
  assert.throws(() => parseCrmCsv("title,source\nDeal,Web,Extra"), /more values than the header/);
  assert.throws(() => parseCrmCsv('title\n"unfinished'), /unclosed quoted field/);
  assert.throws(() => parseCrmCsv("source\nWeb"), /title.*column/);
  assert.throws(() => parseCrmCsv("title\n"), /header and at least one lead/);
});

test("rejects CSV files above the 200-lead import limit", () => {
  const csv = ["title", ...Array.from({ length: 201 }, (_, index) => `Lead ${index + 1}`)].join("\n");
  assert.throws(() => parseCrmCsv(csv), /no more than 200 leads/);
});
