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

export async function listOrganizationMembers(organizationId: string): Promise<OrganizationMember[]> {
  const result = await request(`/organizations/members?organizationId=${encodeURIComponent(organizationId)}`);
  return Array.isArray(result.members) ? result.members : [];
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
