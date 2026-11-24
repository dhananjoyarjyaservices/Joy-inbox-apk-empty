import { auth } from "../firebase/config";

const API_URL = import.meta.env.VITE_API_BASE_URL;

export type CrmField = {
  id: string; key: string; label: string; type: "text" | "number" | "date" | "boolean" | "select";
  options: string[]; required: boolean; active: boolean;
};
export type CrmStage = {
  id: string; name: string; position: number; isWon: boolean; isLost: boolean; isDefault: boolean; active: boolean;
};
export type CrmLead = {
  id: string; title: string; contactId: string; stageId: string; stageName: string; ownerUid: string;
  source: string; value: number | null; currency: string; notes: string; nextFollowUpAt: string | null;
  customFields: Record<string, string | number | boolean>; createdAt?: unknown; updatedAt?: unknown;
};

async function request<T>(resource: "fields" | "stages" | "leads" | "leads/import", organizationId: string, method = "GET", data?: unknown, resourceId?: string): Promise<T> {
  if (!API_URL) throw new Error("AWS API URL is not configured.");
  const user = auth.currentUser;
  if (!user) throw new Error("Please sign in again.");
  const token = await user.getIdToken();
  const response = await fetch(`${API_URL.replace(/\/$/, "")}/organizations/crm/${resource}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(method !== "GET" ? { "Content-Type": "application/json" } : {}) },
    ...(method !== "GET" ? { body: JSON.stringify({ organizationId, ...(data !== undefined ? { data } : {}), ...(resourceId ? { resourceId } : {}) }) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "CRM request could not be completed.");
  return result as T;
}

export async function listCrmFields(organizationId: string) {
  return (await request<{ items: CrmField[] }>("fields", organizationId)).items;
}
export async function saveCrmField(organizationId: string, field: Omit<CrmField, "id"> & { id?: string }) {
  const { id, ...data } = field;
  return request<{ item: CrmField }>("fields", organizationId, id ? "PUT" : "POST", data, id).then(result => result.item);
}
export async function listCrmStages(organizationId: string) {
  return (await request<{ items: CrmStage[] }>("stages", organizationId)).items;
}
export async function saveCrmStage(organizationId: string, stage: Omit<CrmStage, "id"> & { id?: string }) {
  const { id, ...data } = stage;
  return request<{ item: CrmStage }>("stages", organizationId, id ? "PUT" : "POST", { ...data, id }, id).then(result => result.item);
}
export async function listCrmLeads(organizationId: string) {
  return (await request<{ items: CrmLead[] }>("leads", organizationId)).items;
}
export async function saveCrmLead(organizationId: string, lead: Omit<CrmLead, "id" | "stageName" | "createdAt" | "updatedAt">, id?: string) {
  return request<{ item: CrmLead }>("leads", organizationId, id ? "PUT" : "POST", lead, id).then(result => result.item);
}
export async function deleteCrmLead(organizationId: string, id: string) {
  await request<{ success: boolean }>("leads", organizationId, "DELETE", undefined, id);
}

export interface CrmLeadImportResult {
  imported: number;
  failed: number;
  errors: Array<{ row: number; error: string }>;
}
export async function importCrmLeads(organizationId: string, rows: Array<Record<string, unknown>>): Promise<CrmLeadImportResult> {
  return request<CrmLeadImportResult>("leads/import", organizationId, "POST", { rows });
}

export interface CrmSalesReport {
  generatedAt: string;
  limited: boolean;
  total: number;
  won: number;
  lost: number;
  open: number;
  wonValue: number;
  openValue: number;
  lostValue: number;
  conversionRate: number;
  byStage: Array<{ id: string; name: string; total: number; value: number; won: number; lost: number; open: number }>;
  byOwner: Array<{ uid: string; name: string; total: number; value: number; won: number; lost: number; open: number; wonValue: number }>;
  bySource: Array<{ source: string; total: number; value: number; won: number }>;
  byCurrency: Array<{ currency: string; total: number; won: number; lost: number; open: number; wonValue: number; lostValue: number; openValue: number }>;
}
export async function getCrmSalesReport(organizationId: string): Promise<CrmSalesReport> {
  const user = auth.currentUser;
  if (!API_URL) throw new Error("AWS API URL is not configured.");
  if (!user) throw new Error("Please sign in again.");
  const token = await user.getIdToken();
  const query = new URLSearchParams({ organizationId });
  const response = await fetch(`${API_URL.replace(/\/$/, "")}/organizations/crm/report?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "CRM sales report could not be loaded.");
  return result.report as CrmSalesReport;
}
