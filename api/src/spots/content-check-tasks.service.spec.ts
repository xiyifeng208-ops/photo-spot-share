import { loadConfig } from '../config/configuration';
import type { DatabaseService } from '../database/database.service';
import type { StorageService } from '../storage/storage.service';
import { ContentCheckService } from './content-check.service';
import { ContentCheckTasksService } from './content-check-tasks.service';

const SPOT_ID = '44444444-4444-4444-8444-000000000001';

interface Task {
  id: string;
  spot_id: string;
  trace_id: string;
  status: 'pending' | 'pass' | 'risky' | 'failed';
}

function build(options: { mediaCheckReady?: boolean; submitFails?: boolean } = {}) {
  const tasks: Task[] = [];
  const spotUpdates: { spotId: string; status: string }[] = [];

  const db = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO content_check_tasks')) {
        tasks.push({
          id: `task-${tasks.length + 1}`,
          spot_id: String(params[0]),
          trace_id: String(params[1]),
          status: 'pending',
        });
        return { rows: [], rowCount: 1 };
      }
      // 注意：真实 SQL 是跨行写的，匹配时不要带空格拼 "UPDATE ... SET ..."
      if (sql.includes('回调超时')) {
        const pending = tasks.filter((t) => t.status === 'pending');
        pending.forEach((t) => {
          t.status = 'failed';
        });
        return { rows: pending, rowCount: pending.length };
      }
      if (sql.includes('UPDATE content_check_tasks')) {
        const task = tasks.find((t) => t.id === params[0]);
        if (task) task.status = params[1] as Task['status'];
        return { rows: [], rowCount: task ? 1 : 0 };
      }
      if (sql.includes('UPDATE spots SET status')) {
        spotUpdates.push({ spotId: String(params[0]), status: String(params[1]) });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT id, spot_id, trace_id, status FROM content_check_tasks WHERE spot_id')) {
        return { rows: tasks.filter((t) => t.spot_id === params[0]), rowCount: tasks.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('WHERE trace_id = $1')) {
        return tasks.find((t) => t.trace_id === params[0]) ?? null;
      }
      return null;
    }),
  };

  const config = loadConfig({
    NODE_ENV: 'test',
    CONTENT_CHECK_ENABLED: 'true',
    WX_APPID: 'wx-test',
    WX_SECRET: 'secret',
    WX_CALLBACK_TOKEN: 'callback-token',
  } as NodeJS.ProcessEnv);
  const contentCheck = new ContentCheckService(config);
  jest
    .spyOn(contentCheck, 'submitMediaCheck')
    .mockImplementation(async (_openid: string, mediaUrl: string) =>
      options.submitFails ? null : `trace-${mediaUrl.split('/').pop()}`,
    );
  const readySpy = jest
    .spyOn(contentCheck, 'mediaCheckReady', 'get')
    .mockReturnValue(options.mediaCheckReady ?? true);

  const storage = { publicUrl: (key: string) => `https://cdn.example.com/${key}` };
  const service = new ContentCheckTasksService(
    db as unknown as DatabaseService,
    storage as unknown as StorageService,
    contentCheck,
  );

  return { service, tasks, spotUpdates, db, readySpy };
}

describe('ContentCheckTasksService', () => {
  describe('submitForSpot', () => {
    it('图片机审通道不可用时返回 false（机位直接发布）', async () => {
      const { service, tasks } = build({ mediaCheckReady: false });
      const waiting = await service.submitForSpot({
        spotId: SPOT_ID,
        openid: 'dev:u1',
        photoKeys: ['uploads/u/1.jpg'],
      });
      expect(waiting).toBe(false);
      expect(tasks).toHaveLength(0);
    });

    it('每张样张提交一次检测并落一条任务', async () => {
      const { service, tasks } = build();
      const waiting = await service.submitForSpot({
        spotId: SPOT_ID,
        openid: 'dev:u1',
        photoKeys: ['uploads/u/1.jpg', 'uploads/u/2.jpg'],
      });
      expect(waiting).toBe(true);
      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.status === 'pending')).toBe(true);
    });

    it('全部提交失败时返回 false', async () => {
      const { service } = build({ submitFails: true });
      await expect(
        service.submitForSpot({ spotId: SPOT_ID, openid: 'dev:u1', photoKeys: ['uploads/u/1.jpg'] }),
      ).resolves.toBe(false);
    });
  });

  describe('applyVerdict（回调）', () => {
    it('全部图片通过 → 机位转 active', async () => {
      const { service, spotUpdates } = build();
      await service.submitForSpot({ spotId: SPOT_ID, openid: 'u', photoKeys: ['uploads/u/1.jpg'] });
      await service.applyVerdict('trace-1.jpg', 'pass');
      expect(spotUpdates.at(-1)).toEqual({ spotId: SPOT_ID, status: 'active' });
    });

    it('有一张命中风险 → 机位转 hidden', async () => {
      const { service, spotUpdates } = build();
      await service.submitForSpot({
        spotId: SPOT_ID,
        openid: 'u',
        photoKeys: ['uploads/u/1.jpg', 'uploads/u/2.jpg'],
      });
      await service.applyVerdict('trace-1.jpg', 'pass');
      expect(spotUpdates).toHaveLength(0); // 还有一张没回结果，继续 pending
      await service.applyVerdict('trace-2.jpg', 'risky', 20001);
      expect(spotUpdates.at(-1)).toEqual({ spotId: SPOT_ID, status: 'hidden' });
    });

    it('重复回调是幂等的', async () => {
      const { service, spotUpdates } = build();
      await service.submitForSpot({ spotId: SPOT_ID, openid: 'u', photoKeys: ['uploads/u/1.jpg'] });
      await service.applyVerdict('trace-1.jpg', 'pass');
      await service.applyVerdict('trace-1.jpg', 'risky');
      expect(spotUpdates.at(-1)?.status).toBe('active');
    });

    it('未知 trace_id 不影响任何机位', async () => {
      const { service, spotUpdates } = build();
      await service.applyVerdict('trace-unknown', 'risky');
      expect(spotUpdates).toHaveLength(0);
    });
  });

  describe('sweepTimeouts（兜底）', () => {
    it('回调超时的机位转人工确认（hidden）', async () => {
      const { service, spotUpdates } = build();
      await service.submitForSpot({ spotId: SPOT_ID, openid: 'u', photoKeys: ['uploads/u/1.jpg'] });
      const cleared = await service.sweepTimeouts();
      expect(cleared).toBe(1);
      expect(spotUpdates.at(-1)).toEqual({ spotId: SPOT_ID, status: 'hidden' });
    });
  });
});
