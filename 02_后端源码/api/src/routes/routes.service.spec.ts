import { SpotsService, type SpotSummary } from '../spots/spots.service';
import { ROUTE_CATALOG, type CuratedRoute, validateRouteCatalog } from './routes.catalog';
import { RoutesService } from './routes.service';

const catalog = (): CuratedRoute[] => JSON.parse(JSON.stringify(ROUTE_CATALOG));
function spot(index: number, extra: Partial<SpotSummary> = {}): SpotSummary {
  return {
    id: ROUTE_CATALOG[0].stops[index].spotId, status: 'active', title: `机位 ${index}`,
    province: '上海市', city: '上海市', district: '测试区', lat: 31, lng: 121,
    difficulty: null, difficultyLabel: '未知', heading: null, headingLabel: null,
    bestTimes: [], bestTimeLabels: [], coverUrl: `https://test.invalid/${index}.jpg`,
    distanceMeters: null, author: { nickname: null, avatarUrl: null }, createdAt: '2026-09-18T00:00:00Z', favoriteCount: 0,
    ...extra,
  };
}
function harness(items = [spot(2), spot(0), spot(1)], config = catalog()) {
  const findPublicByIds = jest.fn(async (_ids: string[]) => items);
  return { service: new RoutesService({ findPublicByIds } as unknown as SpotsService, config), findPublicByIds, config };
}

describe('精选摄影路线配置', () => {
  it('默认目录有效，全部为有风险说明的演示编排', () => {
    expect(() => validateRouteCatalog(catalog())).not.toThrow();
    expect(ROUTE_CATALOG.every(route => route.isDemo && route.disclaimer.includes('未经实地验证'))).toBe(true);
  });
  it.each([
    ['重复路线 ID', (r: CuratedRoute[]) => { r.push({ ...r[0] }); }],
    ['非法路线 ID', (r: CuratedRoute[]) => { r[0].id = '../unsafe'; }],
    ['重复机位', (r: CuratedRoute[]) => { r[0].stops[1].spotId = r[0].stops[0].spotId; }],
    ['非法 UUID', (r: CuratedRoute[]) => { r[0].stops[0].spotId = 'not-uuid'; }],
    ['不足两站', (r: CuratedRoute[]) => { r[0].stops = r[0].stops.slice(0, 1); }],
    ['过多站点', (r: CuratedRoute[]) => { r[0].stops = Array(21).fill(r[0].stops[0]); }],
    ['空省份', (r: CuratedRoute[]) => { r[0].province = ' '; }],
    ['空城市', (r: CuratedRoute[]) => { r[0].city = ''; }],
    ['过长标题', (r: CuratedRoute[]) => { r[0].title = '字'.repeat(81); }],
    ['没有声明', (r: CuratedRoute[]) => { r[0].disclaimer = ''; }],
    ['非法日期', (r: CuratedRoute[]) => { r[0].updatedAt = '2026-02-30'; }],
    ['空准备提示', (r: CuratedRoute[]) => { r[0].preparation = []; }],
    ['空站点提示', (r: CuratedRoute[]) => { r[0].stops[0].note = ''; }],
  ] as [string, (r: CuratedRoute[]) => void][])('%s 导致配置校验失败', (_name, mutate) => {
    const routes = catalog(); mutate(routes);
    expect(() => validateRouteCatalog(routes)).toThrow();
  });
});

