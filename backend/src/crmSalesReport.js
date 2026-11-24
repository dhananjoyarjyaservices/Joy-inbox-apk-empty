"use strict";

const REPORT_LIMIT = 1000;

function aggregateCrmSalesReport(leads, stages, members, limited = false, generatedAt = new Date()) {
  const stageMap = new Map(stages.map(stage => [stage.id, stage]));
  const memberMap = new Map(members.map(member => [member.uid, member]));
  const byStage = new Map();
  const byOwner = new Map();
  const bySource = new Map();
  const byCurrency = new Map();
  let won = 0, lost = 0, open = 0, wonValue = 0, openValue = 0, lostValue = 0;

  for (const lead of leads) {
    const stage = stageMap.get(lead.stageId) || {};
    const value = typeof lead.value === "number" && Number.isFinite(lead.value) ? lead.value : 0;
    const currency = /^[A-Z]{3}$/.test(String(lead.currency || "INR").toUpperCase()) ? String(lead.currency || "INR").toUpperCase() : "INR";
    const isWon = stage.isWon === true;
    const isLost = stage.isLost === true;
    const currencyRow = byCurrency.get(currency) || { currency, total: 0, won: 0, lost: 0, open: 0, wonValue: 0, lostValue: 0, openValue: 0 };
    currencyRow.total += 1;
    if (isWon) { won += 1; currencyRow.won += 1; currencyRow.wonValue += value; if (currency === "INR") wonValue += value; }
    else if (isLost) { lost += 1; currencyRow.lost += 1; currencyRow.lostValue += value; if (currency === "INR") lostValue += value; }
    else { open += 1; currencyRow.open += 1; currencyRow.openValue += value; if (currency === "INR") openValue += value; }
    byCurrency.set(currency, currencyRow);

    const stageId = String(lead.stageId || "unknown");
    const stageRow = byStage.get(stageId) || { id: stageId, name: String(stage.name || lead.stageName || stageId), total: 0, value: 0, won: 0, lost: 0, open: 0 };
    stageRow.total += 1; if (currency === "INR") stageRow.value += value;
    if (isWon) stageRow.won += 1;
    else if (isLost) stageRow.lost += 1;
    else stageRow.open += 1;
    byStage.set(stageId, stageRow);

    const ownerUid = String(lead.ownerUid || "unassigned");
    const owner = memberMap.get(ownerUid);
    const ownerRow = byOwner.get(ownerUid) || {
      uid: ownerUid,
      name: ownerUid === "unassigned" ? "Unassigned" : String(owner?.displayName || owner?.name || owner?.email || "Workspace member"),
      total: 0, value: 0, won: 0, lost: 0, open: 0, wonValue: 0
    };
    ownerRow.total += 1; if (currency === "INR") ownerRow.value += value;
    if (isWon) { ownerRow.won += 1; if (currency === "INR") ownerRow.wonValue += value; }
    else if (isLost) ownerRow.lost += 1;
    else ownerRow.open += 1;
    byOwner.set(ownerUid, ownerRow);

    const source = String(lead.source || "Unknown");
    const sourceRow = bySource.get(source) || { source, total: 0, value: 0, won: 0 };
    sourceRow.total += 1; if (currency === "INR") sourceRow.value += value; if (isWon) sourceRow.won += 1;
    bySource.set(source, sourceRow);
  }

  const closed = won + lost;
  return {
    generatedAt: generatedAt.toISOString(),
    limited,
    total: leads.length,
    won, lost, open,
    wonValue, openValue, lostValue,
    conversionRate: closed ? Math.round((won / closed) * 1000) / 10 : 0,
    byStage: [...byStage.values()].sort((a, b) => a.name.localeCompare(b.name)),
    byOwner: [...byOwner.values()].sort((a, b) => b.wonValue - a.wonValue || b.total - a.total).slice(0, 20),
    bySource: [...bySource.values()].sort((a, b) => b.total - a.total).slice(0, 20),
    byCurrency: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency))
  };
}

async function buildCrmSalesReport(db, organization, actorUid, now = new Date()) {
  let query = organization.ref.collection("crmLeads").orderBy("updatedAt", "desc");
  if (organization.role === "agent") query = organization.ref.collection("crmLeads")
    .where("ownerUid", "==", actorUid).orderBy("updatedAt", "desc");
  const [leadSnapshot, stageSnapshot, memberSnapshot] = await Promise.all([
    query.limit(REPORT_LIMIT).get(),
    organization.ref.collection("crmStages").get(),
    organization.ref.collection("members").get()
  ]);
  const leads = leadSnapshot.docs.map(document => ({ id: document.id, ...document.data() }));
  const stages = stageSnapshot.docs.map(document => ({ id: document.id, ...document.data() }));
  const members = memberSnapshot.docs.map(document => ({ uid: document.id, ...document.data() }));
  return aggregateCrmSalesReport(leads, stages, members, leadSnapshot.docs.length === REPORT_LIMIT, now);
}

module.exports = { REPORT_LIMIT, aggregateCrmSalesReport, buildCrmSalesReport };
