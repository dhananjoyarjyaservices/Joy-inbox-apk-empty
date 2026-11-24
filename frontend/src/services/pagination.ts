export async function collectCursorPages<T>(
  loadPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await loadPage(cursor);
    items.push(...page.items);
    const nextCursor = page.nextCursor || undefined;
    if (nextCursor && (nextCursor === cursor || seenCursors.has(nextCursor))) {
      throw new Error("Pagination returned a repeated cursor. Refresh and try again.");
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return items;
}
