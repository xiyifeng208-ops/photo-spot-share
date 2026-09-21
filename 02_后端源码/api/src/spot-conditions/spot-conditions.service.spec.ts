import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DatabaseService } from '../database/database.service';
import { FEEDBACK_KINDS, FEEDBACK_LABELS, ListFeedbackDto, PutFeedbackDto } from './spot-conditions.dto';
import { parseFeedbackCursor, parseFeedbackLimit, SpotConditionsService } from './spot-conditions.service';
import { SpotConditionsController } from './spot-conditions.controller';
import { RATE_LIMIT_KEY } from '../common/guards/rate-limit.guard';
import { IS_PUBLIC_KEY } from '../common/guards/jwt-auth.guard';

const spotId = '11111111-1111-4111-8111-000000000001';
const userId = '22222222-2222-4222-8222-000000000001';
const row = (suffix = '1', owner = userId) => ({
  id: `33333333-3333-4333-8333-00000000000${suffix}`,
  user_id: owner, kind: 'still_accessible', updated_at: new Date('2026-09-18T00:00:00.123Z'),
});
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const validCursor = () => ({ v: 1, spotId, at: '2026-09-18T00:00:00.123Z', id: row().id });
function harness(results: unknown[][]) {
  const query = jest.fn();
  results.forEach(rows => query.mockResolvedValueOnce({ rows }));
  const db = { withTransaction: jest.fn(async (callback: (client: unknown) => unknown) => callback({ query })) };
  return { service: new SpotConditionsService(db as unknown as DatabaseService), query, db };
}

describe('近期机位反馈输入', () => {
  it.each(FEEDBACK_KINDS)('固定选项 %s 有中文标签且可提交', async kind => {
    expect(FEEDBACK_LABELS[kind]).toBeTruthy();
    expect(await validate(plainToInstance(PutFeedbackDto, { kind }))).toHaveLength(0);
  });
  it.each([undefined, null, '', 'blocked', 'still_accessible,obstructed', [], 1, {}])('拒绝非法反馈 %j', async kind => {
    expect((await validate(plainToInstance(PutFeedbackDto, { kind }))).length).toBeGreaterThan(0);
  });
  it('默认 5 项，允许 1 和 20 项', () => {
    expect(parseFeedbackLimit()).toBe(5);
    expect(parseFeedbackLimit('1')).toBe(1);
    expect(parseFeedbackLimit('20')).toBe(20);
  });
  it.each(['0', '21', '-1', '1.5', '01', '1e1', '', 'five', ' 5 ', null, ['1']])('拒绝非法 limit %j', async limit => {
    expect(() => parseFeedbackLimit(limit as string)).toThrow();
    if (limit !== null) expect((await validate(plainToInstance(ListFeedbackDto, { limit }))).length).toBeGreaterThan(0);
  });
  it('游标原样保留毫秒及作品作用域', () => {
    expect(parseFeedbackCursor(undefined, spotId)).toBeNull();
    expect(parseFeedbackCursor(encode(validCursor()), spotId)).toEqual(validCursor());
  });
  it.each([
    '', 'not-json', 'x'.repeat(513),
    encode(null), encode([]), encode({}),
    encode({ ...validCursor(), v: 2 }),
    encode({ ...validCursor(), spotId: userId }),
    encode({ ...validCursor(), id: "' OR 1=1" }),
    encode({ ...validCursor(), at: '2026-09-18T00:00:00Z' }),
    encode({ ...validCursor(), at: '2026-02-30T00:00:00.123Z' }),
    encode({ ...validCursor(), at: 1 }),
  ])('拒绝损坏、越界或跨作品游标 %s', cursor => {
    expect(() => parseFeedbackCursor(cursor, spotId)).toThrow();
  });
  it('写入限流为每用户及接口 20 次/小时，只有读取公开', () => {
    const proto = SpotConditionsController.prototype;
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, proto.put)).toEqual({ scope: 'user-and-route', limit: 20, windowMs: 3600000 });
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.list)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.put)).toBeUndefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.remove)).toBeUndefined();
  });
});

