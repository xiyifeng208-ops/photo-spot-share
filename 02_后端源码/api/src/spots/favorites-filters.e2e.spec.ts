import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { runMigrations } from '../database/migration-runner';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDb = databaseUrl ? describe : describe.skip;

describeWithDb('收藏、想去清单与拍摄条件 (隔离数据库 e2e)', () => {
  let app: INestApplication;
  let db: Client;
  let ownerId: string;
  let otherId: string;
  let ownerToken: string;
  let otherToken: string;
  const prefix = `fav-${randomUUID()}`;
  const ids: Record<string, string> = {};
  const fixtures = [
    { name: 'sunset', province: '上海市', city: '上海市', district: '黄浦区', times: ['sunset', 'blue_hour'], seasons: ['autumn'], focal: 'tele', difficulty: 1 },
    { name: 'night', province: '上海市', city: '上海市', district: '黄浦区', times: ['night'], seasons: ['winter'], focal: 'standard', difficulty: 2 },
    { name: 'mixed', province: '上海市', city: '上海市', district: '浦东新区', times: ['sunrise', 'night'], seasons: ['summer', 'winter'], focal: 'ultrawide', difficulty: 3 },
    { name: 'outside', province: '浙江省', city: '宁波市', district: '江北区', times: ['night'], seasons: ['winter'], focal: 'tele', difficulty: 1 },
    { name: 'direct', province: '湖北省', city: null, district: '仙桃市', times: ['sunrise'], seasons: ['spring'], focal: 'macro', difficulty: 1 },
    { name: 'empty', province: '上海市', city: '上海市', district: '徐汇区', times: [], seasons: [], focal: null, difficulty: 1 },
    { name: 'drone', province: '上海市', city: '上海市', district: '崇明区', times: ['morning', 'noon', 'afternoon'], seasons: ['spring'], focal: 'drone', difficulty: 2 },
    ...['hidden', 'pending', 'deleted'].map(name => ({ name, province: '上海市', city: '上海市', district: '黄浦区', times: ['night'], seasons: ['winter'], focal: 'tele', difficulty: 1 })),
  ];

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.includes('_test')) {
      throw new Error('收藏及条件筛选测试只允许独立的 _test 数据库');
    }
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = databaseUrl;
    process.env.DATABASE_SSL = 'false';
    process.env.AUTH_DEV_MODE = 'true';
    process.env.CONTENT_CHECK_ENABLED = 'false';
    process.env.STORAGE_DRIVER = 'local';
    process.env.AMAP_KEY = '';
    await runMigrations(databaseUrl!, () => undefined);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    for (const who of ['owner', 'other']) {
      const res = await request(app.getHttpServer()).post('/api/v1/auth/wx-login')
        .send({ code: `dev:${prefix}-${who}` }).expect(201);
      if (who === 'owner') { ownerId = res.body.data.user.id; ownerToken = res.body.data.token; }
      else { otherId = res.body.data.user.id; otherToken = res.body.data.token; }
    }
    for (const fixture of fixtures) {
      const id = randomUUID();
      ids[fixture.name] = id;
      await db.query(`INSERT INTO spots (
        id,user_id,title,province,city,district,address,best_times,best_seasons,focal_length,difficulty,status,lat,lng,location,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::spot_best_time[],$9::spot_season[],$10,$11,$12,31.23,121.49,
        ST_SetSRID(ST_MakePoint(121.49,31.23),4326),'2026-09-18T01:00:00Z')`,
      [id, ownerId, `${prefix}-${fixture.name}`, fixture.province, fixture.city, fixture.district,
        `${fixture.name}测试地址`, fixture.times, fixture.seasons, fixture.focal, fixture.difficulty,
        ['hidden', 'pending', 'deleted'].includes(fixture.name) ? fixture.name : 'active']);
    }
  }, 60000);

  beforeEach(async () => {
    await db.query('DELETE FROM spot_favorites WHERE user_id = ANY($1::uuid[])', [[ownerId, otherId]]);
    await db.query("UPDATE spots SET status = 'active' WHERE id = ANY($1::uuid[])",
      [fixtures.filter(f => !['hidden', 'pending', 'deleted'].includes(f.name)).map(f => ids[f.name])]);
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ownerId, otherId].filter(Boolean)]);
      await db.end();
    }
  });

  const favorite = (name: string, token = ownerToken) => request(app.getHttpServer())
    .put(`/api/v1/spots/${ids[name]}/favorite`).set('Authorization', `Bearer ${token}`);
  const unfavorite = (name: string, token = ownerToken) => request(app.getHttpServer())
    .delete(`/api/v1/spots/${ids[name]}/favorite`).set('Authorization', `Bearer ${token}`);
  const favorites = (query: Record<string, string> = {}, token = ownerToken) => request(app.getHttpServer())
    .get('/api/v1/spots/favorites').set('Authorization', `Bearer ${token}`).query(query);
  const feed = (query: Record<string, string | undefined> = {}) => request(app.getHttpServer())
    .get('/api/v1/spots/feed').query({ keyword: prefix, ...query });
  const resultIds = (res: request.Response) => res.body.data.items.map((item: { id: string }) => item.id) as string[];
  const expectFeed = async (query: Record<string, string>, names: string[]) => {
    expect(resultIds(await feed(query).expect(200)).sort()).toEqual(names.map(name => ids[name]).sort());
  };

  it('收藏、取消及清单均要求登录，公开发现流不要求登录', async () => {
    await request(app.getHttpServer()).put(`/api/v1/spots/${ids.sunset}/favorite`).expect(401);
    await request(app.getHttpServer()).delete(`/api/v1/spots/${ids.sunset}/favorite`).expect(401);
    await request(app.getHttpServer()).get('/api/v1/spots/favorites').expect(401);
    await feed().expect(200);
  });

  it('支持收藏自己的公开作品，重复收藏不产生重复且不改时间', async () => {
    expect((await favorite('sunset').expect(200)).body.data).toEqual({ isFavorited: true, favoriteCount: 1 });
    await db.query("UPDATE spot_favorites SET created_at='2026-09-01T00:00:00.123Z' WHERE user_id=$1 AND spot_id=$2", [ownerId, ids.sunset]);
    await favorite('sunset').expect(200);
    const rows = (await db.query('SELECT created_at FROM spot_favorites WHERE user_id=$1 AND spot_id=$2', [ownerId, ids.sunset])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at.toISOString()).toBe('2026-09-01T00:00:00.123Z');
    expect(resultIds(await favorites().expect(200))).toEqual([ids.sunset]);
  });

  it('同时重复收藏不会产生重复关系', async () => {
    const responses = await Promise.all([favorite('night'), favorite('night'), favorite('night')]);
    expect(responses.every(res => res.status === 200)).toBe(true);
    expect(resultIds(await favorites().expect(200))).toEqual([ids.night]);
  });

  it('不同用户清单和取消操作完全隔离，客户端 userId 不能越权', async () => {
    await favorite('sunset').send({ userId: otherId }).expect(200);
    expect(resultIds(await favorites().expect(200))).toEqual([ids.sunset]);
    expect(resultIds(await favorites({}, otherToken).expect(200))).toEqual([]);
    await favorite('night', otherToken).expect(200);
    await unfavorite('sunset', otherToken).expect(200);
    expect(resultIds(await favorites().expect(200))).toEqual([ids.sunset]);
    expect(resultIds(await favorites({ userId: ownerId }, otherToken).expect(200))).toEqual([ids.night]);
  });

  it('重复取消收藏成功，不存在的关系也返回 false', async () => {
    await favorite('sunset').expect(200);
    expect((await unfavorite('sunset').expect(200)).body.data).toEqual({ isFavorited: false, favoriteCount: 0 });
    expect((await unfavorite('sunset').expect(200)).body.data).toEqual({ isFavorited: false, favoriteCount: 0 });
    expect(resultIds(await favorites().expect(200))).toEqual([]);
  });

  it.each(['hidden', 'pending', 'deleted'])('非公开作品不能新增收藏：%s', async name => {
    await favorite(name).expect(404);
    await favorite(name, otherToken).expect(404);
    expect(resultIds(await favorites().expect(200))).toEqual([]);
  });

  it('不存在的作品或非法 UUID 不能收藏', async () => {
    await request(app.getHttpServer()).put(`/api/v1/spots/${randomUUID()}/favorite`).set('Authorization', `Bearer ${ownerToken}`).expect(404);
    await request(app.getHttpServer()).put('/api/v1/spots/not-a-uuid/favorite').set('Authorization', `Bearer ${ownerToken}`).expect(404);
  });

  it.each(['hidden', 'pending', 'deleted'])('已收藏作品变为 %s 后不泄露内容，仍可移出清单', async status => {
    await favorite('sunset', otherToken).expect(200);
    await db.query('UPDATE spots SET status=$2 WHERE id=$1', [ids.sunset, status]);
    expect((await favorites({}, otherToken).expect(200)).body.data).toEqual({ items: [], nextCursor: null });
    await request(app.getHttpServer()).get(`/api/v1/spots/${ids.sunset}`).set('Authorization', `Bearer ${otherToken}`).expect(404);
    await unfavorite('sunset', otherToken).expect(200);
    expect((await db.query('SELECT 1 FROM spot_favorites WHERE user_id=$1', [otherId])).rowCount).toBe(0);
  });

  it('隐藏后恢复公开会重新出现在原用户清单，不丢失关系', async () => {
    await favorite('sunset').expect(200);
    await db.query("UPDATE spots SET status='hidden' WHERE id=$1", [ids.sunset]);
    expect(resultIds(await favorites().expect(200))).toEqual([]);
    await db.query("UPDATE spots SET status='active' WHERE id=$1", [ids.sunset]);
    expect(resultIds(await favorites().expect(200))).toEqual([ids.sunset]);
  });

  it('详情收藏状态取当前用户，匿名与其他用户不会继承', async () => {
    await favorite('sunset').expect(200);
    const detail = (token?: string) => {
      const call = request(app.getHttpServer()).get(`/api/v1/spots/${ids.sunset}`);
      return token ? call.set('Authorization', `Bearer ${token}`) : call;
    };
    expect((await detail(ownerToken).expect(200)).body.data.isFavorited).toBe(true);
    expect((await detail(otherToken).expect(200)).body.data.isFavorited).toBe(false);
    expect((await detail().expect(200)).body.data.isFavorited).toBe(false);
    await unfavorite('sunset').expect(200);
    expect((await detail(ownerToken).expect(200)).body.data.isFavorited).toBe(false);
  });

  it('收藏清单支持普通城市、直辖市与 city 为空的省直辖地区', async () => {
    for (const name of ['sunset', 'outside', 'direct']) await favorite(name).expect(200);
    expect(resultIds(await favorites({ province: '上海市', city: '上海市' }).expect(200))).toEqual([ids.sunset]);
    expect(resultIds(await favorites({ province: '浙江省', city: '宁波市' }).expect(200))).toEqual([ids.outside]);
    expect(resultIds(await favorites({ province: '湖北省', district: '仙桃市' }).expect(200))).toEqual([ids.direct]);
    expect(resultIds(await favorites({ city: '西宁市' }).expect(200))).toEqual([]);
    const located = await favorites({ city: '上海市', viewerLat: '31.23', viewerLng: '121.49' }).expect(200);
    expect(located.body.data.items[0].distanceMeters).toBe(0);
  });

  it('收藏排序按收藏时间，毫秒相同按 ID 倒序，分页无重复遗漏', async () => {
    const names = ['sunset', 'night', 'mixed'];
    for (const name of names) await favorite(name).expect(200);
    await db.query("UPDATE spot_favorites SET created_at='2026-09-18T09:00:00.123Z' WHERE user_id=$1", [ownerId]);
    await db.query("UPDATE spot_favorites SET created_at='2026-09-18T09:00:01.456Z' WHERE user_id=$1 AND spot_id=$2", [ownerId, ids.sunset]);
    const collected: string[] = [];
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const res = await favorites({ city: '上海市', limit: '1', ...(cursor ? { cursor } : {}) }).expect(200);
      collected.push(...resultIds(res));
      cursor = res.body.data.nextCursor;
      if (!cursor) break;
    }
    expect(collected).toEqual([ids.sunset, ...[ids.night, ids.mixed].sort().reverse()]);
  });

  it('收藏无效查询返回 400，静态 favorites 路由不会被详情 UUID 路由吞掉', async () => {
    await favorites({ cursor: 'bad' }).expect(400);
    await favorites({ province: '字'.repeat(65) }).expect(400);
    await request(app.getHttpServer()).get('/api/v1/spots/favorites?city=a&city=b').set('Authorization', `Bearer ${ownerToken}`).expect(400);
    await favorites().expect(200);
  });

  it('时段组内 OR，不要求作品同时具有所有所选时段', async () => {
    await expectFeed({ bestTimes: 'sunrise,night' }, ['night', 'mixed', 'outside', 'direct']);
  });
  it('季节组内 OR，空季节记录不匹配指定季节', async () => {
    await expectFeed({ bestSeasons: 'autumn,summer' }, ['sunset', 'mixed']);
  });
  it('焦段组内 OR，未填写焦段的记录不匹配指定焦段', async () => {
    await expectFeed({ focalLengths: 'tele,drone' }, ['sunset', 'outside', 'drone']);
  });
  it('难度组内 OR', async () => {
    await expectFeed({ difficulties: '2,3' }, ['night', 'mixed', 'drone']);
  });
  it('拍摄条件组间 AND，并与省市关键词共同生效', async () => {
    await expectFeed({ province: '上海市', city: '上海市', bestTimes: 'night', bestSeasons: 'winter', focalLengths: 'standard,ultrawide', difficulties: '2' }, ['night']);
    await expectFeed({ province: '湖北省', district: '仙桃市', bestTimes: 'sunrise', bestSeasons: 'spring', focalLengths: 'macro', difficulties: '1' }, ['direct']);
    await expectFeed({ city: '上海市', bestTimes: 'sunset', bestSeasons: 'winter' }, []);
  });
  it('未指定或空白条件兼容旧列表，包含未填写拍摄参数作品', async () => {
    const expected = fixtures.filter(f => !['hidden', 'pending', 'deleted'].includes(f.name)).map(f => f.name);
    await expectFeed({}, expected);
    await expectFeed({ bestTimes: ' ', bestSeasons: '', focalLengths: '', difficulties: '' }, expected);
  });
  it.each([
    { bestTimes: 'invalid' }, { bestSeasons: 'rainy' }, { focalLengths: 'phone' }, { difficulties: '4' },
    { bestTimes: 'night,' }, { difficulties: '1.5' }, { difficulties: '01' }, { bestTimes: "night'); DROP TABLE spots;--" },
  ])('非法筛选值返回 400：%j', async query => { await feed(query).expect(400); });
  it('重复 query 参数不能冒充 CSV 条件', async () => {
    await request(app.getHttpServer()).get('/api/v1/spots/feed?bestTimes=night&bestTimes=sunset').expect(400);
    await request(app.getHttpServer()).get('/api/v1/spots/feed?difficulties=1&difficulties=2').expect(400);
  });
  it('拍摄条件分页保留当前筛选，不混入非公开或不匹配作品', async () => {
    const collected: string[] = [];
    let cursor = '';
    for (let page = 0; page < 8; page++) {
      const res = await feed({ bestTimes: 'night', bestSeasons: 'winter', limit: '1', ...(cursor ? { cursor } : {}) }).expect(200);
      collected.push(...resultIds(res));
      cursor = res.body.data.nextCursor;
      if (!cursor) break;
    }
    expect(collected.sort()).toEqual([ids.night, ids.mixed, ids.outside].sort());
  });
});
