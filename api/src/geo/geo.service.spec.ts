import { loadConfig } from '../config/configuration';
import { GeoService } from './geo.service';

function buildService(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: 'development',
    AMAP_KEY: 'test-key',
    ...env,
  } as NodeJS.ProcessEnv);
  return new GeoService(config);
}

describe('GeoService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('未配置高德 Key 时返回降级结果而不抛错', async () => {
    const service = buildService({ AMAP_KEY: '' });
    const meta = await service.reverse(31.2, 121.5);
    expect(meta).toEqual({
      province: null,
      city: null,
      district: null,
      address: null,
      source: 'unavailable',
    });
  });

  it('未配置 Key 时 POI 搜索返回空数组', async () => {
    const service = buildService({ AMAP_KEY: '' });
    await expect(service.searchPoi('外滩')).resolves.toEqual([]);
  });

  it('解析高德逆地理返回的城市与地址', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({
        status: '1',
        regeocode: {
          formatted_address: '上海市黄浦区中山东一路',
          addressComponent: { province: '上海市', city: '上海市', district: '黄浦区' },
        },
      }),
    ) as unknown as typeof fetch;

    const service = buildService();
    const meta = await service.reverse(31.2397, 121.4903);
    expect(meta.city).toBe('上海市');
    expect(meta.district).toBe('黄浦区');
    expect(meta.source).toBe('amap');
  });

  // 高德对直辖市只返回 province、不返回 city（city 是空数组）。
  // 不兜底的话，上海/北京新建的机位 city 为空 —— 地图聚合成"未知地区"、城市筛选也看不到。
  it('直辖市没有 city 时用 province 兜底', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({
        status: '1',
        regeocode: {
          formatted_address: '上海市黄浦区外滩街道外滩隧道',
          addressComponent: { province: '上海市', city: [], district: '黄浦区' },
        },
      }),
    ) as unknown as typeof fetch;

    const meta = await buildService().reverse(31.2397, 121.4903);
    expect(meta.province).toBe('上海市');
    expect(meta.city).toBe('上海市');
    expect(meta.district).toBe('黄浦区');
  });

  it('普通省份不受兜底影响，city 仍用高德返回值', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({
        status: '1',
        regeocode: {
          formatted_address: '浙江省杭州市西湖区白堤',
          addressComponent: { province: '浙江省', city: '杭州市', district: '西湖区' },
        },
      }),
    ) as unknown as typeof fetch;

    const meta = await buildService().reverse(30.2594, 120.1438);
    expect(meta.city).toBe('杭州市');
  });

  it('province 不是市级时不硬凑 city（例如省直辖县）', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({
        status: '1',
        regeocode: {
          formatted_address: '湖北省仙桃市某路',
          addressComponent: { province: '湖北省', city: [], district: '仙桃市' },
        },
      }),
    ) as unknown as typeof fetch;

    const meta = await buildService().reverse(30.36, 113.45);
    expect(meta.province).toBe('湖北省');
    expect(meta.city).toBeNull();
  });

  it('相同坐标第二次命中缓存，不再请求高德（省配额）', async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({
        status: '1',
        regeocode: { formatted_address: 'A', addressComponent: { city: '上海市' } },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = buildService();
    await service.reverse(31.2397, 121.4903);
    const second = await service.reverse(31.23971, 121.49029);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.source).toBe('cached');
  });

  it('高德返回 status=0 时抛 GEO_UNAVAILABLE', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ status: '0', info: 'INVALID_USER_KEY' }),
    ) as unknown as typeof fetch;

    const service = buildService();
    await expect(service.reverse(31.2, 121.5)).rejects.toThrow('地址服务异常');
  });

  // 常见错误码要翻成人话：否则"Key 类型选错"会被误以为"没配 Key"，排查方向全错
  it.each([
    ['INVALID_USER_KEY', 'Key 无效或已过期'],
    ['USERKEY_PLAT_NOMATCH', '服务平台必须选「Web服务」'],
    ['DAILY_QUERY_OVER_LIMIT', '当日调用配额已用完'],
    ['INVALID_USER_SCODE', '实名认证'],
  ])('错误码 %s 被翻译成可读提示（含原始错误码）', async (code, hint) => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ status: '0', info: code }),
    ) as unknown as typeof fetch;

    const service = buildService();
    await expect(service.reverse(31.2, 121.5)).rejects.toThrow(code);
    await expect(service.reverse(31.2, 121.5)).rejects.toThrow(hint);
  });

  it('未知错误码保留原始信息，不乱编提示', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ status: '0', info: 'SOME_NEW_ERROR' }),
    ) as unknown as typeof fetch;

    const service = buildService();
    await expect(service.reverse(31.2, 121.5)).rejects.toThrow('地址服务返回异常: SOME_NEW_ERROR');
  });

  it('解析 POI 搜索的经纬度并过滤脏数据', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({
        status: '1',
        pois: [
          { id: '1', name: '外滩', address: '中山东一路', location: '121.4903,31.2397', adname: '黄浦区' },
          { id: '2', name: '脏数据', location: 'abc,def' },
        ],
      }),
    ) as unknown as typeof fetch;

    const service = buildService();
    const items = await service.searchPoi('外滩', '上海市');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: '1', lat: 31.2397, lng: 121.4903 });
  });

  it('关键词过短直接报错，不浪费配额', async () => {
    const service = buildService();
    await expect(service.searchPoi('外')).rejects.toThrow('关键词至少 2 个字');
  });
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}
