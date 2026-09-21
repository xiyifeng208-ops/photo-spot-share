import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { runMigrations } from '../database/migration-runner';
import { SpotsService } from './spots.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDb = databaseUrl ? describe : describe.skip;

describeWithDb('信息修正与可空难度 (隔离数据库 e2e)', () => {
  let app: INestApplication;
  let db: Client;
  let token: string;
  let userId: string;
  let spotId: string;
  const prefix = `meta-${randomUUID()}`;
  const geo = { province: '上海市', city: '上海市', district: '黄浦区', address: '测试入口' };

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.includes('_test')) throw new Error('只允许独立的 _test 数据库');
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: databaseUrl, DATABASE_SSL: 'false', AUTH_DEV_MODE: 'true',
      CONTENT_CHECK_ENABLED: 'false', AMAP_KEY: '', STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'spot-metadata-')),
    });
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
    const login = await request(app.getHttpServer()).post('/api/v1/auth/wx-login')
      .send({ code: `dev:${prefix}` }).expect(201);
    token = login.body.data.token;
    userId = login.body.data.user.id;
  }, 60000);

  beforeEach(async () => {
    spotId = randomUUID();
    await db.query(`INSERT INTO spots (id,user_id,title,province,city,district,address,
      heading,best_times,best_seasons,focal_length,difficulty,access_note,lat,lng,location)
      VALUES ($1,$2,$3,'上海市','上海市','黄浦区','测试入口','NE',ARRAY['night']::spot_best_time[],
        ARRAY['winter']::spot_season[],'tele',2,'旧到达说明',31.23,121.49,
        ST_SetSRID(ST_MakePoint(121.49,31.23),4326))`, [spotId, userId, `${prefix}-${spotId}`]);
  });

  afterEach(async () => {
    await db.query('DELETE FROM spots WHERE user_id=$1', [userId]);
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      if (userId) await db.query('DELETE FROM users WHERE id=$1', [userId]);
      await db.end();
    }
  });

  const patch = (payload: object) => request(app.getHttpServer()).patch(`/api/v1/spots/${spotId}`)
    .set('Authorization', `Bearer ${token}`).send(payload);
  const feed = (query: object = {}) => request(app.getHttpServer()).get('/api/v1/spots/feed')
    .query({ keyword: prefix, ...query });
  const ids = (response: request.Response) => response.body.data.items.map((item: { id: string }) => item.id);
  const stored = async () => (await db.query('SELECT * FROM spots WHERE id=$1', [spotId])).rows[0];

  async function create(payload: object = {}) {
    const signed = await request(app.getHttpServer()).post('/api/v1/uploads/photos/sign')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ mime: 'image/jpeg', size: 8, width: 1, height: 1 }] }).expect(201);
    const key = signed.body.data.keys[0];
    await request(app.getHttpServer()).post('/api/v1/uploads/local')
      .set('Authorization', `Bearer ${token}`).field('key', key)
      .attach('file', Buffer.from('jpegtest'), 'sample.jpg').expect(201);
    return request(app.getHttpServer()).post('/api/v1/spots').set('Authorization', `Bearer ${token}`)
      .send({ title: `${prefix.slice(0, 20)}-新作品`, lat: 31.23, lng: 121.49, photoKeys: [key], geo, ...payload });
  }

  it('PATCH clears all optional metadata explicitly and filters stop matching', async () => {
    const cleared = await patch({ bestTimes: [], bestSeasons: [], heading: null,
      focalLength: null, difficulty: null, accessNote: null }).expect(200);
    expect(cleared.body.data).toMatchObject({ bestTimes: [], bestSeasons: [], heading: null,
      focalLength: null, difficulty: null, difficultyLabel: '暂不确定', accessNote: null });
    expect((await stored()).difficulty).toBeNull();
    for (const condition of [{ bestTimes: 'night' }, { bestSeasons: 'winter' },
      { focalLengths: 'tele' }, { difficulties: '1,2,3' }]) {
      expect(ids(await feed(condition).expect(200))).not.toContain(spotId);
    }
    expect(ids(await feed().expect(200))).toContain(spotId);
  });

  it('PATCH omissions preserve scalar values, tags, address and legacy incomplete regions', async () => {
    await db.query('UPDATE spots SET province=NULL,city=NULL,district=NULL WHERE id=$1', [spotId]);
    await patch({ description: '新增拍摄说明', lat: 31.23, lng: 121.49 }).expect(200);
    expect(await stored()).toMatchObject({ description: '新增拍摄说明', province: null,
      city: null, district: null, heading: 'NE', difficulty: 2, access_note: '旧到达说明' });
  });

  it('empty accessNote clears persisted text and an empty description is valid', async () => {
    await patch({ accessNote: '', description: '' }).expect(200);
    expect(await stored()).toMatchObject({ access_note: null, description: '' });
  });

  it.each(['title', 'description', 'lat', 'lng', 'geo', 'bestTimes', 'bestSeasons', 'photoKeys'])(
    'null %s is a 400 and leaves existing metadata intact', async field => {
      await patch({ [field]: null }).expect(400);
      expect((await stored()).difficulty).toBe(2);
    },
  );

  it('unknown new difficulty defaults to null with no upstream key', async () => {
    const created = await create();
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ difficulty: null, difficultyLabel: '暂不确定', ...geo });
  });

  it('new manually entered province/city and direct county normalize without a key', async () => {
    const direct = await create({ geo: { province: '湖北省', city: null, district: '仙桃市', address: '手填入口' } });
    expect(direct.status).toBe(201);
    expect(direct.body.data).toMatchObject({ province: '湖北省', city: null, district: '仙桃市' });
    const municipality = await create({ geo: { province: '重庆市', address: '手填入口' } });
    expect(municipality.status).toBe(201);
    expect(municipality.body.data).toMatchObject({ province: '重庆市', city: '重庆市' });
  });

  it('new address-only work is rejected when no reverse lookup can supply the region', async () => {
    const rejected = await create({ geo: { address: '只有街道没有城市' } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toContain('手动确认完整');
  });

  it('changing province replaces stale lower regions and works with city/keyword filtering', async () => {
    await patch({ geo: { province: '湖北省', city: null, district: '仙桃市', address: '手填入口' } }).expect(200);
    expect(await stored()).toMatchObject({ province: '湖北省', city: null, district: '仙桃市', address: '手填入口' });
    expect(ids(await feed({ province: '湖北省', district: '仙桃市', bestTimes: 'night', difficulties: '2' }).expect(200)))
      .toContain(spotId);
    expect(ids(await feed({ city: '上海市' }).expect(200))).not.toContain(spotId);
  });

  it('changing coordinates requires a complete region and does not reuse the old one', async () => {
    await patch({ lat: 30.2, lng: 120.1 }).expect(400);
    expect(await stored()).toMatchObject({ lat: 31.23, lng: 121.49, city: '上海市' });
    await patch({ lat: 30.2, lng: 120.1, geo: { province: '浙江省', city: '杭州市', address: '手填入口' } }).expect(200);
    expect(await stored()).toMatchObject({ lat: 30.2, lng: 120.1, province: '浙江省', city: '杭州市', district: null });
  });

  it('province-only changes cannot carry an old city across provinces', async () => {
    await patch({ geo: { province: '浙江省' } }).expect(400);
    expect((await stored()).city).toBe('上海市');
  });

  it('read-only route batches return only public rows and never change views', async () => {
    const service = app.get(SpotsService);
    const before = (await stored()).view_count;
    expect(await service.findPublicByIds([spotId, spotId])).toHaveLength(1);
    expect((await stored()).view_count).toBe(before);
    for (const status of ['hidden', 'pending', 'deleted']) {
      await db.query('UPDATE spots SET status=$2 WHERE id=$1', [spotId, status]);
      expect(await service.findPublicByIds([spotId])).toEqual([]);
    }
    await db.query("UPDATE spots SET status='active' WHERE id=$1", [spotId]);
    expect(await service.findPublicByIds([spotId])).toHaveLength(1);
  });

  it('idempotent migration preserves previous difficulty values and removes its old default', async () => {
    await runMigrations(databaseUrl!, () => undefined);
    expect((await stored()).difficulty).toBe(2);
    const column = (await db.query(`SELECT is_nullable,column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='spots' AND column_name='difficulty'`)).rows[0];
    expect(column).toEqual({ is_nullable: 'YES', column_default: null });
  });
});
