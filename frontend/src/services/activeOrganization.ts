const STORAGE_KEY = "joy-inbox-active-organization";

export function getActiveOrganizationId(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(STORAGE_KEY) || "";
}

export function setActiveOrganizationId(organizationId: string): void {
  if (typeof window === "undefined") return;
  const value = organizationId.trim();
  if (!value) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Organization ID is invalid.");
  }
  window.localStorage.setItem(STORAGE_KEY, value);
}

export function clearActiveOrganizationId(): void {
  if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
}
