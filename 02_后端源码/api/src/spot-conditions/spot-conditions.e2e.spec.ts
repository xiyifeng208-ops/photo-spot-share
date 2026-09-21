import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Client } from 'pg';
import { AppModule } from '../app.module';
import { TokenService } from '../auth/token.service';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { runMigrations } from '../database/migration-runner';
import { SpotConditionsModule } from './spot-conditions.module';
import { FEEDBACK_KINDS } from './spot-conditions.dto';

const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;

describeWithDb('近期机位反馈 (隔离数据库 e2e)', () => {
  let app: INestApplication;
  let db: Client;
  let tokenService: TokenService;
  const ownerId = randomUUID();
  const userIds = [ownerId];
  const spotIds: string[] = Array.from({ length: 5 }, () => randomUUID());
  let actor: { id: string; token: string };
  let ownerToken: string;
  async function addUser() {
    const id = randomUUID();
    userIds.push(id);
    const openid = `feedback-test:${id}`;
    await db.query('INSERT INTO users (id,openid,nickname) VALUES ($1,$2,$3)', [id, openid, '不应泄露的反馈用户昵称']);
    return { id, token: tokenService.sign(id, openid) };
  }

  beforeAll(async () => {
    if (!/^\/spot_test_[a-z0-9_]+$/.test(new URL(url!).pathname)) throw new Error('机位反馈测试只允许独立 spot_test_ 数据库');
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
    await db.query('INSERT INTO users (id,openid) VALUES ($1,$2)', [ownerId, `feedback-owner:${ownerId}`]);
    for (const [index, status] of ['active', 'hidden', 'pending', 'deleted', 'active'].entries()) {
      await db.query(`INSERT INTO spots (id,user_id,title,status,lat,lng,location,view_count)
        VALUES ($1,$2,'反馈隔离测试',$3,31.23,121.49,ST_SetSRID(ST_MakePoint(121.49,31.23),4326),19)`, [spotIds[index], ownerId, status]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, SpotConditionsModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    tokenService = app.get(TokenService);
    ownerToken = tokenService.sign(ownerId, `feedback-owner:${ownerId}`);
  }, 60000);
  beforeEach(async () => {
    await db.query('DELETE FROM spot_conditions WHERE spot_id=ANY($1::uuid[])', [spotIds]);
    await db.query("UPDATE spots SET status='active' WHERE id=$1", [spotIds[0]]);
    actor = await addUser();
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]);
      await db.end();
    }
  });
  const list = (query: Record<string, unknown> = {}, token?: string, spot = spotIds[0]) => {
    const req = request(app.getHttpServer()).get(`/api/v1/spots/${spot}/feedback`).query(query);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const put = (kind: unknown = 'still_accessible', token = actor.token, spot = spotIds[0], extra = {}) => request(app.getHttpServer())
    .put(`/api/v1/spots/${spot}/feedback`).set('Authorization', `Bearer ${token}`).send({ kind, ...extra });
  const remove = (token = actor.token, spot = spotIds[0]) => request(app.getHttpServer())
    .delete(`/api/v1/spots/${spot}/feedback`).set('Authorization', `Bearer ${token}`);
  async function insertFeedback(userId: string, ageDays = 1, kind = 'still_accessible', spot = spotIds[0]) {
    const result = await db.query(`INSERT INTO spot_conditions (user_id,spot_id,kind,updated_at)
      VALUES ($1,$2,$3,now()-$4::int * interval '1 day') RETURNING id`, [userId, spot, kind, ageDays]);
    return result.rows[0].id as string;
  }

  it('匿名可读空列表，写入和撤回必须登录', async () => {
    expect((await list().expect(200)).body.data).toEqual({ items: [], myFeedback: null, nextCursor: null, windowDays: 30 });
    await request(app.getHttpServer()).put(`/api/v1/spots/${spotIds[0]}/feedback`).send({ kind: 'obstructed' }).expect(401);
    await request(app.getHttpServer()).delete(`/api/v1/spots/${spotIds[0]}/feedback`).expect(401);
  });
  it('允许作者反馈自己的公开机位，返回固定标签而非昵称身份', async () => {
    const result = await put('still_accessible', ownerToken).expect(200);
    expect(result.body.data.feedback).toMatchObject({ kind: 'still_accessible', label: '仍可拍摄', isMine: true });
    const response = await list().expect(200);
    expect(response.body.data.items[0].isMine).toBe(false);
    expect(response.body.data.myFeedback).toBeNull();
    expect(Object.keys(response.body.data.items[0]).sort()).toEqual(['id', 'isMine', 'kind', 'label', 'updatedAt'].sort());
    expect(JSON.stringify(response.body.data)).not.toContain(ownerId);
    expect(JSON.stringify(response.body.data)).not.toContain('不应泄露');
  });
  it.each(FEEDBACK_KINDS)('接受固定反馈类型 %s', async kind => {
    expect((await put(kind).expect(200)).body.data.feedback.kind).toBe(kind);
  });
  it('每人每机位保留一条最新反馈，再次提交保留 ID 并更新时间', async () => {
    const first = (await put('still_accessible').expect(200)).body.data.feedback;
    await db.query("UPDATE spot_conditions SET updated_at=now()-interval '2 days' WHERE id=$1", [first.id]);
    const second = (await put('obstructed').expect(200)).body.data.feedback;
    expect(second.id).toBe(first.id);
    expect(second.label).toBe('现场遮挡');
    expect(Date.now() - Date.parse(second.updatedAt)).toBeLessThan(10000);
    expect((await db.query('SELECT * FROM spot_conditions WHERE user_id=$1 AND spot_id=$2', [actor.id, spotIds[0]])).rows).toHaveLength(1);
  });
  it('同时提交不会生成重复反馈', async () => {
    const responses = await Promise.all([put(), put(), put()]);
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
    expect(new Set(responses.map(response => response.body.data.feedback.id)).size).toBe(1);
  });
  it('客户端不能伪造用户，修改和删除仅影响本人', async () => {
    const other = await addUser();
    await put('obstructed', other.token).expect(200);
    await put('location_changed', actor.token, spotIds[0], { userId: other.id, user_id: other.id }).expect(200);
    const result = (await list({}, actor.token).expect(200)).body.data;
    expect(result.items).toHaveLength(2);
    expect(result.myFeedback.kind).toBe('location_changed');
    expect(result.items.filter((item: { isMine: boolean }) => item.isMine)).toHaveLength(1);
    await remove().send({ userId: other.id }).expect(200);
    const remaining = (await list({}, other.token).expect(200)).body.data;
    expect(remaining.items).toHaveLength(1);
    expect(remaining.myFeedback.kind).toBe('obstructed');
  });
  it('撤回幂等，过期记录也可以撤回', async () => {
    await insertFeedback(actor.id, 31);
    expect((await remove().expect(200)).body.data).toEqual({ removed: true });
    expect((await remove().expect(200)).body.data).toEqual({ removed: true });
    expect((await db.query('SELECT id FROM spot_conditions WHERE user_id=$1', [actor.id])).rows).toHaveLength(0);
  });
  it('只显示近 30 天反馈，本人过期记录重新提交后恢复显示', async () => {
    await insertFeedback(actor.id, 31);
    const other = await addUser();
    await insertFeedback(other.id, 29, 'access_restricted');
    const previous = (await list({}, actor.token).expect(200)).body.data;
    expect(previous.items).toHaveLength(1);
    expect(previous.myFeedback).toBeNull();
    await put('still_accessible').expect(200);
    const current = (await list({}, actor.token).expect(200)).body.data;
    expect(current.items).toHaveLength(2);
    expect(current.myFeedback.kind).toBe('still_accessible');
  });
  it('相同毫秒反馈按 ID 稳定分页，本人反馈不受当前页影响', async () => {
    const feedbackIds = [await insertFeedback(actor.id)];
    for (let index = 0; index < 6; index++) feedbackIds.push(await insertFeedback((await addUser()).id));
    await db.query("UPDATE spot_conditions SET updated_at=date_trunc('second',now()) WHERE spot_id=$1", [spotIds[0]]);
    const expected = feedbackIds.sort().reverse();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const result: { items: { id: string }[]; myFeedback: { isMine: boolean }; nextCursor: string | null } =
        (await list({ limit: '2', ...(cursor ? { cursor } : {}) }, actor.token).expect(200)).body.data;
      seen.push(...result.items.map((item: { id: string }) => item.id));
      expect(result.myFeedback.isMine).toBe(true);
      cursor = result.nextCursor;
      expect(seen.length).toBeLessThanOrEqual(7);
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(7);
    expect((await list().expect(200)).body.data.items).toHaveLength(5);
    expect((await list({ limit: '20' }).expect(200)).body.data.items).toHaveLength(7);
  });
  it.each(['hidden', 'pending', 'deleted', 'missing'])('%s 机位拒绝读取/提交/撤回，包括作者本人', async status => {
    const id = status === 'missing' ? randomUUID() : spotIds[['active', 'hidden', 'pending', 'deleted'].indexOf(status)];
    await list({}, undefined, id).expect(404);
    await list({}, ownerToken, id).expect(404);
    await put('still_accessible', ownerToken, id).expect(404);
    await remove(ownerToken, id).expect(404);
  });
  it('公开状态恢复后反馈再次出现，不改变已有反馈', async () => {
    await put().expect(200);
    await db.query("UPDATE spots SET status='hidden' WHERE id=$1", [spotIds[0]]);
    await list().expect(404);
    await db.query("UPDATE spots SET status='active' WHERE id=$1", [spotIds[0]]);
    expect((await list().expect(200)).body.data.items).toHaveLength(1);
  });
  it('非法类型、游标、分页和作品 ID 被拒绝', async () => {
    await request(app.getHttpServer()).put(`/api/v1/spots/${spotIds[0]}/feedback`)
      .set('Authorization', `Bearer ${actor.token}`).send({}).expect(400);
    for (const kind of [null, '', 'closed', 'obstructed,still_accessible', [], 1]) await put(kind).expect(400);
    for (const limit of ['0', '21', '-1', '1.5', '01', '1e1', '']) await list({ limit }).expect(400);
    await list({ cursor: 'not-valid' }).expect(400);
    await list({ cursor: 'x'.repeat(513) }).expect(400);
    await list({}, undefined, 'bad-id').expect(404);
    await list({ limit: ['1', '2'] }).expect(400);
  });
  it('游标不能用于其他作品', async () => {
    await insertFeedback(actor.id);
    await insertFeedback((await addUser()).id);
    const cursor = (await list({ limit: '1' }).expect(200)).body.data.nextCursor;
    await list({ cursor }, undefined, spotIds[4]).expect(400);
  });
  it('提交读取撤回不改变机位状态、元信息或浏览量', async () => {
    const readSpot = async () => (await db.query('SELECT row_to_json(s) AS value FROM spots s WHERE id=$1', [spotIds[0]])).rows[0].value;
    const baseline = await readSpot();
    await put('access_restricted').expect(200);
    await list().expect(200);
    await list({}, actor.token).expect(200);
    await remove().expect(200);
    expect(await readSpot()).toEqual(baseline);
    expect(baseline.status).toBe('active');
    expect(baseline.view_count).toBe(19);
  });
  it('每用户该接口每小时最多提交 20 次，其他账号不受影响', async () => {
    for (let index = 0; index < 20; index++) await put().expect(200);
    await put().expect(429);
    await put('obstructed', actor.token, spotIds[4]).expect(429);
    await put('obstructed', (await addUser()).token).expect(200);
    await remove().expect(200);
    await list().expect(200);
  });
  it('数据库约束拒绝非法类型，物理删除用户自动清理反馈', async () => {
    await expect(insertFeedback(actor.id, 1, 'invented')).rejects.toMatchObject({ code: '23514' });
    await put().expect(200);
    await db.query('DELETE FROM users WHERE id=$1', [actor.id]);
    expect((await list().expect(200)).body.data.items).toHaveLength(0);
  });
});
