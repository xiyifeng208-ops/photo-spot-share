import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Client } from 'pg';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { runMigrations } from '../database/migration-runner';

const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;

describeWithDb('发现页区域及关键词筛选 (e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const userId = randomUUID();
  const prefix = `search-${randomUUID()}`;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    // This suite creates fixtures only in an explicitly isolated test database.
    if (!new URL(url!).pathname.includes('_test')) throw new Error('搜索端到端测试要求独立的 _test 数据库');
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url;
    process.env.DATABASE_SSL = 'false';
    process.env.AUTH_DEV_MODE = 'true';
    process.env.CONTENT_CHECK_ENABLED = 'false';
    process.env.STORAGE_DRIVER = 'local';
    process.env.AMAP_KEY = '';
    await runMigrations(url!, () => undefined);
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query('INSERT INTO users (id, openid) VALUES ($1, $2)', [userId, prefix]);
    const fixtures = [
      ['title', '外滩拍摄', '上海市', '上海市', '黄浦区', '中山东一路', 'active'],
      ['address', '江边', '上海市', '上海市', '黄浦区', '外滩入口', 'active'],
      ['otherCity', '外滩拍摄', '浙江省', '宁波市', '江北区', '老外滩', 'active'],
      ['direct', '仙桃公园', '湖北省', null, '仙桃市', '公园路', 'active'],
      ['literal', '100%_相机\\位置', '上海市', '上海市', '徐汇区', '测试路', 'active'],
      ['hidden', '外滩隐藏', '上海市', '上海市', '黄浦区', '外滩', 'hidden'],
      ['pending', '外滩审核中', '上海市', '上海市', '黄浦区', '外滩', 'pending'],
      ['deleted', '外滩已删除', '上海市', '上海市', '黄浦区', '外滩', 'deleted'],
    ];
    for (const [name, title, province, city, district, address, status] of fixtures) {
      const id = randomUUID();
      ids[name!] = id;
      await db.query(`INSERT INTO spots (id,user_id,title,description,province,city,district,address,status,lat,lng,location,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,31.23,121.49,ST_SetSRID(ST_MakePoint(121.49,31.23),4326),'2026-09-17T00:00:00Z')`,
      [id, userId, title, prefix, province, city, district, address, status]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  }, 60000);

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query('DELETE FROM users WHERE id=$1', [userId]);
      await db.end();
    }
  });

  const feed = (query: Record<string, string> = {}) => request(app.getHttpServer()).get('/api/v1/spots/feed').query(query);
  const ownIds = (response: request.Response) => response.body.data.items.map((x: { id: string }) => x.id).filter((id: string) => Object.values(ids).includes(id));

  it('省、市和搜索词共同筛选名称或地址，只返回公开内容', async () => {
    const res = await feed({ province: '上海市', city: '上海市', keyword: ' 外滩 ' }).expect(200);
    expect(ownIds(res).sort()).toEqual([ids.title, ids.address].sort());
  });
  it('全部城市搜索包括异地同名作品', async () => {
    const res = await feed({ keyword: '外滩' }).expect(200);
    expect(ownIds(res).sort()).toEqual([ids.title, ids.address, ids.otherCity].sort());
  });
  it.each(['湖北省', '仙桃市', '公园路'])('可搜索省份、区县和地址：%s', async keyword => {
    const res = await feed({ province: '湖北省', district: '仙桃市', keyword }).expect(200);
    expect(ownIds(res)).toEqual([ids.direct]);
  });
  it('可搜索城市字段', async () => {
    const res = await feed({ keyword: '宁波市' }).expect(200);
    expect(ownIds(res)).toEqual([ids.otherCity]);
  });
  it.each(['%', '_', '\\', '100%_'])('通配符按普通文字匹配：%s', async keyword => {
    const res = await feed({ keyword }).expect(200);
    expect(ownIds(res)).toEqual([ids.literal]);
  });
  it('不匹配说明文字或将注入字符串当 SQL 执行', async () => {
    expect(ownIds(await feed({ keyword: prefix }).expect(200))).toEqual([]);
    expect(ownIds(await feed({ keyword: "' OR 1=1 --" }).expect(200))).toEqual([]);
  });
  it('旧 city 参数兼容，空白搜索等同不搜索', async () => {
    const a = await feed({ city: '上海市' }).expect(200);
    const b = await feed({ city: '上海市', keyword: '   ' }).expect(200);
    expect(ownIds(a)).toEqual(ownIds(b));
    expect(ownIds(a).sort()).toEqual([ids.title, ids.address, ids.literal].sort());
  });
  it('超长或非字符串搜索返回 400', async () => {
    await feed({ keyword: '字'.repeat(101) }).expect(400);
    await request(app.getHttpServer()).get('/api/v1/spots/feed?keyword=a&keyword=b').expect(400);
  });
  it('同一时刻发布的结果可稳定分页，无重复与遗漏', async () => {
    const collected: string[] = [];
    let cursor = '';
    for (let page = 0; page < 12; page++) {
      const res = await feed({ city: '上海市', keyword: '外滩', limit: '1', ...(cursor ? { cursor } : {}) }).expect(200);
      collected.push(...ownIds(res));
      cursor = res.body.data.nextCursor;
      if (!cursor) break;
    }
    expect(collected.sort()).toEqual([ids.title, ids.address].sort());
  });
  it('没有匹配作品时返回空数组', async () => {
    const res = await feed({ province: '青海省', city: '西宁市', keyword: prefix }).expect(200);
    expect(res.body.data).toEqual({ items: [], nextCursor: null });
  });
});
