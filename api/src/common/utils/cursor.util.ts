import { AppException } from '../errors';

export interface DecodedCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(value: DecodedCursor): string {
  return Buffer.from(`${value.createdAt}|${value.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw?: string | null): DecodedCursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) throw new Error('bad cursor');
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!createdAt || !id) throw new Error('bad cursor');
    if (Number.isNaN(new Date(createdAt).getTime())) throw new Error('bad cursor date');
    return { createdAt, id };
  } catch {
    throw AppException.badRequest('分页游标无效');
  }
}

