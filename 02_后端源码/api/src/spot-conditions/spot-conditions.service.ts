import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AppException } from '../common/errors';
import { FEEDBACK_KINDS, FEEDBACK_LABELS, type FeedbackKind } from './spot-conditions.dto';

export const FEEDBACK_WINDOW_DAYS = 30;
export interface FeedbackItem {
  id: string;
  kind: FeedbackKind;
  label: string;
  updatedAt: string;
  isMine: boolean;
}
interface FeedbackRow { id: string; user_id: string; kind: FeedbackKind; updated_at: Date }
interface FeedbackCursor { v: 1; spotId: string; at: string; id: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseFeedbackLimit(raw?: string): number {
  if (raw === undefined) return 5;
  if (typeof raw !== 'string' || !/^(?:[1-9]|1[0-9]|20)$/.test(raw)) {
    throw AppException.badRequest('limit 必须是 1 到 20 的整数');
  }
  return Number(raw);
}

export function parseFeedbackCursor(raw: string | undefined, spotId: string): FeedbackCursor | null {
  if (raw === undefined) return null;
  try {
    if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as FeedbackCursor;
    if (!value || value.v !== 1 || value.spotId !== spotId || typeof value.id !== 'string' || !UUID.test(value.id)
      || typeof value.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.at)
      || !Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at) throw new Error();
    return value;
  } catch {
    throw AppException.badRequest('反馈分页参数无效，请刷新后重试');
  }
}

function present(row: FeedbackRow, userId?: string): FeedbackItem {
  return { id: row.id, kind: row.kind, label: FEEDBACK_LABELS[row.kind], updatedAt: row.updated_at.toISOString(), isMine: row.user_id === userId };
}

@Injectable()
export class SpotConditionsService {
  constructor(private readonly db: DatabaseService) {}

  private async requirePublic(client: PoolClient, spotId: string) {
    // 在同一事务中持有共享行锁：反馈请求进行期间不会被并发隐藏/删除。
    const result = await client.query("SELECT id FROM spots WHERE id=$1 AND status='active' FOR SHARE", [spotId]);
    if (!result.rows.length) throw AppException.notFound('机位不存在或暂不可用');
  }

  async list(spotId: string, userId?: string, cursorRaw?: string, limitRaw?: string) {
    const limit = parseFeedbackLimit(limitRaw);
    const cursor = parseFeedbackCursor(cursorRaw, spotId);
    const cutoff = new Date(Date.now() - FEEDBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return this.db.withTransaction(async client => {
      await this.requirePublic(client, spotId);
      const params: unknown[] = [spotId, cutoff];
      let cursorClause = '';
      if (cursor) {
        params.push(cursor.at, cursor.id);
        cursorClause = ' AND (updated_at, id) < ($3::timestamptz, $4::uuid)';
      }
      params.push(limit + 1);
      const result = await client.query<FeedbackRow>(
        `SELECT id,user_id,kind,updated_at FROM spot_conditions
         WHERE spot_id=$1 AND updated_at >= $2${cursorClause}
         ORDER BY updated_at DESC,id DESC LIMIT $${params.length}`, params);
      const rows = result.rows.slice(0, limit);
      const tail = rows[rows.length - 1];
      const nextCursor = result.rows.length > limit && tail
        ? Buffer.from(JSON.stringify({ v: 1, spotId, at: tail.updated_at.toISOString(), id: tail.id } satisfies FeedbackCursor)).toString('base64url')
        : null;
      const mine = userId ? (await client.query<FeedbackRow>(
        'SELECT id,user_id,kind,updated_at FROM spot_conditions WHERE spot_id=$1 AND user_id=$2 AND updated_at >= $3',
        [spotId, userId, cutoff])).rows[0] : undefined;
      return { items: rows.map(row => present(row, userId)), nextCursor, myFeedback: mine ? present(mine, userId) : null, windowDays: FEEDBACK_WINDOW_DAYS };
    });
  }

  async put(spotId: string, userId: string, kind: FeedbackKind) {
    if (!FEEDBACK_KINDS.includes(kind)) throw AppException.badRequest('请选择有效的机位反馈类型');
    return this.db.withTransaction(async client => {
      await this.requirePublic(client, spotId);
      const result = await client.query<FeedbackRow>(
        `INSERT INTO spot_conditions (spot_id,user_id,kind) VALUES ($1,$2,$3)
         ON CONFLICT (user_id,spot_id) DO UPDATE SET kind=EXCLUDED.kind,updated_at=clock_timestamp()
         RETURNING id,user_id,kind,updated_at`, [spotId, userId, kind]);
      return { feedback: present(result.rows[0], userId) };
    });
  }

  async remove(spotId: string, userId: string) {
    return this.db.withTransaction(async client => {
      await this.requirePublic(client, spotId);
      await client.query('DELETE FROM spot_conditions WHERE spot_id=$1 AND user_id=$2', [spotId, userId]);
      return { removed: true };
    });
  }
}

