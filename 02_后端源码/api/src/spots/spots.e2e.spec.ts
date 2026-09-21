/**
 * 端到端用例：需要真实的 PostGIS 数据库。
 *
 * 运行方式：
 *   docker compose -f deploy/docker-compose.yml up -d postgres
 *   TEST_DATABASE_URL=postgres://spot@localhost:55432/spot_test_v13_20260918 pnpm test -- spots.e2e
 * 必须先创建隔离测试库；不能使用日常 spot 数据库，也不重跑日常种子。
 *
 * 未提供 TEST_DATABASE_URL 时整组用例自动跳过，保证 `pnpm test` 在没有数据库的环境也能跑。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { runMigrations } from '../database/migration-runner';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDb = testDatabaseUrl ? describe : describe.skip;

describeWithDb('打卡点全链路 (e2e)', () => {
  let app: INestApplication;
  let api: string;
  let token: string;
  let otherToken: string;
  let spotId: string;

  const shanghai = { lat: 31.2397, lng: 121.4903 };
  const bbox = '121.4,31.2,121.6,31.4';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AUTH_DEV_MODE = 'true';
    process.env.JWT_SECRET = 'e2e-secret';
    process.env.STORAGE_DRIVER = 'local';
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    process.env.LOCAL_STORAGE_DIR = mkdtempSync(join(tmpdir(), 'spot-uploads-'));

    await runMigrations(testDatabaseUrl!, () => undefined);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    api = '/api/v1';

    const owner = await request(app.getHttpServer())
      .post(`${api}/auth/wx-login`)
      .send({ code: 'dev:e2e-owner' })
      .expect(201);
    token = owner.body.data.token;

    const other = await request(app.getHttpServer())
      .post(`${api}/auth/wx-login`)
      .send({ code: 'dev:e2e-other' })
      .expect(201);
    otherToken = other.body.data.token;
  }, 60_000);

  afterAll(async () => {
    if (spotId) {
      await request(app.getHttpServer())
        .delete(`${api}/spots/${spotId}`)
        .set('Authorization', `Bearer ${token}`);
    }
    await app?.close();
  });

  it('健康检查可用', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.data.database).toBe('up');
  });

  it('未登录创建打卡点返回 401', async () => {
    await request(app.getHttpServer())
      .post(`${api}/spots`)
      .send({ title: '未登录', lat: shanghai.lat, lng: shanghai.lng, photoKeys: ['x'] })
      .expect(401);
  });

  it('参数不合法时返回 400 且带中文提示', async () => {
    const res = await request(app.getHttpServer())
      .post(`${api}/spots`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '短', lat: shanghai.lat, lng: shanghai.lng, photoKeys: [] })
      .expect(400);

    expect(res.body.error.message).toBeTruthy();
  });

  it('境外坐标被拒绝', async () => {
    await request(app.getHttpServer())
      .post(`${api}/spots`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: '东京塔机位',
        lat: 35.6586,
        lng: 139.7454,
        photoKeys: ['uploads/x/20260914/a.jpg'],
      })
      .expect(400);
  });

  it('完成 申请凭证 → 上传图片 → 发布打卡点 → 地图可见 的闭环', async () => {
    const signRes = await request(app.getHttpServer())
      .post(`${api}/uploads/photos/sign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ mime: 'image/jpeg', size: 2048, width: 1200, height: 900 }] })
      .expect(201);

    const signed = signRes.body.data;
    expect(signed.driver).toBe('local');
    const key = signed.keys[0];

    // 上传地址必须跟着请求来源走：手机用局域网 IP 访问时不能拿到 localhost
    expect(signed.uploadUrl).toContain('/api/v1/uploads/local');
    expect(signed.uploadUrl).not.toContain('localhost');
    expect(signed.urls[key]).toContain('/static/');

    await request(app.getHttpServer())
      .post(`${api}/uploads/local`)
      .set('Authorization', `Bearer ${token}`)
      .field('key', key)
      .attach('file', Buffer.from('fake-jpeg-bytes'), 'a.jpg')
      .expect(201);

    const createRes = await request(app.getHttpServer())
      .post(`${api}/spots`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: '外滩三件套机位',
        description: '长焦压角，江面留倒影',
        lat: shanghai.lat,
        lng: shanghai.lng,
        heading: 'NE',
        bestTimes: ['sunset', 'blue_hour'],
        bestSeasons: ['autumn'],
        focalLength: 'tele',
        difficulty: 2,
        accessNote: '地铁 2 号线南京东路站',
        photoKeys: [key],
        geo: { province: '上海市', city: '上海市', district: '黄浦区', address: '中山东一路' }
      })
      .expect(201);

    spotId = createRes.body.data.id;
    expect(createRes.body.data.photos).toHaveLength(1);
    expect(createRes.body.data.city).toBe('上海市');

    const listRes = await request(app.getHttpServer())
      .get(`${api}/spots?bbox=${bbox}&zoom=14`)
      .expect(200);
    expect(listRes.body.data.mode).toBe('points');
    expect(listRes.body.data.items.map((item: { id: string }) => item.id)).toContain(spotId);

    const feedRes = await request(app.getHttpServer())
      .get(`${api}/spots/feed?city=${encodeURIComponent('上海市')}`)
      .expect(200);
    expect(feedRes.body.data.items.map((item: { id: string }) => item.id)).toContain(spotId);
  }, 30_000);

  it('低 zoom 返回城市聚合点', async () => {
    const res = await request(app.getHttpServer())
      .get(`${api}/spots?bbox=100,20,130,45&zoom=6`)
      .expect(200);

    expect(res.body.data.mode).toBe('cluster');
    expect(res.body.data.clusters.length).toBeGreaterThan(0);
    expect(res.body.data.clusters[0]).toHaveProperty('count');
  });

  it('详情包含样张与拍摄参数，浏览量自增', async () => {
    const first = await request(app.getHttpServer()).get(`${api}/spots/${spotId}`).expect(200);
    expect(first.body.data.photos).toHaveLength(1);
    expect(first.body.data.focalLengthLabel).toBe('长焦');
    expect(first.body.data.bestTimeLabels).toContain('日落');

    const second = await request(app.getHttpServer()).get(`${api}/spots/${spotId}`).expect(200);
    expect(second.body.data.viewCount).toBeGreaterThan(first.body.data.viewCount);
  });

  it('他人不能删除，作者可以删除，删除后地图不可见', async () => {
    await request(app.getHttpServer())
      .delete(`${api}/spots/${spotId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .delete(`${api}/spots/${spotId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const detail = await request(app.getHttpServer()).get(`${api}/spots/${spotId}`).expect(404);
    expect(detail.body.error.code).toBe('NOT_FOUND');

    const listRes = await request(app.getHttpServer())
      .get(`${api}/spots?bbox=${bbox}&zoom=14`)
      .expect(200);
    expect(listRes.body.data.items.map((item: { id: string }) => item.id)).not.toContain(spotId);

    spotId = '';
  });

  it('非法 bbox 返回 400', async () => {
    await request(app.getHttpServer()).get(`${api}/spots?bbox=bad&zoom=14`).expect(400);
  });
});
