import { loadConfig } from '../config/configuration';
import { AppException } from '../common/errors';
import { StorageService } from '../storage/storage.service';
import type { DatabaseService } from '../database/database.service';
import type { GeoService } from '../geo/geo.service';
import type { UploadsService } from '../uploads/uploads.service';
import { ContentCheckService } from './content-check.service';
import { SpotsService } from './spots.service';

const USER_ID = 'user-1';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function buildHarness(options: {
  queryHandler?: (call: QueryCall) => { rows: unknown[] } | undefined;
  spotOwner?: string;
} = {}) {
  const calls: QueryCall[] = [];

  const db = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const handled = options.queryHandler?.({ sql, params });
      if (handled) return { rows: handled.rows, rowCount: handled.rows.length };
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const handled = options.queryHandler?.({ sql, params });
      if (handled) return handled.rows[0] ?? null;
      return null;
    }),
    withTransaction: jest.fn(async (handler: (client: unknown) => Promise<unknown>) => {
      const client = {
        query: jest.fn(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          const handled = options.queryHandler?.({ sql, params });
          if (handled) return { rows: handled.rows, rowCount: handled.rows.length };
          return { rows: [], rowCount: 0 };
        }),
      };
      return handler(client);
    }),
  };

  const storage = new StorageService(
    loadConfig({ NODE_ENV: 'test', PUBLIC_BASE_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv),
  );

  const uploads = {
    assertUsableKeys: jest.fn(async () => undefined),
  };

  const geo = {
    reverse: jest.fn(async () => ({
      province: '上海市',
      city: '上海市',
      district: '黄浦区',
      address: '中山东一路',
      source: 'amap' as const,
    })),
  };

  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const contentCheck = new ContentCheckService(config);

  // 默认：没有可用的图片机审通道（内容检测关闭），机位直接发布
  const contentCheckTasks = {
    submitForSpot: jest.fn(async () => false),
  };

  const service = new SpotsService(
    db as unknown as DatabaseService,
    storage,
    uploads as unknown as UploadsService,
    geo as unknown as GeoService,
    contentCheck,
    contentCheckTasks as never,
  );

  return { service, db, uploads, geo, calls, config, contentCheckTasks };
}

/** create 现在接收带 openid 的用户对象（文本机审要用真实 openid） */
const asUser = (id: string) => ({ id, openid: `dev:${id}` });

const spotRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'spot-1',
  user_id: USER_ID,
  title: '外滩三件套',
  description: '长焦压角',
  lat: 31.2397,
  lng: 121.4903,
  province: '上海市',
  city: '上海市',
  district: '黄浦区',
  address: '中山东一路',
  heading: 'NE',
  best_times: ['sunset'],
  best_seasons: ['autumn'],
  focal_length: 'tele',
  difficulty: 2,
  access_note: '地铁 2 号线',
  cover_photo_id: null,
  status: 'active',
  view_count: 3,
  created_at: new Date('2026-09-01T10:00:00.000Z'),
  updated_at: new Date('2026-09-01T10:00:00.000Z'),
  nickname: '小艾',
  avatar_url: null,
  cover_key: null,
  ...overrides,
});

