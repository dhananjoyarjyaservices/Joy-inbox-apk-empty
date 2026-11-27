"use strict";

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireManager(actor) {
  if (!actor || !["owner", "admin"].includes(actor.role)) {
    throw httpError("Only organization owners and admins can manage members.", 403);
  }
}

function createDynamoMemberManagement({ organizationStore, getSeatLimit, recordAudit }) {
  if (!organizationStore ||
      !["addMember", "updateMemberRole", "removeMember", "listMembers"].every(name => typeof organizationStore[name] === "function")) {
    throw new Error("A complete DynamoDB organization store is required.");
  }
  if (typeof getSeatLimit !== "function") throw new Error("A verified subscription seat-limit resolver is required.");
  if (typeof recordAudit !== "function") throw new Error("A DynamoDB member audit writer is required.");

  async function audit(organizationId, actor, action, targetUid, details = {}) {
    await recordAudit({
      organizationId,
      actorUid: actor.uid,
      actorRole: actor.role,
      action,
      targetUid,
      details,
      createdAt: new Date().toISOString()
    });
  }

  async function addMember({ organizationId, actor, uid, role = "agent" }) {
    requireManager(actor);
    if (typeof actor.uid !== "string" || !actor.uid || typeof uid !== "string" || !uid) {
      throw httpError("Actor and member IDs are required.", 400);
    }
    if (role === "admin" && actor.role !== "owner") {
      throw httpError("Only the organization owner can add an admin.", 403);
    }
    if (!["admin", "agent"].includes(role)) throw httpError("Only admin or agent roles can be assigned.", 400);
    const seatLimit = await getSeatLimit(organizationId);
    const member = await organizationStore.addMember({ organizationId, uid, role, seatLimit });
    await audit(organizationId, actor, "member.added", uid, { role });
    return member;
  }

  async function updateMemberRole({ organizationId, actor, uid, role }) {
    requireManager(actor);
    if (typeof actor.uid !== "string" || !actor.uid) throw httpError("Actor identity is required.", 401);
    if (role === "admin" && actor.role !== "owner") throw httpError("Only the organization owner can assign admin.", 403);
    if (!["admin", "agent"].includes(role)) throw httpError("Only admin or agent roles can be assigned.", 400);
    const current = await organizationStore.getMembership(organizationId, uid);
    if (!current || current.status !== "active") throw httpError("Active member was not found.", 404);
    if (current.role === "owner") throw httpError("The organization owner role cannot be changed.", 409);
    if (current.role === "admin" && actor.role !== "owner") throw httpError("Only the organization owner can change another admin's role.", 403);
    const result = await organizationStore.updateMemberRole({ organizationId, uid, role });
    await audit(organizationId, actor, "member.role_changed", uid, { previousRole: current.role, role });
    return result;
  }

  async function removeMember({ organizationId, actor, uid }) {
    requireManager(actor);
    if (typeof actor.uid !== "string" || !actor.uid) throw httpError("Actor identity is required.", 401);
    const current = await organizationStore.getMembership(organizationId, uid);
    if (!current || current.status !== "active") throw httpError("Active member was not found.", 404);
    if (current.role === "owner") throw httpError("The organization owner cannot be removed.", 409);
    if (current.role === "admin" && actor.role !== "owner") throw httpError("Only the organization owner can remove another admin.", 403);
    const result = await organizationStore.removeMember({ organizationId, uid });
    await audit(organizationId, actor, "member.removed", uid, { previousRole: current.role });
    return result;
  }

  async function listMembers({ organizationId, actor, limit, exclusiveStartKey }) {
    requireManager(actor);
    return organizationStore.listMembers(organizationId, { limit, exclusiveStartKey });
  }

  return Object.freeze({ addMember, updateMemberRole, removeMember, listMembers });
}

module.exports = { createDynamoMemberManagement };
