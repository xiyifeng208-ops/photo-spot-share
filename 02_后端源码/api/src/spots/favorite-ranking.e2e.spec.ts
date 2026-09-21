import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../app.module';
import { TokenService } from '../auth/token.service';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { decodeFeedCursor, encodeFeedCursor } from '../common/utils/feed-cursor.util';
import { runMigrations } from '../database/migration-runner';
import { SpotsService } from './spots.service';

const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;
describeWithDb('真实收藏数与关键词收藏排序 (隔离数据库 e2e)', () => {
  let app: INestApplication;
  let db: Client;
  let service: SpotsService;
  const userIds = Array.from({ length: 6 }, () => randomUUID());
  let tokens: string[];
  const prefix = `ranking-${randomUUID()}`;
  const district = `测试-${randomUUID()}`;
  const fixtures = [
    { name: 'popularOld', count: 3, createdAt: '2026-09-01T00:00:00.000000Z' },
    { name: 'tieNew', count: 2, createdAt: '2026-09-18T00:00:00.000000Z' },
    { name: 'microHigh', count: 2, createdAt: '2026-09-17T00:00:00.123456Z' },
    { name: 'microLowA', count: 2, createdAt: '2026-09-17T00:00:00.123455Z' },
    { name: 'microLowB', count: 2, createdAt: '2026-09-17T00:00:00.123455Z' },
    { name: 'newZero', count: 0, createdAt: '2026-09-19T00:00:00.000000Z' },
    { name: 'missingMetadata', count: 1, createdAt: '2026-09-15T00:00:00.000000Z' },
    { name: 'otherCity', count: 4, createdAt: '2026-09-14T00:00:00.000000Z' },
    ...['hidden', 'pending', 'deleted'].map(name => ({ name, count: 5, createdAt: '2026-09-20T00:00:00.000000Z' })),
  ].map(fixture => ({ ...fixture, id: randomUUID() as string,
    status: ['hidden', 'pending', 'deleted'].includes(fixture.name) ? fixture.name : 'active' }));
  const fixture = (name: string) => fixtures.find(item => item.name === name)!;
  const ownIds = fixtures.map(item => item.id);
  const expected = (ranked: boolean, cityOnly = true) => fixtures
    .filter(item => item.status === 'active' && (!cityOnly || item.name !== 'otherCity'))
    .sort((a, b) => (ranked ? b.count - a.count : 0) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .map(item => item.id);

  beforeAll(async () => {
    if (!/^\/spot_test_[a-z0-9_]+$/.test(new URL(url!).pathname)) throw new Error('收藏排序测试只允许独立 spot_test_ 数据库');
    process.env.NODE_ENV = 'test'; process.env.DATABASE_URL = url; process.env.DATABASE_SSL = 'false';
    process.env.AUTH_DEV_MODE = 'true'; process.env.CONTENT_CHECK_ENABLED = 'false';
    process.env.STORAGE_DRIVER = 'local'; process.env.AMAP_KEY = '';
    await runMigrations(url!, () => undefined);
    db = new Client({ connectionString: url }); await db.connect();
    for (const id of userIds) await db.query('INSERT INTO users (id,openid) VALUES ($1,$2)', [id, `ranking:${id}`]);
    for (const item of fixtures) {
      const empty = item.name === 'missingMetadata';
      await db.query(`INSERT INTO spots (id,user_id,title,province,city,district,address,status,lat,lng,location,
        created_at,best_times,best_seasons,focal_length,difficulty)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,31.23,121.49,ST_SetSRID(ST_MakePoint(121.49,31.23),4326),
        $9,$10::spot_best_time[],$11::spot_season[],$12,$13)`,
      [item.id, userIds[0], `${prefix}-${item.name}`, item.name === 'otherCity' ? '浙江省' : '上海市',
        item.name === 'otherCity' ? '宁波市' : '上海市', district, item.name === 'popularOld' ? '100%_相机\\桥' : '测试路',
        item.status, item.createdAt, empty ? [] : item.name === 'newZero' ? ['sunrise'] : ['night', 'sunset'],
        empty ? [] : ['autumn'], empty ? null : 'tele', empty ? null : item.name === 'newZero' ? 3 : 1]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication(); app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter()); app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    const tokenService = app.get(TokenService);
    tokens = userIds.map(id => tokenService.sign(id, `ranking:${id}`));
    service = app.get(SpotsService);
  }, 60000);
  beforeEach(async () => {
    await db.query('DELETE FROM spot_favorites WHERE spot_id=ANY($1::uuid[])', [ownIds]);
    for (const item of fixtures) {
      await db.query('UPDATE spots SET status=$2 WHERE id=$1', [item.id, item.status]);
      for (let index = 1; index <= item.count; index++) await db.query(
        'INSERT INTO spot_favorites (user_id,spot_id) VALUES ($1,$2)', [userIds[index], item.id]);
    }
  });
  afterAll(async () => {
    await app?.close();
    if (db) { await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]); await db.end(); }
  });
  const feed = (query: Record<string, string> = {}) => request(app.getHttpServer()).get('/api/v1/spots/feed')
    .query({ district, city: '上海市', limit: '100', ...query });
  const idsOf = (result: request.Response) => result.body.data.items.map((item: { id: string }) => item.id) as string[];
  const favorite = (method: 'put' | 'delete', name = 'popularOld', userIndex = 0) => request(app.getHttpServer())[method](
    `/api/v1/spots/${fixture(name).id}/favorite`).set('Authorization', `Bearer ${tokens[userIndex]}`);
  const detail = (name = 'popularOld', userIndex?: number) => {
    const result = request(app.getHttpServer()).get(`/api/v1/spots/${fixture(name).id}`);
    return userIndex === undefined ? result : result.set('Authorization', `Bearer ${tokens[userIndex]}`);
  };

  it('关键词非空时收藏多优先，清空和纯空白仍按原发布时间排序', async () => {
    expect(idsOf(await feed({ keyword: ` ${prefix} ` }).expect(200))).toEqual(expected(true));
    for (const keyword of [undefined, '', '   ']) {
      expect(idsOf(await feed(keyword === undefined ? {} : { keyword }).expect(200))).toEqual(expected(false));
    }
    expect(expected(true)[0]).toBe(fixture('popularOld').id);
    expect(expected(false)[0]).toBe(fixture('newZero').id);
    expect(idsOf(await feed({ keyword: prefix, cursor: '' }).expect(200))).toEqual(expected(true));
    expect(idsOf(await feed({ cursor: '' }).expect(200))).toEqual(expected(false));
  });
  it('计数来自全部用户真实关系，匿名详情和零收藏都返回整数', async () => {
    const result = (await detail().expect(200)).body.data;
    expect(result.favoriteCount).toBe(3); expect(result.isFavorited).toBe(false);
    expect((await detail('newZero').expect(200)).body.data.favoriteCount).toBe(0);
    const items = (await feed().expect(200)).body.data.items;
    for (const item of items) expect(item.favoriteCount).toBe(fixtures.find(row => row.id === item.id)!.count);
  });
  it('新增/重复收藏和取消/重复取消返回准确计数，不受客户端伪造计数影响', async () => {
    expect((await favorite('put').send({ favoriteCount: 999 }).expect(200)).body.data).toEqual({ isFavorited: true, favoriteCount: 4 });
    expect((await favorite('put').expect(200)).body.data.favoriteCount).toBe(4);
    expect((await favorite('put', 'popularOld', 5).expect(200)).body.data.favoriteCount).toBe(5);
    expect((await favorite('delete').expect(200)).body.data).toEqual({ isFavorited: false, favoriteCount: 4 });
    expect((await favorite('delete').expect(200)).body.data.favoriteCount).toBe(4);
    expect((await detail().expect(200)).body.data.favoriteCount).toBe(4);
  });
  it('并发同用户重复收藏只贡献一个收藏数', async () => {
    const responses = await Promise.all([favorite('put'), favorite('put'), favorite('put')]);
    expect(responses.map(result => result.body.data.favoriteCount)).toEqual([4, 4, 4]);
    expect((await detail().expect(200)).body.data.favoriteCount).toBe(4);
  });
  it('收藏数不代替身份验证，不允许匿名写入或取消其他用户关系', async () => {
    await request(app.getHttpServer()).put(`/api/v1/spots/${fixture('popularOld').id}/favorite`).expect(401);
    await request(app.getHttpServer()).delete(`/api/v1/spots/${fixture('popularOld').id}/favorite`).expect(401);
    expect((await favorite('delete').send({ userId: userIds[1] }).expect(200)).body.data.favoriteCount).toBe(3);
    expect((await detail('popularOld', 1).expect(200)).body.data.isFavorited).toBe(true);
  });
  it.each(['hidden', 'pending', 'deleted'])('高收藏数 %s 作品仍不向匿名/他人或搜索暴露', async status => {
    await detail(status).expect(404); await detail(status, 1).expect(404);
    await favorite('put', status).expect(404);
    expect(idsOf(await feed({ keyword: prefix }).expect(200))).not.toContain(fixture(status).id);
    if (status !== 'deleted') expect((await detail(status, 0).expect(200)).body.data.favoriteCount).toBe(5);
    else await detail(status, 0).expect(404);
  });
  it('取消仍允许移出隐藏作品，恢复公开后保留真实剩余数量', async () => {
    await db.query("UPDATE spots SET status='hidden' WHERE id=$1", [fixture('popularOld').id]);
    expect((await favorite('delete', 'popularOld', 1).expect(200)).body.data.favoriteCount).toBe(0);
    await db.query("UPDATE spots SET status='active' WHERE id=$1", [fixture('popularOld').id]);
    expect((await detail().expect(200)).body.data.favoriteCount).toBe(2);
  });
  it('幂等取消不向非作者泄露隐藏/待审/已删除或不存在作品的数量', async () => {
    for (const name of ['hidden', 'pending', 'deleted']) {
      expect((await favorite('delete', name, 1).expect(200)).body.data).toEqual({ isFavorited: false, favoriteCount: 0 });
      expect((await favorite('delete', name, 1).expect(200)).body.data.favoriteCount).toBe(0);
      expect((await favorite('delete', name, 0).expect(200)).body.data.favoriteCount).toBe(name === 'deleted' ? 0 : 4);
    }
    const missing = await request(app.getHttpServer()).delete(`/api/v1/spots/${randomUUID()}/favorite`)
      .set('Authorization', `Bearer ${tokens[0]}`).expect(200);
    expect(missing.body.data).toEqual({ isFavorited: false, favoriteCount: 0 });
  });
  it.each([true, false])('静态 %s 分页保留同毫秒内微秒和同时间 UUID 次序，无重复遗漏', async ranked => {
    const collected: string[] = [];
    let cursor = '';
    for (let index = 0; index < 20; index++) {
      const result = await feed({ limit: '1', ...(ranked ? { keyword: prefix } : {}), ...(cursor ? { cursor } : {}) }).expect(200);
      collected.push(...idsOf(result));
      cursor = result.body.data.nextCursor;
      if (!cursor) break;
      const parsed = decodeFeedCursor(cursor, ranked ? 'favorites' : 'latest')!;
      expect(parsed.createdAt).toMatch(/\.\d{6}Z$/);
      if (ranked) expect(parsed.favoriteCount).toBe(result.body.data.items[0].favoriteCount);
    }
    expect(collected).toEqual(expected(ranked));
    expect(new Set(collected).size).toBe(collected.length);
  });
  it('按城市、关键词、全部拍摄条件组合，缺失信息不匹配具体条件', async () => {
    const result = await feed({ keyword: prefix, province: '上海市', bestTimes: 'night,sunset',
      bestSeasons: 'autumn', focalLengths: 'tele', difficulties: '1' }).expect(200);
    expect(idsOf(result)).toEqual(expected(true).filter(id => !['newZero', 'missingMetadata'].some(name => fixture(name).id === id)));
    const all = await feed({ city: '', keyword: prefix }).expect(200);
    expect(idsOf(all)).toEqual(expected(true, false));
    expect(idsOf(all)[0]).toBe(fixture('otherCity').id);
    expect(idsOf(await feed({ keyword: '100%_相机\\桥' }).expect(200))).toEqual([fixture('popularOld').id]);
  });
  it('组合条件每一页继续生效', async () => {
    const collected: string[] = []; let cursor = '';
    for (let page = 0; page < 10; page++) {
      const result = await feed({ keyword: prefix, province: '上海市', bestTimes: 'night', bestSeasons: 'autumn',
        focalLengths: 'tele', difficulties: '1', limit: '2', ...(cursor ? { cursor } : {}) }).expect(200);
      collected.push(...idsOf(result)); cursor = result.body.data.nextCursor;
      if (!cursor) break;
    }
    expect(collected).toEqual(expected(true).filter(id => !['newZero', 'missingMetadata'].some(name => fixture(name).id === id)));
  });
  it('空匹配返回原有结构，不因其他作品收藏多而混入', async () => {
    expect((await feed({ keyword: `${prefix}-absent` }).expect(200)).body.data).toEqual({ items: [], nextCursor: null });
  });
  it('搜索和普通模式不可交换游标，非法参数统一 400 而非 PG 错误', async () => {
    const search = (await feed({ keyword: prefix, limit: '1' }).expect(200)).body.data.nextCursor;
    const latest = (await feed({ limit: '1' }).expect(200)).body.data.nextCursor;
    await feed({ cursor: search }).expect(400); await feed({ keyword: prefix, cursor: latest }).expect(400);
    for (const cursor of ['invalid', 'x'.repeat(513), encodeFeedCursor({ createdAt: '2026-09-18T00:00:00.000000Z',
      id: fixture('popularOld').id, favoriteCount: -1 }, 'favorites')]) await feed({ keyword: prefix, cursor }).expect(400);
    await feed({ keyword: prefix, cursor: encodeFeedCursor({ createdAt: '2026-09-18T00:00:00.000000Z', id: 'bad', favoriteCount: 1 }, 'favorites') }).expect(400);
    await feed({ keyword: prefix, cursor: encodeFeedCursor({ createdAt: '2026-02-30T00:00:00.000000Z', id: fixture('popularOld').id, favoriteCount: 1 }, 'favorites') }).expect(400);
  });
  it('收藏变化后刷新查询使用当前数量重新排名，不缓存旧榜单', async () => {
    for (let index = 1; index < userIds.length; index++) await favorite('put', 'newZero', index).expect(200);
    const result = await feed({ keyword: prefix }).expect(200);
    expect(idsOf(result)[0]).toBe(fixture('newZero').id);
    expect(result.body.data.items[0].favoriteCount).toBe(5);
  });
  it('所有通用卡片读到计数，但地图和我的收藏排序不变', async () => {
    const batch = await service.findPublicByIds(ownIds);
    expect(batch.every(item => item.favoriteCount === fixtures.find(row => row.id === item.id)!.count)).toBe(true);
    expect(batch).toHaveLength(fixtures.filter(item => item.status === 'active').length);
    const map = await service.findInView({ bboxRaw: '121,31,122,32', zoomRaw: '15', limitRaw: '100' });
    const mapIds = map.items.map(item => item.id);
    expect(mapIds.indexOf(fixture('newZero').id)).toBeLessThan(mapIds.indexOf(fixture('popularOld').id));
    expect(map.items.find(item => item.id === fixture('popularOld').id)?.favoriteCount).toBe(3);
    await favorite('put', 'popularOld').expect(200); await favorite('put', 'newZero').expect(200);
    await db.query("UPDATE spot_favorites SET created_at='2026-09-01' WHERE user_id=$1 AND spot_id=$2", [userIds[0], fixture('popularOld').id]);
    await db.query("UPDATE spot_favorites SET created_at='2026-09-02' WHERE user_id=$1 AND spot_id=$2", [userIds[0], fixture('newZero').id]);
    const favorites = await service.findFavorites(userIds[0]);
    expect(favorites.items.map(item => item.id)).toEqual([fixture('newZero').id, fixture('popularOld').id]);
    expect(favorites.items.map(item => item.favoriteCount)).toEqual([1, 4]);
    expect((await service.findMine(userIds[0])).items.find(item => item.id === fixture('hidden').id)?.favoriteCount).toBe(5);
  });
  it('只读计数和搜索不改写收藏关系/作品，现有 spot_id 索引可复用', async () => {
    const snapshot = async () => ({
      spots: (await db.query('SELECT row_to_json(s) AS row FROM spots s WHERE id=ANY($1::uuid[]) ORDER BY id', [ownIds])).rows,
      favorites: (await db.query('SELECT row_to_json(f) AS row FROM spot_favorites f WHERE spot_id=ANY($1::uuid[]) ORDER BY user_id,spot_id', [ownIds])).rows,
    });
    const before = await snapshot();
    await feed({ keyword: prefix }).expect(200); await service.findPublicByIds(ownIds);
    expect(await snapshot()).toEqual(before);
    const index = await db.query("SELECT indexdef FROM pg_indexes WHERE tablename='spot_favorites' AND indexname='spot_favorites_spot_idx'");
    expect(index.rows[0].indexdef).toContain('(spot_id)');
  });
  it('我发布的继续按发布时间排序，精确游标不遗漏同毫秒作品', async () => {
    const collected: string[] = []; let cursor: string | undefined;
    for (let index = 0; index < 20; index++) {
      const result = await service.findMine(userIds[0], cursor, '1');
      collected.push(...result.items.map(item => item.id)); cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
    const expectedMine = fixtures.filter(item => item.status !== 'deleted')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(item => item.id);
    expect(collected).toEqual(expectedMine);
  });
});