describe('近期机位反馈服务', () => {
  it('匿名读取不查询本人信息，输出不泄露身份', async () => {
    const h = harness([[{ id: spotId }], [row()]]);
    const result = await h.service.list(spotId);
    expect(result).toEqual({ items: [{ id: row().id, kind: 'still_accessible', label: '仍可拍摄', updatedAt: row().updated_at.toISOString(), isMine: false }], nextCursor: null, myFeedback: null, windowDays: 30 });
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.query.mock.calls[0][0]).toContain("status='active' FOR SHARE");
    expect(JSON.stringify(result)).not.toContain(userId);
    expect(JSON.stringify(result)).not.toContain('nickname');
  });
  it('本人反馈独立于分页，返回稳定的下一页游标', async () => {
    const h = harness([[{ id: spotId }], [row('3'), row('2', spotId), row('1')], [row('1')]]);
    const result = await h.service.list(spotId, userId, undefined, '2');
    expect(result.items.map(item => item.id)).toEqual([row('3').id, row('2').id]);
    expect(result.items.map(item => item.isMine)).toEqual([true, false]);
    expect(result.myFeedback?.id).toBe(row('1').id);
    expect(parseFeedbackCursor(result.nextCursor!, spotId)).toEqual({ ...validCursor(), id: row('2').id });
    expect(h.query.mock.calls[1][1][2]).toBe(3);
    expect(h.query.mock.calls[2][1][2]).toBe(h.query.mock.calls[1][1][1]);
  });
  it('下一页采用参数化时间和 ID，限定同一个作品', async () => {
    const h = harness([[{ id: spotId }], []]);
    await h.service.list(spotId, undefined, encode(validCursor()), '20');
    expect(h.query.mock.calls[1][0]).toContain('(updated_at, id) < ($3::timestamptz, $4::uuid)');
    expect(h.query.mock.calls[1][1]).toEqual([spotId, expect.any(Date), validCursor().at, row().id, 21]);
  });
  it('过期本人反馈不返回 myFeedback', async () => {
    const h = harness([[{ id: spotId }], [], []]);
    expect((await h.service.list(spotId, userId)).myFeedback).toBeNull();
    expect(h.query.mock.calls[2][0]).toContain('updated_at >= $3');
  });
  it('30 天窗口以一次请求时刻计算，列表与本人信息使用相同边界', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-18T03:04:05.006Z'));
    try {
      const h = harness([[{ id: spotId }], [], []]);
      await h.service.list(spotId, userId);
      expect(now).toHaveBeenCalledTimes(1);
      expect(h.query.mock.calls[1][1][1].toISOString()).toBe('2026-08-19T03:04:05.006Z');
      expect(h.query.mock.calls[2][1][2]).toBe(h.query.mock.calls[1][1][1]);
    } finally { now.mockRestore(); }
  });
  it.each(['list', 'put', 'remove'] as const)('非公开作品 %s 返回 404，不读取或修改反馈', async method => {
    const h = harness([[]]);
    const operation = method === 'list' ? h.service.list(spotId) : method === 'put'
      ? h.service.put(spotId, userId, 'obstructed') : h.service.remove(spotId, userId);
    await expect(operation).rejects.toMatchObject({ status: 404 });
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it('更新仅 upsert 反馈，不更改作品内容/状态/浏览量', async () => {
    const h = harness([[{ id: spotId }], [row()]]);
    expect((await h.service.put(spotId, userId, 'still_accessible')).feedback.isMine).toBe(true);
    expect(h.query.mock.calls[1][0]).toContain('ON CONFLICT (user_id,spot_id) DO UPDATE');
    expect(h.query.mock.calls[1][1]).toEqual([spotId, userId, 'still_accessible']);
    expect(h.query.mock.calls.every(([sql]) => !/UPDATE spots/i.test(sql))).toBe(true);
  });
  it('取消只按当前鉴权身份删除，不依赖反馈是否存在', async () => {
    const h = harness([[{ id: spotId }], []]);
    expect(await h.service.remove(spotId, userId)).toEqual({ removed: true });
    expect(h.query.mock.calls[1]).toEqual(['DELETE FROM spot_conditions WHERE spot_id=$1 AND user_id=$2', [spotId, userId]]);
  });
  it('无效输入在访问数据库前拒绝', async () => {
    const h = harness([]);
    await expect(h.service.put(spotId, userId, 'bad' as never)).rejects.toMatchObject({ status: 400 });
    await expect(h.service.list(spotId, undefined, undefined, '500')).rejects.toMatchObject({ status: 400 });
    expect(h.db.withTransaction).not.toHaveBeenCalled();
  });
});
