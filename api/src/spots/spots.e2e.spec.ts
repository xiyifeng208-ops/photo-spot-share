/**
 * 端到端用例：独立的 PostGIS 或 MySQL 数据库，名称须以 _test 结尾。
 *
 * 运行方式：
 *   TEST_DATABASE_URL=postgres://test:password@localhost:15432/spot_test pnpm test -- spots.e2e
 *   MYSQL_TEST_DATABASE_URL=mysql://test:password@localhost:13306/spot_test pnpm test -- spots.e2e
 *
 * 未提供测试 URL 时自动跳过。MySQL 必须为空库，不自动清理或覆盖已有表。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { createConnection } from 'mysql2/promise';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { runMigrations } from '../database/migration-runner';
import { DatabaseService } from '../database/database.service';
import { ContentCheckTasksService } from './content-check-tasks.service';
import { ContentCheckService } from './content-check.service';
import { ModerationService } from './moderation.service';
import { UploadsService } from '../uploads/uploads.service';
import { randomUUID } from 'node:crypto';

const testDatabaseUrl = process.env.MYSQL_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;
const isMysql = testDatabaseUrl?.startsWith('mysql:') ?? false;
const describeWithDb = testDatabaseUrl ? describe : describe.skip;

describeWithDb('打卡点全链路 (e2e)', () => {
  let app: INestApplication;
  let api: string;
  let token: string;
  let otherToken: string;
  let spotId: string;
  let ownerId: string;

  const shanghai = { lat: 31.2397, lng: 121.4903 };
  const bbox = '121.4,31.2,121.6,31.4';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.DATABASE_SSL = 'false';
    process.env.CONTENT_CHECK_ENABLED = 'false';
    process.env.AMAP_KEY = '';
    process.env.AUTH_DEV_MODE = 'true';
    process.env.JWT_SECRET = 'e2e-secret';
    process.env.STORAGE_DRIVER = 'local';
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    process.env.LOCAL_STORAGE_DIR = mkdtempSync(join(tmpdir(), 'spot-uploads-'));

    const url = new URL(testDatabaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
      throw new Error('E2E requires an isolated local database with a name ending in _test');
    }
    if (isMysql) {
      const connection = await createConnection({ uri: testDatabaseUrl!, multipleStatements: true });
      try {
        const [tables] = await connection.query('SHOW TABLES');
        if ((tables as unknown[]).length) throw new Error('MySQL E2E requires an empty disposable test database');
        await connection.query(readFileSync(join(__dirname, '../../mysql-migrations/0001_mysql_baseline.sql'), 'utf8'));
      } finally { await connection.end(); }
    } else {
      await runMigrations(testDatabaseUrl!, () => undefined);
    }

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
    ownerId = owner.body.data.user.id;

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

  it('重复登录保留用户 ID，资料可更新', async () => {
    const again = await request(app.getHttpServer()).post(`${api}/auth/wx-login`).send({ code: 'dev:e2e-owner' }).expect(201);
    expect(again.body.data.user.id).toBe(ownerId);
    const updated = await request(app.getHttpServer()).patch(`${api}/auth/me`)
      .set('Authorization', `Bearer ${token}`).send({ nickname: '数据库测试者' }).expect(200);
    expect(updated.body.data.nickname).toBe('数据库测试者');
  });

  it('关联数组保持顺序，支持清空及恢复，照片可整体替换', async () => {
    const original = await request(app.getHttpServer()).get(`${api}/spots/${spotId}`).expect(200);
    expect(original.body.data.bestTimes).toEqual(['sunset', 'blue_hour']);
    expect(original.body.data.bestSeasons).toEqual(['autumn']);
    const changed = await request(app.getHttpServer()).patch(`${api}/spots/${spotId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ bestTimes: ['night', 'sunrise'], bestSeasons: [], lat: 31.24, photoKeys: original.body.data.photos.map((p: { key: string }) => p.key) }).expect(200);
    expect(changed.body.data.bestTimes).toEqual(['night', 'sunrise']);
    expect(changed.body.data.bestSeasons).toEqual([]);
    expect(changed.body.data.lat).toBe(31.24);
    expect(changed.body.data.lng).toBe(shanghai.lng);
    await request(app.getHttpServer()).patch(`${api}/spots/${spotId}`)
      .set('Authorization', `Bearer ${token}`).send({ photoKeys: [] }).expect(400);
    await request(app.getHttpServer()).patch(`${api}/spots/${spotId}`)
      .set('Authorization', `Bearer ${token}`).send({ bestTimes: ['sunset', 'blue_hour'], bestSeasons: ['autumn'] }).expect(200);
  });

  it('发现和我的列表游标不重复，UTC 日期可解析', async () => {
    for (const route of ['feed', 'mine']) {
      const first = await request(app.getHttpServer()).get(`${api}/spots/${route}?limit=1`).set('Authorization', `Bearer ${token}`).expect(200);
      expect(first.body.data.items).toHaveLength(1);
      expect(first.body.data.items[0].createdAt).toMatch(/Z$/);
      const next = await request(app.getHttpServer()).get(`${api}/spots/${route}?limit=1&cursor=${encodeURIComponent(first.body.data.nextCursor)}`)
        .set('Authorization', `Bearer ${token}`).expect(200);
      expect(next.body.data.items.map((s: { id: string }) => s.id)).not.toContain(first.body.data.items[0].id);
    }
  });

  (isMysql ? it : it.skip)('MySQL UTC、空间坐标、回滚及票据并发争用', async () => {
    const db = app.get(DatabaseService);
    expect((await db.queryOne<{ tz: string }>('SELECT @@session.time_zone AS tz'))!.tz).toBe('+00:00');
    const coords = await db.queryOne<{ x: number; y: number }>('SELECT ST_X(location) AS x, ST_Y(location) AS y FROM spots WHERE id = $1', [spotId]);
    expect(coords).toEqual({ x: shanghai.lng, y: 31.24 });
    const id = randomUUID();
    await expect(db.withTransaction(async client => {
      await client.query('INSERT INTO users (id, openid) VALUES ($1, $2)', [id, `dev:${id}`]);
      throw new Error('rollback-test');
    })).rejects.toThrow('rollback-test');
    expect(await db.queryOne('SELECT id FROM users WHERE id = $1', [id])).toBeNull();
    const signed = await app.get(UploadsService).signUploads(ownerId, [{ mime: 'image/jpeg', size: 32 }]);
    const body = { title: '并发票据测试', ...shanghai, photoKeys: signed.keys, geo: { city: '上海市' } };
    const attempts = await Promise.all([1, 2].map(() => request(app.getHttpServer()).post(`${api}/spots`)
      .set('Authorization', `Bearer ${token}`).send(body)));
    expect(attempts.map(res => res.status).sort()).toEqual([201, 400]);
  });

  (isMysql ? it : it.skip)('MySQL 举报去重、阈值隐藏、运营恢复', async () => {
    const db = app.get(DatabaseService);
    const moderation = app.get(ModerationService);
    const reporters = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of reporters) await db.query('INSERT INTO users (id, openid) VALUES ($1, $2)', [id, `dev:${id}`]);
    const reports = await Promise.all(reporters.map(reporterId => moderation.reportSpot({ spotId, reporterId, reason: '其他' })));
    expect(reports.filter(result => result.hidden)).toHaveLength(1);
    await expect(moderation.reportSpot({ spotId, reporterId: reporters[0], reason: '其他' })).rejects.toThrow();
    expect((await db.queryOne<{ status: string }>('SELECT status FROM spots WHERE id = $1', [spotId]))!.status).toBe('hidden');
    expect(await moderation.resolveReports(spotId, 'resolved')).toBe(3);
    expect(await moderation.listReports('resolved')).toHaveLength(3);
    await moderation.setStatus(spotId, 'active');
  });

  (isMysql ? it : it.skip)('MySQL 发布即待审、仅作者可见；关联写入失败整体回滚', async () => {
    const db = app.get(DatabaseService);
    const checks = app.get(ContentCheckService);
    const uploads = app.get(UploadsService);
    const signed = await uploads.signUploads(ownerId, [{ mime: 'image/jpeg', size: 32 }]);
    const body = { title: '待审可见性测试', ...shanghai, photoKeys: signed.keys, geo: { city: '上海市' } };
    const before = await db.queryOne<{ n: number }>('SELECT count(*) AS n FROM spots');
    await request(app.getHttpServer()).post(`${api}/spots`).set('Authorization', `Bearer ${token}`)
      .send({ ...body, bestTimes: ['sunset', 'sunset'] }).expect(400);
    expect(await db.queryOne('SELECT count(*) AS n FROM spots')).toEqual(before);
    expect((await db.queryOne<{ spot_id: string | null }>('SELECT spot_id FROM upload_tickets WHERE object_key = $1', [signed.keys[0]]))!.spot_id).toBeNull();
    const readiness = jest.spyOn(checks, 'mediaCheckReady', 'get').mockReturnValue(true);
    const submit = jest.spyOn(checks, 'submitMediaCheck').mockResolvedValue('create-trace');
    try {
      const created = await request(app.getHttpServer()).post(`${api}/spots`).set('Authorization', `Bearer ${token}`).send(body).expect(201);
      expect(created.body.data.status).toBe('pending');
      const id = created.body.data.id;
      await request(app.getHttpServer()).get(`${api}/spots/${id}`).expect(404);
      await request(app.getHttpServer()).get(`${api}/spots/${id}`).set('Authorization', `Bearer ${token}`).expect(200);
      await app.get(ContentCheckTasksService).applyVerdict('create-trace', 'risky');
      expect((await db.queryOne<{ status: string }>('SELECT status FROM spots WHERE id = $1', [id]))!.status).toBe('hidden');
    } finally { readiness.mockRestore(); submit.mockRestore(); }
  });

  (isMysql ? it : it.skip)('MySQL 图片审核全部通过才公开，失败或超时隐藏，孤儿清理', async () => {
    const db = app.get(DatabaseService);
    const checks = app.get(ContentCheckService);
    const tasks = app.get(ContentCheckTasksService);
    const readiness = jest.spyOn(checks, 'mediaCheckReady', 'get').mockReturnValue(true);
    const submit = jest.spyOn(checks, 'submitMediaCheck').mockResolvedValueOnce('test-trace-1').mockResolvedValueOnce('test-trace-2');
    await db.query("UPDATE spots SET status = 'pending' WHERE id = $1", [spotId]);
    await tasks.submitForSpot({ spotId, openid: 'test', photoKeys: ['a', 'b'] });
    await tasks.applyVerdict('test-trace-1', 'pass');
    expect((await db.queryOne<{ status: string }>('SELECT status FROM spots WHERE id = $1', [spotId]))!.status).toBe('pending');
    await tasks.applyVerdict('test-trace-2', 'pass');
    await tasks.applyVerdict('test-trace-2', 'risky'); // Duplicate callback cannot replace final verdict.
    expect((await db.queryOne<{ status: string }>('SELECT status FROM spots WHERE id = $1', [spotId]))!.status).toBe('active');
    await db.query("UPDATE spots SET status = 'pending' WHERE id = $1", [spotId]);
    submit.mockResolvedValueOnce(null);
    await tasks.submitForSpot({ spotId, openid: 'test', photoKeys: ['failed'] });
    expect((await db.queryOne<{ status: string }>('SELECT status FROM spots WHERE id = $1', [spotId]))!.status).toBe('hidden');
    await db.query("DELETE FROM content_check_tasks WHERE spot_id = $1", [spotId]);
    await db.query("UPDATE spots SET status = 'pending' WHERE id = $1", [spotId]);
    await db.query(`INSERT INTO content_check_tasks (id, spot_id, status, created_at)
      VALUES ($1, $2, 'pending', TIMESTAMPADD(MINUTE, -20, now()))`, [randomUUID(), spotId]);
    expect(await tasks.sweepTimeouts()).toBe(1);
    expect((await db.queryOne<{ status: string }>('SELECT status FROM spots WHERE id = $1', [spotId]))!.status).toBe('hidden');
    readiness.mockRestore(); submit.mockRestore();
    await app.get(ModerationService).setStatus(spotId, 'active');
    const uploads = app.get(UploadsService);
    const signed = await uploads.signUploads(ownerId, [{ mime: 'image/jpeg', size: 1 }]);
    await db.query('UPDATE upload_tickets SET created_at = TIMESTAMPADD(HOUR, -48, now()) WHERE object_key = $1', [signed.keys[0]]);
    expect(await uploads.cleanupOrphans()).toEqual({ removed: 1 });
    expect(await db.queryOne('SELECT id FROM upload_tickets WHERE object_key = $1', [signed.keys[0]])).toBeNull();
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
