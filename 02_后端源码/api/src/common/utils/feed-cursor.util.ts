import { AppException } from '../errors';
import { encodeCursor } from './cursor.util';

export type FeedSort = 'latest' | 'favorites';
export interface FeedCursor { createdAt: string; id: string; favoriteCount?: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(value)) return false;
  const parsed = new Date(value);
  // Validate the calendar without discarding PostgreSQL's extra microseconds.
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

/** Search cursors are deliberately not accepted by the chronological feed, or vice versa. */
export function decodeFeedCursor(raw: string | undefined, sort: FeedSort): FeedCursor | null {
  if (raw === undefined || raw === '') return null;
  try {
    if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    // Buffer's permissive decoder must not silently accept a malformed token.
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== raw) throw new Error();
    let value: FeedCursor;
    if (sort === 'favorites') {
      const cursor = JSON.parse(decoded);
      if (!cursor || cursor.v !== 1 || cursor.mode !== 'search-favorites'
        || !Number.isSafeInteger(cursor.favoriteCount) || cursor.favoriteCount < 0) throw new Error();
      value = { createdAt: cursor.createdAt, id: cursor.id, favoriteCount: cursor.favoriteCount };
    } else {
      const fields = decoded.split('|');
      if (fields.length !== 2) throw new Error();
      value = { createdAt: fields[0], id: fields[1] };
    }
    if (!validTimestamp(value.createdAt) || typeof value.id !== 'string' || !UUID.test(value.id)) throw new Error();
    return value;
  } catch {
    throw AppException.badRequest('分页游标无效或排序模式已变化，请刷新列表');
  }
}

export function encodeFeedCursor(value: FeedCursor, sort: FeedSort): string {
  if (sort === 'latest') return encodeCursor(value);
  return Buffer.from(JSON.stringify({ v: 1, mode: 'search-favorites', favoriteCount: value.favoriteCount,
    createdAt: value.createdAt, id: value.id }), 'utf8').toString('base64url');
}
