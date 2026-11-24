"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateCrmSalesReport } = require("../src/crmSalesReport");

test("aggregates pipeline, revenue, owner and source sales reporting", () => {
  const report = aggregateCrmSalesReport([
    { title: "A", stageId: "new", ownerUid: "agent_a", source: "Website", value: 1000 },
    { title: "B", stageId: "won", ownerUid: "agent_a", source: "Website", value: 2500 },
    { title: "C", stageId: "lost", ownerUid: "agent_b", source: "Referral", value: 500 },
    { title: "D", stageId: "new", ownerUid: "", source: "", value: null }
  ], [
    { id: "new", name: "New" },
    { id: "won", name: "Won", isWon: true },
    { id: "lost", name: "Lost", isLost: true }
  ], [
    { uid: "agent_a", displayName: "Agent A" },
    { uid: "agent_b", email: "agent@example.com" }
  ], false, new Date("2026-11-24T12:00:00Z"));
  assert.equal(report.total, 4);
  assert.equal(report.open, 2);
  assert.equal(report.won, 1);
  assert.equal(report.lost, 1);
  assert.equal(report.openValue, 1000);
  assert.equal(report.wonValue, 2500);
  assert.equal(report.lostValue, 500);
  assert.equal(report.conversionRate, 50);
  assert.equal(report.byOwner[0].name, "Agent A");
  assert.equal(report.bySource.find(item => item.source === "Website").total, 2);
  assert.equal(report.byOwner.find(item => item.uid === "unassigned").total, 1);
  assert.equal(report.byCurrency.find(item => item.currency === "INR").wonValue, 2500);
});

test("reports an empty pipeline safely and flags capped samples", () => {
  const report = aggregateCrmSalesReport([], [], [], true, new Date("2026-11-24T12:00:00Z"));
  assert.equal(report.total, 0);
  assert.equal(report.conversionRate, 0);
  assert.equal(report.limited, true);
  assert.deepEqual(report.byStage, []);
});


test("calculates weighted open pipeline forecast from stage probabilities", () => {
  const report = aggregateCrmSalesReport([
    { title: "High confidence", stageId: "qualified", value: 10000 },
    { title: "Early lead", stageId: "new", value: 20000 },
    { title: "Closed", stageId: "won", value: 5000 }
  ], [
    { id: "qualified", name: "Qualified", probability: 75 },
    { id: "new", name: "New", probability: 20 },
    { id: "won", name: "Won", isWon: true, probability: 100 }
  ], []);
  assert.equal(report.openValue, 30000);
  assert.equal(report.weightedOpenValue, 11500);
  assert.equal(report.byCurrency[0].weightedOpenValue, 11500);
});
