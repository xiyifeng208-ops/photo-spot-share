import { decodeFeedCursor, encodeFeedCursor, type FeedCursor } from './feed-cursor.util';
const cursor: FeedCursor = { createdAt: '2026-09-18T01:02:03.123456Z', id: '11111111-1111-4111-8111-000000000001', favoriteCount: 3 };
const jsonCursor = (extra: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ v: 1, mode: 'search-favorites', ...cursor, ...extra })).toString('base64url');
const raw = (value: string) => Buffer.from(value).toString('base64url');

describe('发现流收藏排序专用游标', () => {
  it('搜索保存真实计数与六位微秒', () => {
    expect(decodeFeedCursor(encodeFeedCursor(cursor, 'favorites'), 'favorites')).toEqual(cursor);
    expect(decodeFeedCursor(jsonCursor({ favoriteCount: 0 }), 'favorites')?.favoriteCount).toBe(0);
  });
  it('普通流保持旧编码兼容，同时支持精确微秒', () => {
    const expected = { createdAt: cursor.createdAt, id: cursor.id };
    expect(decodeFeedCursor(encodeFeedCursor(cursor, 'latest'), 'latest')).toEqual(expected);
    const old = { ...expected, createdAt: '2026-09-18T01:02:03.123Z' };
    expect(decodeFeedCursor(encodeFeedCursor(old, 'latest'), 'latest')).toEqual(old);
  });
  it.each(['latest', 'favorites'] as const)('省略或空字符串游标都表示 %s 第一页，保持旧客户端兼容', mode => {
    expect(decodeFeedCursor(undefined, mode)).toBeNull();
    expect(decodeFeedCursor('', mode)).toBeNull();
  });
  it('搜索与普通流的游标不能交叉使用', () => {
    expect(() => decodeFeedCursor(encodeFeedCursor(cursor, 'latest'), 'favorites')).toThrow();
    expect(() => decodeFeedCursor(encodeFeedCursor(cursor, 'favorites'), 'latest')).toThrow();
  });
  it.each([-1, 0.5, '3', null, undefined, Number.MAX_SAFE_INTEGER + 1])('非法收藏数 %j 返回400', favoriteCount => {
    expect(() => decodeFeedCursor(jsonCursor({ favoriteCount }), 'favorites')).toThrow('分页游标无效');
  });
  it.each([
    { v: 2 }, { mode: 'latest' }, { mode: null }, { id: 'bad-id' }, { id: "' OR 1=1" },
    { createdAt: '2026-02-30T01:02:03.123456Z' }, { createdAt: '2026-09-18T24:00:00.123456Z' },
    { createdAt: '2026-09-18T01:02:03.1234567Z' }, { createdAt: '0000-09-18T01:02:03.123456Z' },
    { createdAt: '2026-09-18' }, { createdAt: 'tomorrow' }, { createdAt: null },
  ])('非法搜索模式/UUID/日期 %j 被拒绝', extra => {
    expect(() => decodeFeedCursor(jsonCursor(extra), 'favorites')).toThrow('分页游标无效');
  });
  it.each(['!', 'bad', 'x'.repeat(513), raw('null'), raw('[]'), raw('{}'), jsonCursor() + '='])('损坏或超长搜索游标被拒绝 %s', value => {
    expect(() => decodeFeedCursor(value, 'favorites')).toThrow();
  });
  it.each([
    `2026-02-30T01:02:03.123Z|${cursor.id}`, `${cursor.createdAt}|bad-id`, `${cursor.createdAt}|${cursor.id}|extra`,
  ])('普通流的非法游标也在访问数据库前拒绝：%s', value => {
    expect(() => decodeFeedCursor(raw(value), 'latest')).toThrow();
  });
});
