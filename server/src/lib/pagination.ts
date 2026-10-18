import { invalid } from './errors.js';

/** Opaque keyset cursor: base64url(JSON [sortValue, id]). */
export function encodeCursor(sortValue: unknown, id: string): string {
  return Buffer.from(JSON.stringify([sortValue, id])).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): [unknown, string] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[1] === 'string') return [v[0], v[1]];
  } catch {
    /* fall through */
  }
  throw invalid('cursor: malformed pagination cursor');
}

/** Given limit+1 rows, split into a page and the cursor for the next one. */
export function pageOf<T extends { id: string }>(rows: T[], limit: number, sortKey: (row: T) => unknown) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, nextCursor: hasMore && last ? encodeCursor(sortKey(last), last.id) : null };
}
