import { loadConfig } from '../config/configuration';
import { AppException } from '../common/errors';
import type { DatabaseService } from '../database/database.service';
import { ModerationService, REPORT_HIDE_THRESHOLD } from './moderation.service';

const SPOT_ID = '33333333-3333-4333-8333-000000000001';
const AUTHOR_ID = 'user-author';
const REPORTER_ID = 'user-reporter';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function build(options: { spot?: { id: string; user_id: string; status: string } | null; insertReturnsRow?: boolean; reporterCount?: number } = {}) {
  const calls: QueryCall[] = [];
  const updates: string[] = [];

  const db = {
    queryOne: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM spots WHERE id = $1')) {
        return options.spot === undefined
          ? { id: SPOT_ID, user_id: AUTHOR_ID, status: 'active' }
          : options.spot;
      }
      if (sql.includes('count(DISTINCT reporter_id)')) {
        return { n: options.reporterCount ?? 1 };
      }
      return null;
    }),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      updates.push(sql);
      if (sql.includes('INSERT INTO spot_reports')) {
        const ok = options.insertReturnsRow ?? true;
        return { rows: ok ? [{ id: 'report-1' }] : [], rowCount: ok ? 1 : 0 };
      }
      if (sql.includes('UPDATE spot_reports')) {
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes('UPDATE spots SET status')) {
        // 机位不存在时（options.spot === null）让更新影响 0 行，触发 404 分支
        return { rows: [], rowCount: options.spot === null ? 0 : 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };

  const service = new ModerationService(db as unknown as DatabaseService);
  return { service, db, calls, updates };
}

describe('ModerationService', () => {
  describe('reportSpot', () => {
    it('不能举报自己的机位', async () => {
      const { service } = build();
      await expect(
        service.reportSpot({ spotId: SPOT_ID, reporterId: AUTHOR_ID, reason: '其他' }),
      ).rejects.toThrow(AppException);
    });

    it('机位不存在或已删除时报 404', async () => {
      const { service } = build({ spot: null });
      await expect(
        service.reportSpot({ spotId: SPOT_ID, reporterId: REPORTER_ID, reason: '其他' }),
      ).rejects.toThrow('不存在');
    });

    it('同一个人重复举报会被拒绝（唯一约束兜底）', async () => {
      const { service } = build({ insertReturnsRow: false });
      await expect(
        service.reportSpot({ spotId: SPOT_ID, reporterId: REPORTER_ID, reason: '其他' }),
      ).rejects.toThrow('你已经举报过这个机位了');
    });

    it('举报数未达阈值时不下线', async () => {
      const { service, updates } = build({ reporterCount: REPORT_HIDE_THRESHOLD - 1 });
      const result = await service.reportSpot({
        spotId: SPOT_ID,
        reporterId: REPORTER_ID,
        reason: '违法违规内容',
      });
      expect(result).toEqual({ reported: true, hidden: false });
      expect(updates.some((sql) => sql.includes('UPDATE spots SET status'))).toBe(false);
    });

    it('达到阈值的不同用户举报后自动下线', async () => {
      const { service, updates } = build({ reporterCount: REPORT_HIDE_THRESHOLD });
      const result = await service.reportSpot({
        spotId: SPOT_ID,
        reporterId: REPORTER_ID,
        reason: '地点敏感或危险',
      });
      expect(result.hidden).toBe(true);
      const hide = updates.find((sql) => sql.includes('UPDATE spots SET status'));
      expect(hide).toBeDefined();
    });
  });

  describe('运营操作', () => {
    it('恢复机位状态', async () => {
      const { service, calls } = build();
      await service.setStatus(SPOT_ID, 'active');
      const update = calls.find((c) => c.sql.includes('UPDATE spots SET status'));
      expect(update?.params).toEqual([SPOT_ID, 'active']);
    });

    it('机位不存在时报 404', async () => {
      const { service } = build({ spot: null });
      await expect(service.setStatus(SPOT_ID, 'hidden')).rejects.toThrow('机位不存在');
    });

    it('批量结掉待处理举报', async () => {
      const { service } = build();
      await expect(service.resolveReports(SPOT_ID, 'resolved')).resolves.toBe(2);
    });
  });
});
