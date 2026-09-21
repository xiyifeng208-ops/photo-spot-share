import { loadConfig } from '../config/configuration';
import { AppException } from '../common/errors';
import { decodeCursor, encodeCursor } from '../common/utils/cursor.util';
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
  describe('readonly public batches', () => {
    it('deduplicates ids and reads active rows once without view increments', async () => {
      const { service, calls } = buildHarness({ queryHandler: () => ({ rows: [spotRow({ difficulty: null, favorite_count: '7' })] }) });
      const items = await service.findPublicByIds(['spot-1', 'spot-1']);
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toContain("s.status = 'active' AND s.id = ANY($1::uuid[])");
      expect(calls[0].params).toEqual([['spot-1']]);
      expect(items[0]).toMatchObject({ province: '上海市', city: '上海市', difficulty: null, difficultyLabel: '暂不确定', favoriteCount: 7 });
      expect(calls[0].sql).toContain('SELECT spot_id, count(*) AS favorite_count FROM spot_favorites GROUP BY spot_id');
      expect(calls[0].sql).not.toContain('UPDATE');
      expect(calls[0].sql).not.toContain('LIMIT');
    });
    it('empty batches make no database call', async () => {
      const { service, calls } = buildHarness();
      expect(await service.findPublicByIds([])).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });
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
    it('组合区域筛选并把搜索中的 LIKE 特殊字符转义', async () => {
      const { service, db } = buildHarness();
      await service.findFeed({ province: ' 湖北省 ', district: '仙桃市', keyword: '  100%_\\路  ' });
      const [sql, rawParams] = db.query.mock.calls[0];
      const params = rawParams as unknown[];
      expect(params[0]).toBeNull();
      expect(params.slice(4, 7)).toEqual(['湖北省', '仙桃市', '%100\\%\\_\\\\路%']);
      expect(sql).toContain("s.status = 'active'");
      expect(sql).not.toContain('100%');
    });

    it('纯空白搜索不增加关键字条件', async () => {
      const { service, db } = buildHarness();
      await service.findFeed({ keyword: '   ' });
      expect((db.query.mock.calls[0][1] as unknown[]).slice(4, 7)).toEqual([null, null, null]);
    });

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

  describe('拍摄条件筛选', () => {
    it('时段/季节使用数组交集，焦段/难度 ANY，各组以 AND 组合', async () => {
      const { service, calls } = buildHarness();
      await service.findFeed({
        city: '上海市', keyword: '外滩', bestTimes: ['sunset', 'night'],
        bestSeasons: ['winter'], focalLengths: ['tele', 'standard'], difficulties: [1, 2],
      });
      expect(calls[0].params.slice(7, 11)).toEqual([['sunset', 'night'], ['winter'], ['tele', 'standard'], [1, 2]]);
      expect(calls[0].sql).toContain('s.best_times && $8::spot_best_time[]');
      expect(calls[0].sql).toContain('AND ($9::spot_season[]');
      expect(calls[0].sql).toContain('s.focal_length = ANY($10::spot_focal_length[])');
      expect(calls[0].sql).toContain('s.difficulty = ANY($11::smallint[])');
      expect(calls[0].sql).not.toContain('外滩');
    });

    it('空数组不施加任何拍摄条件', async () => {
      const { service, calls } = buildHarness();
      await service.findFeed({ bestTimes: [], bestSeasons: [], focalLengths: [], difficulties: [] });
      expect(calls[0].params.slice(7)).toEqual([null, null, null, null]);
    });
  });

  describe('收藏与想去清单', () => {
    it('自己的公开作品也可以收藏，插入冲突不修改收藏时间', async () => {
      const { service, calls, db } = buildHarness({
        queryHandler: ({ sql }) => sql.includes('FOR SHARE') ? { rows: [{ id: 'spot-1' }] }
          : sql.includes('count(*) AS favorite_count') ? { rows: [{ favorite_count: '1' }] } : undefined,
      });
      expect(await service.addFavorite(USER_ID, 'spot-1')).toEqual({ isFavorited: true, favoriteCount: 1 });
      expect(db.withTransaction).toHaveBeenCalledTimes(1);
      expect(calls[0].sql).toContain("status = 'active'");
      expect(calls[1].sql).toContain('ON CONFLICT (user_id, spot_id) DO NOTHING');
      expect(calls[1].params).toEqual([USER_ID, 'spot-1']);
      expect(calls[1].sql).not.toContain('UPDATE');
    });

    it('不存在或非公开作品不能新增收藏', async () => {
      const { service, calls } = buildHarness();
      await expect(service.addFavorite(USER_ID, 'missing')).rejects.toThrow('暂不可收藏');
      expect(calls.some(call => call.sql.includes('INSERT'))).toBe(false);
    });

    it('取消收藏仅删除鉴权用户的关系，计数遵守作品公开权限', async () => {
      const { service, calls } = buildHarness();
      expect(await service.removeFavorite(USER_ID, 'unavailable')).toEqual({ isFavorited: false, favoriteCount: 0 });
      expect(calls[0]).toEqual({
        sql: 'DELETE FROM spot_favorites WHERE user_id = $1 AND spot_id = $2', params: [USER_ID, 'unavailable'],
      });
      expect(calls).toHaveLength(2);
      expect(calls[1].sql).toContain("s.status='active' OR (s.user_id=$2 AND s.status IN ('hidden','pending'))");
      expect(calls[1].params).toEqual(['unavailable', USER_ID]);
    });

    it('收藏清单按收藏时间生成游标，不使用作品发布时间', async () => {
      const favoritedAt = '2026-09-18T08:00:00.123Z';
      const spotId = '12345678-1234-4123-8123-123456789abc';
      const { service, calls } = buildHarness({
        queryHandler: ({ sql }) => sql.includes('JOIN spot_favorites')
          ? { rows: [spotRow({ id: spotId, favorited_at: new Date(favoritedAt) })] } : undefined,
      });
      const result = await service.findFavorites(USER_ID, { province: ' 湖北省 ', district: '仙桃市', limitRaw: '1' });
      expect(result.items).toHaveLength(1);
      expect(decodeCursor(result.nextCursor)).toEqual({ createdAt: favoritedAt, id: spotId });
      expect(calls[0].sql).toContain("WHERE f.user_id = $1 AND s.status = 'active'");
      expect(calls[0].sql).toContain('ORDER BY f.created_at DESC, f.spot_id DESC');
      expect(calls[0].params).toEqual([USER_ID, '湖北省', null, '仙桃市', null, null, 1]);
    });

    it('收藏下一页保留区域条件并传入正确游标', async () => {
      const { service, calls } = buildHarness();
      const cursor = { createdAt: '2026-09-18T08:00:00.123Z', id: '12345678-1234-4123-8123-123456789abc' };
      expect(await service.findFavorites(USER_ID, { city: '上海市', cursor: encodeCursor(cursor) }))
        .toEqual({ items: [], nextCursor: null });
      expect(calls[0].params).toEqual([USER_ID, null, '上海市', null, cursor.createdAt, cursor.id, 20]);
    });

    it('详情读取自己的收藏状态，匿名详情只聚合收藏数不查本人关系', async () => {
      const { service, calls } = buildHarness({
        queryHandler: ({ sql }) => {
          if (sql.includes('FROM spots s')) return { rows: [spotRow()] };
          if (sql.includes('AS is_favorited')) return { rows: [{ is_favorited: true }] };
          return undefined;
        },
      });
      expect((await service.findDetail('spot-1', USER_ID)).isFavorited).toBe(true);
      expect(calls.find(call => call.sql.includes('AS is_favorited'))?.params).toEqual([USER_ID, 'spot-1']);
      calls.length = 0;
      expect((await service.findDetail('spot-1')).isFavorited).toBe(false);
      expect(calls.some(call => call.sql.includes('AS is_favorited'))).toBe(false);
      expect(calls[0].sql).toContain('count(*) AS favorite_count');
    });

    it('非法收藏游标在访问数据库前拒绝', async () => {
      const { service, calls } = buildHarness();
      await expect(service.findFavorites(USER_ID, { cursor: 'bad' })).rejects.toThrow('分页游标无效');
      expect(calls).toHaveLength(0);
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

    function creationHarness() {
      return buildHarness({ queryHandler: ({ sql }) => {
        if (sql.includes('INSERT INTO spots')) return { rows: [{ id: 'spot-new' }] };
        if (sql.includes('INSERT INTO photos')) return { rows: [{ id: 'photo-1' }] };
        if (sql.includes('FROM spots s')) return { rows: [spotRow({ id: 'spot-new' })] };
        return undefined;
      } });
    }

    it('unknown difficulty stays null and complete manual geo bypasses upstream failures', async () => {
      const { service, geo, calls } = creationHarness();
      geo.reverse.mockRejectedValue(new Error('offline') as never);
      await service.create(asUser(USER_ID), { ...createDto, difficulty: undefined,
        geo: { province: '浙江省', city: '杭州市', address: '手填地址' } });
      const insert = calls.find(call => call.sql.includes('INSERT INTO spots'))!;
      expect(insert.params.slice(5, 9)).toEqual(['浙江省', '杭州市', null, '手填地址']);
      expect(insert.params[13]).toBeNull();
      expect(geo.reverse).not.toHaveBeenCalled();
    });

    it('address-only inputs are supplemented while retaining manual wording', async () => {
      const { service, geo, calls } = creationHarness();
      await service.create(asUser(USER_ID), { ...createDto, geo: { address: '自己标记的入口' } });
      expect(geo.reverse).toHaveBeenCalledTimes(1);
      expect(calls.find(call => call.sql.includes('INSERT INTO spots'))?.params.slice(5, 9))
        .toEqual(['上海市', '上海市', '黄浦区', '自己标记的入口']);
    });

    it('missing regions plus upstream failure return actionable 400 before writes', async () => {
      const { service, geo, calls } = creationHarness();
      geo.reverse.mockRejectedValue(new Error('offline') as never);
      await expect(service.create(asUser(USER_ID), { ...createDto, geo: { address: '手填地址' } }))
        .rejects.toThrow('手动确认完整');
      expect(calls).toHaveLength(0);
    });

    it('invalid provided region is not overwritten by an unrelated reverse result', async () => {
      const { service, calls } = creationHarness();
      await expect(service.create(asUser(USER_ID), { ...createDto,
        geo: { province: '浙江省', city: '上海市', address: '手填地址' } })).rejects.toThrow('手动确认完整');
      expect(calls).toHaveLength(0);
    });

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
    function updateHarness(row = spotRow()) {
      return buildHarness({ queryHandler: ({ sql }) => {
        if (sql.includes('SELECT id, user_id, lat, lng, status') || sql.includes('FROM spots s')) return { rows: [row] };
        return undefined;
      } });
    }

    it('explicit null and empty arrays clear fields rather than falling back to stored values', async () => {
      const { service, calls, geo } = updateHarness();
      await service.update(USER_ID, 'spot-1', { heading: null, focalLength: null, difficulty: null,
        accessNote: '', bestTimes: [], bestSeasons: [] });
      const update = calls.find(call => call.sql.includes('UPDATE spots SET heading'))!;
      expect(update.params).toEqual(['spot-1', null, [], [], null, null, null]);
      expect(update.sql).not.toContain('COALESCE');
      expect(update.sql).not.toContain('province');
      expect(geo.reverse).not.toHaveBeenCalled();
    });

    it('content-only update preserves historical incomplete geo and omitted shooting fields', async () => {
      const { service, calls, geo } = updateHarness(spotRow({ province: null, city: null, district: null }));
      await service.update(USER_ID, 'spot-1', { title: '更新说明', lat: 31.2397, lng: 121.4903 });
      const update = calls.find(call => call.sql.includes('UPDATE spots SET title'))!;
      expect(update.params).toEqual(['spot-1', '更新说明']);
      expect(update.sql).not.toContain('heading');
      expect(update.sql).not.toContain('province');
      expect(geo.reverse).not.toHaveBeenCalled();
    });

    it('switching province to a direct district clears the old city and district', async () => {
      const { service, calls } = updateHarness();
      await service.update(USER_ID, 'spot-1', {
        geo: { province: '湖北省', city: null, district: '仙桃市', address: '手填地址' },
      });
      expect(calls.find(call => call.sql.includes('UPDATE spots SET province'))?.params)
        .toEqual(['spot-1', '湖北省', null, '仙桃市', '手填地址']);
    });

    it('changing city clears stale district without geocoding when address is provided', async () => {
      const { service, calls, geo } = updateHarness(spotRow({ province: '浙江省', city: '杭州市', district: '西湖区' }));
      await service.update(USER_ID, 'spot-1', { geo: { city: '宁波市', address: '新地址' } });
      expect(calls.find(call => call.sql.includes('UPDATE spots SET province'))?.params)
        .toEqual(['spot-1', '浙江省', '宁波市', null, '新地址']);
      expect(geo.reverse).not.toHaveBeenCalled();
    });

    it('address-only patches retain existing region when the coordinates are unchanged', async () => {
      const { service, calls, geo } = updateHarness();
      await service.update(USER_ID, 'spot-1', { geo: { address: '新路口' } });
      expect(calls.find(call => call.sql.includes('UPDATE spots SET province'))?.params)
        .toEqual(['spot-1', '上海市', '上海市', '黄浦区', '新路口']);
      expect(geo.reverse).not.toHaveBeenCalled();
    });

    it('changed coordinates do not silently reuse historic region on lookup failure', async () => {
      const { service, calls, geo } = updateHarness();
      geo.reverse.mockRejectedValue(new Error('offline') as never);
      await expect(service.update(USER_ID, 'spot-1', { lat: 30.2, lng: 120.1 })).rejects.toThrow('手动确认完整');
      expect(calls.some(call => call.sql.startsWith('UPDATE'))).toBe(false);
    });
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
