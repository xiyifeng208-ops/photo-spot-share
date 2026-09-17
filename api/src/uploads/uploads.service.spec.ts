import { loadConfig } from '../config/configuration';
import { LocalStorageDriver } from '../storage/local-storage.driver';
import { StorageService } from '../storage/storage.service';
import type { DatabaseService } from '../database/database.service';
import { UploadsService } from './uploads.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function buildService(tickets: Record<string, { user_id: string; spot_id: string | null }> = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];

  const db = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const ticket = tickets[String(params[0])];
      if (!ticket) return null;
      return { id: 'ticket-1', object_key: String(params[0]), ...ticket };
    }),
    withTransaction: jest.fn(async (handler: (client: unknown) => Promise<unknown>) => {
      const client = {
        query: jest.fn(async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          return { rows: [], rowCount: 0 };
        }),
      };
      return handler(client);
    }),
  };

  const storage = new StorageService(
    loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:3000',
      STORAGE_DRIVER: 'local',
    } as NodeJS.ProcessEnv),
  );

  const service = new UploadsService(
    loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    db as unknown as DatabaseService,
    storage,
  );

  return { service, db, storage, queries };
}

describe('UploadsService', () => {
  describe('signUploads', () => {
    it('签发的 key 落在当前用户目录下', async () => {
      const { service, queries } = buildService();
      const signed = await service.signUploads(USER_ID, [{ mime: 'image/jpeg' }]);

      expect(signed.driver).toBe('local');
      expect(signed.keys).toHaveLength(1);
      expect(signed.keys[0]).toMatch(new RegExp(`^uploads/${USER_ID}/\\d{8}/[a-f0-9]+\\.jpg$`));
      expect(signed.urls[signed.keys[0]]).toContain('/static/uploads/');

      const insert = queries.find((query) => query.sql.includes('INSERT INTO upload_tickets'));
      expect(insert?.params[0]).toBe(USER_ID);
      expect(insert?.params[1]).toBe(signed.keys[0]);
    });

    it('超过 9 张直接拒绝', async () => {
      const { service } = buildService();
      const items = Array.from({ length: 10 }, () => ({ mime: 'image/jpeg' }));
      await expect(service.signUploads(USER_ID, items)).rejects.toThrow('最多 9 张');
    });

    it('不支持的图片类型被拒绝', async () => {
      const { service } = buildService();
      await expect(service.signUploads(USER_ID, [{ mime: 'image/gif' }])).rejects.toThrow(
        '不支持的图片类型',
      );
    });

    it('单张超过 10MB 被拒绝', async () => {
      const { service } = buildService();
      await expect(
        service.signUploads(USER_ID, [{ mime: 'image/jpeg', size: 11 * 1024 * 1024 }]),
      ).rejects.toThrow('不能超过 10MB');
    });
  });

  describe('recordLocalUpload', () => {
    const key = `uploads/${USER_ID}/20260914/a.jpg`;

    it('没有票据时拒绝写入（防止被当成免费图床）', async () => {
      const { service } = buildService();
      await expect(
        service.recordLocalUpload({ userId: USER_ID, key, buffer: Buffer.from('x') }),
      ).rejects.toThrow('请先申请上传凭证');
    });

    it('key 不属于当前用户时拒绝', async () => {
      const { service } = buildService();
      await expect(
        service.recordLocalUpload({
          userId: USER_ID,
          key: 'uploads/other-user/a.jpg',
          buffer: Buffer.from('x'),
        }),
      ).rejects.toThrow('不属于当前用户');
    });

    it('票据有效时落盘并返回可访问地址', async () => {
      const { service, storage } = buildService({ [key]: { user_id: USER_ID, spot_id: null } });
      const saveSpy = jest
        .spyOn(storage.driver as LocalStorageDriver, 'saveObject')
        .mockResolvedValue(undefined);

      const result = await service.recordLocalUpload({
        userId: USER_ID,
        key,
        buffer: Buffer.from('fake-image'),
      });

      expect(saveSpy).toHaveBeenCalledWith(key, expect.any(Buffer));
      expect(result.url).toBe(`http://localhost:3000/static/${key}`);
      expect(result.size).toBe('fake-image'.length);
    });
  });

  describe('assertUsableKeys', () => {
    it('空数组直接通过', async () => {
      const { service } = buildService();
      await expect(service.assertUsableKeys(USER_ID, [])).resolves.toBeUndefined();
    });

    it('图片归属他人时拒绝', async () => {
      const { service } = buildService();
      await expect(
        service.assertUsableKeys(USER_ID, ['uploads/other-user/20260914/a.jpg']),
      ).rejects.toThrow('图片归属校验失败');
    });

    it('存在重复图片时拒绝', async () => {
      const { service } = buildService();
      const key = `uploads/${USER_ID}/20260914/a.jpg`;
      await expect(service.assertUsableKeys(USER_ID, [key, key])).rejects.toThrow('存在重复图片');
    });
  });

  describe('cleanupOrphans', () => {
    it('删除超过 24 小时未使用的图片与票据', async () => {
      const { service, db, storage } = buildService();
      db.query = jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT id, object_key')) {
          return { rows: [{ id: 't1', object_key: 'uploads/u/20260914/a.jpg' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }) as never;
      const deleteSpy = jest
        .spyOn(storage.driver as LocalStorageDriver, 'deleteObject')
        .mockResolvedValue(undefined);

      const result = await service.cleanupOrphans();

      expect(deleteSpy).toHaveBeenCalledWith('uploads/u/20260914/a.jpg');
      expect(result.removed).toBe(1);
    });
  });
});