describe('SpotsService', () => {
  describe('findInView', () => {
    it('zoom 小于 9 时走城市聚合', async () => {
      const { service } = buildHarness({
        queryHandler: ({ sql }) => {
          if (sql.includes('GROUP BY')) {
            return {
              rows: [
                { city: '上海市', count: 12, lat: 31.23, lng: 121.47 },
                { city: '杭州市', count: 3, lat: 30.25, lng: 120.15 },
              ],
            };
          }
          return undefined;
        },
      });

      const result = await service.findInView({
        bboxRaw: '121,31,122,32',
        zoomRaw: '6',
        limitRaw: '200',
      });

      expect(result.mode).toBe('cluster');
      expect(result.items).toHaveLength(0);
      expect(result.clusters).toHaveLength(2);
      expect(result.clusters[0]).toMatchObject({ city: '上海市', count: 12 });
    });

    it('zoom 大于等于 9 时返回明细点并计算距离', async () => {
      const { service } = buildHarness({
        queryHandler: ({ sql }) => {
          if (sql.includes("s.status = 'active'") && sql.includes('LIMIT $5')) {
            return { rows: [spotRow()] };
          }
          return undefined;
        },
      });

      const result = await service.findInView({
        bboxRaw: '121.4,31.2,121.6,31.4',
        zoomRaw: '15',
        viewer: { lat: 31.2300, lng: 121.4800 },
      });

      expect(result.mode).toBe('points');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].distanceMeters).toBeGreaterThan(0);
      expect(result.items[0].headingLabel).toBe('朝东北');
      expect(result.items[0].bestTimeLabels).toEqual(['日落']);
    });

    it('达到 limit 时返回 truncated 提示前端放大', async () => {
      const rows = Array.from({ length: 3 }, (_, index) => spotRow({ id: `spot-${index}` }));
      const { service } = buildHarness({
        queryHandler: ({ sql }) => (sql.includes('LIMIT $5') ? { rows } : undefined),
      });

      const result = await service.findInView({
        bboxRaw: '121.4,31.2,121.6,31.4',
        zoomRaw: '12',
        limitRaw: '3',
      });

      expect(result.truncated).toBe(true);
    });

    it('非法 bbox 直接报错，不会打到数据库', async () => {
      const { service, db } = buildHarness();
      await expect(service.findInView({ bboxRaw: 'bad' })).rejects.toThrow();
      expect(db.query).not.toHaveBeenCalled();
    });
  });

  describe('findDetail', () => {
    it('已删除的点返回 404', async () => {
      const { service } = buildHarness({
        queryHandler: ({ sql }) =>
          sql.includes('FROM spots s') ? { rows: [spotRow({ status: 'deleted' })] } : undefined,
      });
      await expect(service.findDetail('spot-1')).rejects.toThrow(AppException);
    });

    it('他人的 hidden 点对普通用户不可见', async () => {
      const { service } = buildHarness({
        queryHandler: ({ sql }) =>
          sql.includes('FROM spots s') ? { rows: [spotRow({ status: 'hidden', user_id: 'other' })] } : undefined,
      });
      await expect(service.findDetail('spot-1', USER_ID)).rejects.toThrow('审核中');
    });

    it('作者本人可以看到自己的 hidden 点', async () => {
      const { service } = buildHarness({
        queryHandler: ({ sql }) => {
          if (sql.includes('FROM spots s')) return { rows: [spotRow({ status: 'hidden' })] };
          if (sql.includes('FROM photos')) return { rows: [] };
          return undefined;
        },
      });
      const detail = await service.findDetail('spot-1', USER_ID);
      expect(detail.isMine).toBe(true);
    });

    it('返回完整拍摄参数与图片列表', async () => {
      const { service } = buildHarness({
        queryHandler: ({ sql }) => {
          if (sql.includes('FROM spots s')) return { rows: [spotRow()] };
          if (sql.includes('FROM photos')) {
            return {
              rows: [
                { id: 'p1', object_key: 'uploads/user-1/20260914/a.jpg', width: 1200, height: 900, sort_order: 0 },
              ],
            };
          }
          return undefined;
        },
      });

      const detail = await service.findDetail('spot-1', USER_ID);
      expect(detail.focalLengthLabel).toBe('长焦');
      expect(detail.bestSeasonLabels).toEqual(['秋']);
      expect(detail.difficultyLabel).toBe('需要步行');
      expect(detail.photos[0].url).toContain('/static/uploads/user-1/');
      expect(detail.viewCount).toBe(4);
    });

    // 回归：pg 对自定义枚举数组默认返回字符串 '{sunset,night}'，直接 .map 会 500
    it('枚举数组被驱动返回成字符串时依然能正确映射标签', async () => {
      const { service } = buildHarness({
        queryHandler: ({ sql }) => {
          if (sql.includes('FROM spots s')) {
            return {
              rows: [
                spotRow({
                  best_times: '{sunset,blue_hour}',
                  best_seasons: '{autumn,winter}',
                } as never),
              ],
            };
          }
          if (sql.includes('FROM photos')) return { rows: [] };
          return undefined;
        },
      });

      const detail = await service.findDetail('spot-1', USER_ID);
      expect(detail.bestTimeLabels).toEqual(['日落', '蓝调']);
      expect(detail.bestSeasonLabels).toEqual(['秋', '冬']);
    });

    it('枚举数组为 NULL 或空数组时返回空列表', async () => {
      const { service } = buildHarness({
        queryHandler: ({ sql }) => {
          if (sql.includes('FROM spots s')) return { rows: [spotRow({ best_times: null, best_seasons: [] } as never)] };
          if (sql.includes('FROM photos')) return { rows: [] };
          return undefined;
        },
      });

      const detail = await service.findDetail('spot-1', USER_ID);
      expect(detail.bestTimes).toEqual([]);
      expect(detail.bestTimeLabels).toEqual([]);
      expect(detail.bestSeasons).toEqual([]);
    });
  });

  describe('findFeed', () => {
    it('按城市筛选并给出下一页游标', async () => {
      const rows = [spotRow({ id: 'a' }), spotRow({ id: 'b' })];
      const { service, db } = buildHarness({
        queryHandler: ({ sql }) => (sql.includes('s.status = \'active\'') ? { rows } : undefined),
      });

      const result = await service.findFeed({ city: '上海市', limitRaw: '2' });
      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).not.toBeNull();

      const params = db.query.mock.calls[0][1] as unknown[];
      expect(params[0]).toBe('上海市');
      expect(params[3]).toBe(2);
    });

    it('未传城市时不加城市条件', async () => {
      const { service, db } = buildHarness();
      await service.findFeed({});
      const params = db.query.mock.calls[0][1] as unknown[];
      expect(params[0]).toBeNull();
    });
  });

  describe('create', () => {
    const createDto = {
      title: '外滩三件套',
      description: '长焦压角',
      lat: 31.2397,
      lng: 121.4903,
      photoKeys: ['uploads/user-1/20260914/a.jpg'],
      heading: 'NE' as const,
      bestTimes: ['sunset' as const],
      difficulty: 2,
    };

    it('境外坐标直接拒绝', async () => {
      const { service } = buildHarness();
      await expect(
        service.create(asUser(USER_ID), { ...createDto, lat: 35.6762, lng: 139.6503 }),
      ).rejects.toThrow('只支持中国大陆');
    });

    it('写入 location 时使用 GCJ-02 经纬度并关联图片', async () => {
      const { service, calls, uploads } = buildHarness({
        queryHandler: ({ sql }) => {
          if (sql.includes('INSERT INTO spots')) return { rows: [{ id: 'spot-new' }] };
          if (sql.includes('INSERT INTO photos')) return { rows: [{ id: 'photo-1' }] };
          if (sql.includes('FROM spots s')) return { rows: [spotRow({ id: 'spot-new' })] };
          return undefined;
        },
      });

      const detail = await service.create(asUser(USER_ID), createDto);

      const insert = calls.find((call) => call.sql.includes('INSERT INTO spots'));
      expect(insert?.params[3]).toBeCloseTo(31.2397, 4);
      expect(insert?.params[4]).toBeCloseTo(121.4903, 4);
      expect(insert?.params[10]).toEqual(['sunset']);
      expect(insert?.params[11]).toEqual([]);
      expect(insert?.params[15]).toBe('active');
      expect(uploads.assertUsableKeys).toHaveBeenCalled();
      expect(detail.id).toBe('spot-new');
    });

    it('前端带了选点时的逆地理结果就不再调高德', async () => {
      const { service, geo } = buildHarness({
        queryHandler: ({ sql }) => {
          if (sql.includes('INSERT INTO spots')) return { rows: [{ id: 'spot-new' }] };
          if (sql.includes('INSERT INTO photos')) return { rows: [{ id: 'photo-1' }] };
          if (sql.includes('FROM spots s')) return { rows: [spotRow({ id: 'spot-new' })] };
          return undefined;
        },
      });

      await service.create(asUser(USER_ID), {
        ...createDto,
        geo: { city: '上海市', district: '黄浦区', address: '中山东一路' },
      });

      expect(geo.reverse).not.toHaveBeenCalled();
    });
  });

  describe('update / softDelete', () => {
    it('非作者不能编辑', async () => {
      const { service } = buildHarness({
        queryHandler: ({ sql }) =>
          sql.includes('SELECT id, user_id, lat, lng, status') ? { rows: [spotRow({ user_id: 'other' })] } : undefined,
      });
      await expect(service.update(USER_ID, 'spot-1', { title: '新标题' })).rejects.toThrow('只能编辑自己');
    });

    it('编辑时允许继续引用本打卡点已有的图片', async () => {
      const { service, uploads } = buildHarness({
        queryHandler: ({ sql }) => {
          if (sql.includes('SELECT id, user_id, lat, lng, status')) return { rows: [spotRow()] };
          if (sql.includes('INSERT INTO photos')) return { rows: [{ id: 'photo-1' }] };
          if (sql.includes('FROM spots s')) return { rows: [spotRow()] };
          if (sql.includes('FROM photos')) return { rows: [] };
          return undefined;
        },
      });

      await service.update(USER_ID, 'spot-1', { title: '新标题', photoKeys: ['uploads/user-1/a.jpg'] });
      expect(uploads.assertUsableKeys).toHaveBeenCalledWith(
        USER_ID,
        ['uploads/user-1/a.jpg'],
        { client: expect.anything(), allowSpotId: 'spot-1' },
      );
    });

    it('删除是软删除，保留数据可追溯', async () => {
      const { service, calls } = buildHarness({
        queryHandler: ({ sql }) =>
          sql.includes('SELECT user_id, status') ? { rows: [{ user_id: USER_ID, status: 'active' }] } : undefined,
      });

      await service.softDelete(USER_ID, 'spot-1');
      const update = calls.find((call) => call.sql.includes('UPDATE spots SET status'));
      expect(update?.sql).toContain("status = 'deleted'");
      expect(update?.sql).not.toContain('DELETE FROM');
    });

    it('不能删除他人内容', async () => {
      const { service } = buildHarness({
        queryHandler: ({ sql }) =>
          sql.includes('SELECT user_id, status') ? { rows: [{ user_id: 'other', status: 'active' }] } : undefined,
      });
      await expect(service.softDelete(USER_ID, 'spot-1')).rejects.toThrow('只能删除自己');
    });
  });
});
