import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { runMigrations } from '../database/migration-runner';
import { parseShootingDate } from './solar-calculator';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDb = databaseUrl ? describe : describe.skip;

describeWithDb('拍摄时间公开只读接口 (隔离数据库 e2e)', () => {
  let app: INestApplication;
  let db: Client;
  let ownerId: string;
  let ownerToken: string;
  const ids = Object.fromEntries(['active', 'hidden', 'pending', 'deleted'].map(status => [status, randomUUID()]));

  beforeAll(async () => {
    if (!/^\/spot_test_[a-z0-9_]+$/i.test(new URL(databaseUrl!).pathname)) throw new Error('拍摄时间测试只允许独立 spot_test_ 数据库');
    process.env.NODE_ENV = 'test'; process.env.DATABASE_URL = databaseUrl; process.env.DATABASE_SSL = 'false';
    process.env.AUTH_DEV_MODE = 'true'; process.env.CONTENT_CHECK_ENABLED = 'false';
    process.env.STORAGE_DRIVER = 'local'; process.env.AMAP_KEY = '';
    await runMigrations(databaseUrl!, () => undefined);
    db = new Client({ connectionString: databaseUrl }); await db.connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication(); app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter()); app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    const response = await request(app.getHttpServer()).post('/api/v1/auth/wx-login')
      .send({ code: `dev:shooting-times-${randomUUID()}` }).expect(201);
    ownerId = response.body.data.user.id; ownerToken = response.body.data.token;
    for (const [status, id] of Object.entries(ids)) {
      await db.query(`INSERT INTO spots (id,user_id,title,province,city,status,lat,lng,location,view_count)
        VALUES ($1,$2,'拍摄时间测试','上海市','上海市',$3,31.2304,121.4737,
          ST_SetSRID(ST_MakePoint(121.4737,31.2304),4326),12)`, [id, ownerId, status]);
    }
  }, 60000);

  afterAll(async () => {
    await app?.close();
    if (db) {
      if (ownerId) await db.query('DELETE FROM users WHERE id = $1', [ownerId]);
      await db.end();
    }
  });
  const endpoint = (id: string = ids.active) => request(app.getHttpServer()).get(`/api/v1/spots/${id}/shooting-times`);

  it('匿名读取公开机位，返回北京时间完整 ISO 和四组时段', async () => {
    const response = await endpoint().query({ date: '2026-06-21' }).expect(200);
    expect(response.body.data).toMatchObject({ date: '2026-06-21', timeZone: 'Asia/Shanghai' });
    expect(response.body.data.sunrise).toMatch(/^2026-06-21T04:50:\d{2}\+08:00$/);
    for (const key of ['goldenMorning', 'goldenEvening', 'blueMorning', 'blueEvening']) {
      expect(response.body.data[key]).toEqual({ start: expect.stringContaining('+08:00'), end: expect.stringContaining('+08:00') });
    }
  });
  it('省略日期使用北京时间今天', async () => {
    const before = parseShootingDate(undefined);
    const response = await endpoint().expect(200);
    expect([before, parseShootingDate(undefined)]).toContain(response.body.data.date);
  });
  it.each(['', '2026-02-30', '2026-9-18', '1999-12-31', '2101-01-01'])('非法日期返回 400：%s', async date => {
    await endpoint().query({ date }).expect(400);
  });
  it('重复 date 参数不是任意选择一个日期', async () => {
    await endpoint().query('date=2026-09-18&date=2026-09-19').expect(400);
  });
  it.each(['hidden', 'pending', 'deleted'])('不向匿名用户或作者透露非公开机位：%s', async status => {
    await endpoint(ids[status]).query({ date: '2026-09-18' }).expect(404);
    await endpoint(ids[status]).set('Authorization', `Bearer ${ownerToken}`).query({ date: '2026-09-18' }).expect(404);
  });
  it('缺失及非法作品 ID 返回 404', async () => {
    await endpoint(randomUUID()).expect(404); await endpoint('not-a-uuid').expect(404);
  });
  it('读取不同日期不增加浏览量或修改作品', async () => {
    const before = await db.query('SELECT row_to_json(s) AS row FROM spots s WHERE id=$1', [ids.active]);
    await endpoint().query({ date: '2026-06-21' }).expect(200);
    await endpoint().query({ date: '2026-12-21' }).expect(200);
    const after = await db.query('SELECT row_to_json(s) AS row FROM spots s WHERE id=$1', [ids.active]);
    expect(after.rows).toEqual(before.rows);
  });
  it('隐藏与恢复公开立即生效，不缓存过期公开权限', async () => {
    try {
      await db.query("UPDATE spots SET status='hidden' WHERE id=$1", [ids.active]);
      await endpoint().expect(404);
    } finally {
      await db.query("UPDATE spots SET status='active' WHERE id=$1", [ids.active]);
    }
    await endpoint().expect(200);
  });
});
