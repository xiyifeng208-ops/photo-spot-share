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
    await expect(service.reverse(31.2, 121.5)).rejects.toThrow('地址服务返回异常');
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

