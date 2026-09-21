import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Client } from 'pg';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { runMigrations } from '../database/migration-runner';
import { CURATED_ROUTES, ROUTE_CATALOG, type CuratedRoute } from './routes.catalog';

const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;

describeWithDb('精选摄影路线公开读取 (e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const userId = randomUUID();
  const spotIds = Array.from({ length: 8 }, () => randomUUID());
  const config: CuratedRoute = {
    ...ROUTE_CATALOG[0], id: 'test-curated-route',
    stops: spotIds.map((spotId, index) => ({ spotId, suggestedTime: `时段 ${index + 1}`, note: `站点说明 ${index + 1}` })),
  };

  beforeAll(async () => {
    if (!new URL(url!).pathname.includes('_test')) throw new Error('路线端到端测试要求独立的 _test 数据库');
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
    await db.query('INSERT INTO users (id, openid) VALUES ($1, $2)', [userId, `route-test:${userId}`]);
    const statuses = ['active', 'active', 'active', 'hidden', 'pending', 'deleted', 'active'];
    for (let index = 0; index < statuses.length; index++) {
      await db.query(`INSERT INTO spots (id,user_id,title,province,city,district,status,lat,lng,location,view_count)
        VALUES ($1,$2,$3,$4,$5,'测试区',$6,31.23,121.49,ST_SetSRID(ST_MakePoint(121.49,31.23),4326),7)`,
      [spotIds[index], userId, `路线测试机位 ${index + 1}`, index === 6 ? '浙江省' : '上海市',
        index === 6 ? '杭州市' : '上海市', statuses[index]]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CURATED_ROUTES).useValue([config]).compile();
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
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
      await db.end();
    }
  });
  const list = () => request(app.getHttpServer()).get('/api/v1/routes');
  const detail = () => request(app.getHttpServer()).get(`/api/v1/routes/${config.id}`);

  it('匿名列表读取只统计公开同城站点，不返回内部站点配置', async () => {
    const response = await list().expect(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toMatchObject({ stopCount: 3, totalStopCount: 8, unavailableCount: 5, isDemo: true, coverUrl: null });
    expect(response.body.data.items[0]).not.toHaveProperty('stops');
  });
  it('详情按配置站序，仅返回公开同城内容，隐藏及缺失站点不泄露', async () => {
    const response = await detail().expect(200);
    expect(response.body.data.stops.map((stop: { spot: { id: string } }) => stop.spot.id)).toEqual(spotIds.slice(0, 3));
    for (let index = 3; index < 8; index++) {
      expect(JSON.stringify(response.body.data)).not.toContain(spotIds[index]);
      expect(JSON.stringify(response.body.data)).not.toContain(`站点说明 ${index + 1}`);
    }
  });
  it('路线读取不增加作品浏览量', async () => {
    await list().expect(200); await detail().expect(200);
    const result = await db.query('SELECT view_count FROM spots WHERE user_id=$1', [userId]);
    expect(result.rows).toHaveLength(7);
    expect(result.rows.every(row => row.view_count === 7)).toBe(true);
  });
  it('不存在或非法路线 id 返回 404', async () => {
    await request(app.getHttpServer()).get('/api/v1/routes/not-configured').expect(404);
    await request(app.getHttpServer()).get('/api/v1/routes/%27%20OR%201=1').expect(404);
  });
  it('隐藏站点立即移出，恢复公开重新出现，原站序保留', async () => {
    try {
      await db.query("UPDATE spots SET status='hidden' WHERE id=$1", [spotIds[1]]);
      const hidden = await detail().expect(200);
      expect(hidden.body.data.stops.map((stop: { order: number }) => stop.order)).toEqual([1, 3]);
      expect(hidden.body.data.unavailableCount).toBe(6);
    } finally {
      await db.query("UPDATE spots SET status='active' WHERE id=$1", [spotIds[1]]);
    }
    expect((await detail().expect(200)).body.data.stopCount).toBe(3);
  });
  it('不足两个公开站点时列表省略并拒绝详情', async () => {
    try {
      await db.query("UPDATE spots SET status='hidden' WHERE id=ANY($1::uuid[])", [spotIds.slice(1, 3)]);
      expect((await list().expect(200)).body.data).toEqual({ items: [] });
      await detail().expect(404);
    } finally {
      await db.query("UPDATE spots SET status='active' WHERE id=ANY($1::uuid[])", [spotIds.slice(1, 3)]);
    }
  });
  it('机位编辑移城后不继续沿用原城市路线', async () => {
    try {
      await db.query("UPDATE spots SET province='浙江省',city='杭州市' WHERE id=$1", [spotIds[1]]);
      const response = await detail().expect(200);
      expect(response.body.data.stops.map((stop: { order: number }) => stop.order)).toEqual([1, 3]);
    } finally {
      await db.query("UPDATE spots SET province='上海市',city='上海市' WHERE id=$1", [spotIds[1]]);
    }
  });
});
