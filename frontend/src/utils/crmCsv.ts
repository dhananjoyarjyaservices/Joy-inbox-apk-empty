export type CrmCsvField = { key: string; type: "text" | "number" | "date" | "boolean" | "select"; active: boolean };
export type CrmCsvLead = {
  title: string;
  stageId: string;
  contactId: string;
  ownerUid: string;
  source: string;
  value: number | string | null;
  currency: string;
  nextFollowUpAt: string | null;
  notes: string;
  customFields: Record<string, string | number | boolean>;
};

export function parseCrmCsv(source: string, fields: CrmCsvField[] = []): CrmCsvLead[] {
  const input = source.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"' && quoted && input[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some(value => value.trim())) rows.push(row);
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  if (rows.length < 2) throw new Error("CSV must contain a header and at least one lead row.");

  const headers = rows[0].map(value => value.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  if (!headers.includes("title")) throw new Error('CSV needs a "title" column.');
  if (new Set(headers).size !== headers.length) throw new Error("CSV contains duplicate column headers.");
  if (rows.slice(1).some(values => values.length > headers.length)) {
    throw new Error("CSV contains a row with more values than the header columns.");
  }
  if (rows.length - 1 > 200) throw new Error("Import no more than 200 leads per CSV upload.");

  return rows.slice(1).map(values => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => { record[header] = values[index] || ""; });
    const customFields = Object.fromEntries(fields
      .filter(field => field.active)
      .flatMap((field): [string, string | number | boolean][] => {
        const raw = record[field.key] ?? record[`custom_${field.key}`] ?? "";
        if (raw === "") return [];
        if (field.type === "number") {
          const parsed = Number(raw);
          return [[field.key, Number.isFinite(parsed) ? parsed : raw]];
        }
        if (field.type === "boolean") {
          const normalized = raw.trim().toLowerCase();
          const parsed = normalized === "true" || normalized === "yes" || normalized === "1"
            ? true
            : normalized === "false" || normalized === "no" || normalized === "0"
              ? false
              : raw;
          return [[field.key, parsed]];
        }
        return [[field.key, raw]];
      })) as Record<string, string | number | boolean>;
    return {
      title: record.title || "",
      stageId: record.stage_id || "new",
      contactId: record.contact_id || "",
      ownerUid: record.owner_uid || "",
      source: record.source || "",
      value: record.value ? (Number.isFinite(Number(record.value)) ? Number(record.value) : record.value) : null,
      currency: record.currency || "INR",
      nextFollowUpAt: record.next_follow_up_at || null,
      notes: record.notes || "",
      customFields
    };
  });
}
