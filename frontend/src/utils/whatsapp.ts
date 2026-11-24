export function getWhatsAppContactUrl(value: string): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  return /^\d{6,20}$/.test(digits) ? `https://wa.me/${digits}` : null;
}