describe('精选摄影路线服务', () => {
  it('一次批量查询，输出保持配置顺序，不调用有浏览量副作用的详情接口', async () => {
    const h = harness();
    const detail = await h.service.detail(ROUTE_CATALOG[0].id);
    expect(detail.stops.map(stop => stop.spot.id)).toEqual(ROUTE_CATALOG[0].stops.map(stop => stop.spotId));
    expect(detail.stops.map(stop => stop.order)).toEqual([1, 2, 3]);
    expect(h.findPublicByIds).toHaveBeenCalledTimes(1);
    expect(detail.stopCount).toBe(3);
    expect(detail.unavailableCount).toBe(0);
  });
  it('列表不透传站点配置和 preparation', async () => {
    const result = await harness().service.list();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty('stops');
    expect(result.items[0]).not.toHaveProperty('preparation');
    expect(result.items[0].isDemo).toBe(true);
  });
  it.each(['hidden', 'pending', 'deleted'] as const)('非公开 %s 站点不泄露内容，也不重排剩余站序', async status => {
    const hidden = spot(1, { status, title: '不可泄露的标题', coverUrl: 'secret-cover' });
    const config = catalog(); config[0].stops[1].note = '不可泄露的站点说明';
    const detail = await harness([spot(0), hidden, spot(2)], config).service.detail(config[0].id);
    expect(detail.stops.map(stop => stop.order)).toEqual([1, 3]);
    expect(detail.unavailableCount).toBe(1);
    expect(JSON.stringify(detail)).not.toContain('不可泄露');
    expect(JSON.stringify(detail)).not.toContain(hidden.id);
    expect(detail.coverUrl).not.toBe('secret-cover');
  });
  it.each([
    { city: '杭州市' }, { province: '浙江省' }, { province: null }, { city: null },
  ])('机位移城或缺失省市信息后视为暂不可用：%j', async metadata => {
    const detail = await harness([spot(0), spot(1, metadata), spot(2)]).service.detail(ROUTE_CATALOG[0].id);
    expect(detail.stops.map(stop => stop.order)).toEqual([1, 3]);
    expect(detail.unavailableCount).toBe(1);
  });
  it('缺失站点保留数量说明，封面来自仍公开站点', async () => {
    const detail = await harness([spot(1, { coverUrl: null }), spot(2)]).service.detail(ROUTE_CATALOG[0].id);
    expect(detail.unavailableCount).toBe(1);
    expect(detail.coverUrl).toBe(spot(2).coverUrl);
  });
  it('全部无图时正常返回 null 封面', async () => {
    const detail = await harness([spot(0, { coverUrl: null }), spot(1, { coverUrl: null })]).service.detail(ROUTE_CATALOG[0].id);
    expect(detail.coverUrl).toBeNull();
  });
  it('少于两个可用机位时列表省略，详情 404', async () => {
    const h = harness([spot(0)]);
    expect(await h.service.list()).toEqual({ items: [] });
    await expect(h.service.detail(ROUTE_CATALOG[0].id)).rejects.toMatchObject({ status: 404 });
  });
  it('不存在的路线直接 404，不查询数据库', async () => {
    const h = harness();
    await expect(h.service.detail('unknown')).rejects.toMatchObject({ status: 404 });
    expect(h.findPublicByIds).not.toHaveBeenCalled();
  });
  it('恢复公开后自动重新出现在路线中，配置不变', async () => {
    const h = harness([spot(0), spot(2)]), before = JSON.stringify(h.config);
    expect((await h.service.detail(ROUTE_CATALOG[0].id)).stopCount).toBe(2);
    h.findPublicByIds.mockResolvedValueOnce([spot(0), spot(1), spot(2)]);
    expect((await h.service.detail(ROUTE_CATALOG[0].id)).stopCount).toBe(3);
    expect(JSON.stringify(h.config)).toBe(before);
  });
  it('多路线共用站点只查询一次，配置为空时不查数据库', async () => {
    const config = catalog(); config.push({ ...config[0], id: 'another-route' });
    const h = harness(undefined, config);
    expect((await h.service.list()).items).toHaveLength(2);
    expect(h.findPublicByIds).toHaveBeenCalledTimes(1);
    expect(h.findPublicByIds.mock.calls[0][0]).toHaveLength(3);
    const empty = harness([], []);
    expect(await empty.service.list()).toEqual({ items: [] });
    expect(empty.findPublicByIds).not.toHaveBeenCalled();
  });
  it('数据库错误不伪装成空路线', async () => {
    const h = harness(); h.findPublicByIds.mockRejectedValueOnce(new Error('数据库失败'));
    await expect(h.service.list()).rejects.toThrow('数据库失败');
  });
});
