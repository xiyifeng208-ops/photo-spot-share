import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/errors';
import { DatabaseService } from '../database/database.service';

/** 达到这个数量的不同用户举报，机位自动下线待人工复核。 */
export const REPORT_HIDE_THRESHOLD = 3;

export const REPORT_REASONS = [
  '违法违规内容',
  '侵犯他人权益',
  '虚假或误导信息',
  '地点敏感或危险',
  '其他',
] as const;

export interface ReportRow {
  id: string;
  spot_id: string;
  reporter_id: string;
  reason: string;
  detail: string | null;
  status: string;
  created_at: Date;
}

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(private readonly db: DatabaseService) {}

  /** 提交举报：同一用户对同一机位只能报一次；达到阈值自动下线。 */
  async reportSpot(params: {
    spotId: string;
    reporterId: string;
    reason: string;
    detail?: string;
  }): Promise<{ reported: true; hidden: boolean }> {
    const spot = await this.db.queryOne<{ id: string; user_id: string; status: string }>(
      'SELECT id, user_id, status FROM spots WHERE id = $1',
      [params.spotId],
    );
    if (!spot || spot.status === 'deleted') {
      throw AppException.notFound('该打卡点不存在或已被删除');
    }
    if (spot.user_id === params.reporterId) {
      throw AppException.badRequest('不能举报自己发布的机位');
    }

    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO spot_reports (spot_id, reporter_id, reason, detail)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ON CONSTRAINT spot_reports_once DO NOTHING
       RETURNING id`,
      [params.spotId, params.reporterId, params.reason, params.detail ?? null],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      throw AppException.badRequest('你已经举报过这个机位了');
    }

    const count = await this.db.queryOne<{ n: number }>(
      'SELECT count(DISTINCT reporter_id)::int AS n FROM spot_reports WHERE spot_id = $1',
      [params.spotId],
    );
    const hidden = (count?.n ?? 0) >= REPORT_HIDE_THRESHOLD;
    if (hidden && spot.status === 'active') {
      await this.setStatus(params.spotId, 'hidden');
      this.logger.warn(`机位 ${params.spotId} 被 ${count?.n} 个用户举报，已自动下线`);
    }

    return { reported: true, hidden };
  }

  /** 运营：查看举报（默认只看待处理的） */
  async listReports(status = 'open', limit = 100): Promise<ReportRow[]> {
    const { rows } = await this.db.query<ReportRow>(
      `SELECT r.id, r.spot_id, r.reporter_id, r.reason, r.detail, r.status, r.created_at
         FROM spot_reports r
        WHERE ($1 = 'all' OR r.status = $1)
        ORDER BY r.created_at DESC
        LIMIT $2`,
      [status, Math.min(limit, 500)],
    );
    return rows;
  }

  /** 运营：改机位状态（恢复被误伤的、或手动下线） */
  async setStatus(spotId: string, status: 'active' | 'hidden' | 'deleted'): Promise<void> {
    const updated = await this.db.query(
      'UPDATE spots SET status = $2, updated_at = now() WHERE id = $1 AND status <> $2',
      [spotId, status],
    );
    if ((updated.rowCount ?? 0) === 0) {
      const exists = await this.db.queryOne<{ id: string }>(
        'SELECT id FROM spots WHERE id = $1',
        [spotId],
      );
      if (!exists) throw AppException.notFound('机位不存在');
    }
    this.logger.log(`运营操作：机位 ${spotId} → ${status}`);
  }

  /** 运营：把某个机位的待处理举报批量结掉 */
  async resolveReports(spotId: string, status: 'resolved' | 'rejected'): Promise<number> {
    const result = await this.db.query(
      `UPDATE spot_reports SET status = $2 WHERE spot_id = $1 AND status = 'open'`,
      [spotId, status],
    );
    return result.rowCount ?? 0;
  }
}

