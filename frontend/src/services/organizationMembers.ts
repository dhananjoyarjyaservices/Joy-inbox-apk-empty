import { auth } from "../firebase/config";

const API_URL = import.meta.env.VITE_API_BASE_URL;

async function request(path: string, method = "GET", body?: unknown) {
  if (!API_URL) throw new Error("API URL is not configured.");
  const user = auth.currentUser;
  if (!user) throw new Error("Please sign in again.");
  const token = await user.getIdToken();
  const response = await fetch(`${API_URL.replace(/\/$/, "")}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Member request failed.");
  return result;
}

export interface OrganizationMember {
  uid: string;
  email: string;
  displayName: string;
  role: "owner" | "admin" | "agent";
  status: "active" | "removed" | "disabled";
  joinedAt?: unknown;
}

export interface OrganizationMemberPage {
  members: OrganizationMember[];
  nextCursor: string | null;
}

export async function listOrganizationMembers(
  organizationId: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<OrganizationMemberPage> {
  const params = new URLSearchParams({ organizationId, limit: String(options.limit ?? 25) });
  if (options.cursor) params.set("cursor", options.cursor);
  const result = await request(`/organizations/members?${params.toString()}`);
  return {
    members: Array.isArray(result.members) ? result.members : [],
    nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null
  };
}
export async function listAllOrganizationMembers(organizationId: string): Promise<OrganizationMember[]> {
  const members: OrganizationMember[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listOrganizationMembers(organizationId, { limit: 100, ...(cursor ? { cursor } : {}) });
    members.push(...page.members);
    const nextCursor = page.nextCursor || undefined;
    if (nextCursor && (nextCursor === cursor || seenCursors.has(nextCursor))) {
      throw new Error("Member pagination returned a repeated cursor. Refresh the workspace and try again.");
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return members;
}

export async function addOrganizationMember(organizationId: string, email: string, role: "admin" | "agent") {
  return request("/organizations/members", "POST", { organizationId, email, role });
}
export async function updateOrganizationMemberRole(organizationId: string, uid: string, role: "admin" | "agent") {
  return request("/organizations/members", "PUT", { organizationId, uid, role });
}
export async function removeOrganizationMember(organizationId: string, uid: string) {
  return request("/organizations/members", "DELETE", { organizationId, uid });
}


export interface OrganizationMemberAuditEvent {
  id: string;
  action: string;
  actorUid: string;
  actorEmail: string;
  actorRole: string;
  targetUid: string;
  targetEmail: string;
  details: Record<string, unknown>;
  createdAt?: unknown;
}

export interface OrganizationMemberAuditPage {
  events: OrganizationMemberAuditEvent[];
  nextCursor: string | null;
}

export async function listOrganizationMemberAudit(
  organizationId: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<OrganizationMemberAuditPage> {
  const params = new URLSearchParams({ organizationId, limit: String(options.limit ?? 25) });
  if (options.cursor) params.set("cursor", options.cursor);
  const result = await request(`/organizations/member-audit?${params.toString()}`);
  return {
    events: Array.isArray(result.events) ? result.events : [],
    nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null
  };
}

export async function updateOrganizationChatAssignment(
  organizationId: string,
  input: { chatId: string; assignedTo?: string | null; status?: "open" | "pending" | "resolved" }
) {
  return request("/organizations/chat-assignment", "POST", { organizationId, ...input });
}

export interface ChatAssignmentAuditEvent {
  id: string;
  action: "chat.assigned" | "chat.status_changed";
  actorUid: string;
  actorEmail: string;
  actorRole: string;
  targetUid?: string;
  targetEmail?: string;
  details: { chatId?: string; assignedTo?: string | null; status?: "open" | "pending" | "resolved" };
  createdAt?: unknown;
}

export async function listChatAssignmentAudit(organizationId: string, chatId: string): Promise<ChatAssignmentAuditEvent[]> {
  const params = new URLSearchParams({ organizationId, chatId });
  const result = await request(`/organizations/chat-assignment-audit?${params.toString()}`);
  return Array.isArray(result.events) ? result.events as ChatAssignmentAuditEvent[] : [];
}


export interface HistoricalAgentPerformance {
  uid: string;
  email: string;
  assignedCount: number;
  resolvedCount: number;
  responseCount?: number;
  averageResponseMs?: number | null;
  slaMetCount?: number;
  slaBreachCount?: number;
  slaMetPercent?: number | null;
  lastActivityAt?: unknown;
}

export interface HistoricalAgentPerformanceResult {
  days: number;
  since: string;
  agents: HistoricalAgentPerformance[];
}

export async function listHistoricalAgentPerformance(
  organizationId: string,
  days: 7 | 30 | 90 = 30
): Promise<HistoricalAgentPerformanceResult> {
  const params = new URLSearchParams({ organizationId, days: String(days) });
  const result = await request(`/organizations/agent-performance?${params.toString()}`);
  return {
    days: result.days === 7 || result.days === 90 ? result.days : 30,
    since: typeof result.since === "string" ? result.since : "",
    agents: Array.isArray(result.agents) ? result.agents as HistoricalAgentPerformance[] : []
  };
}
