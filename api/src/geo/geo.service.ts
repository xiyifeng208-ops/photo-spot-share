import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/errors';
import { isValidLatLng } from '../common/utils/geo.util';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';

export interface GeoMeta {
  province: string | null;
  city: string | null;
  district: string | null;
  address: string | null;
  /** amap=高德返回；cached=命中缓存；unavailable=未配置 Key 的降级结果 */
  source: 'amap' | 'cached' | 'unavailable';
}

export interface PoiCandidate {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  district: string | null;
}

interface AmapRegeoResponse {
  status: string;
  info?: string;
  regeocode?: {
    formatted_address?: string;
    addressComponent?: {
      province?: string | (string | Record<string, never>)[];
      city?: string | (string | Record<string, never>)[];
      district?: string | (string | Record<string, never>)[];
    };
  };
}

interface AmapPlaceResponse {
  status: string;
  info?: string;
  pois?: Array<{
    id: string;
    name: string;
    address?: string | string[];
    location?: string;
    adname?: string | string[];
  }>;
}

interface CacheEntry {
  value: GeoMeta;
  expiresAt: number;
}

/**
 * 高德常见错误码 → 人话提示。前端会把这句原样显示给用户，所以要写清怎么解决。
 * 最常踩的坑是 Key 类型选错：逆地理编码必须用「Web服务」类型的 Key。
 */
export const AMAP_ERROR_HINTS: Record<string, string> = {
  INVALID_USER_KEY: 'Key 无效或已过期，请检查后端 .env 里的 AMAP_KEY',
  USERKEY_PLAT_NOMATCH: 'Key 与调用平台不匹配，创建 Key 时服务平台必须选「Web服务」',
  SERVICE_NOT_AVAILABLE: '该 Key 未开通 Web 服务，请到高德控制台确认',
  INVALID_USER_SCODE: '账号未完成实名认证，请到高德控制台完成个人认证',
  DAILY_QUERY_OVER_LIMIT: '当日调用配额已用完，明天恢复或更换更高额度的账号',
  INVALID_USER_IP: '当前服务器 IP 不在这个 Key 的允许范围内',
  INVALID_PARAMS: '请求参数不合法（经纬度）',
  REQUEST_HAS_NO_RESULT: '该坐标附近没有可用的地址信息',
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;
/** 逆地理编码按约 100m 网格聚合，拖动地图时能显著命中缓存。 */
const CACHE_PRECISION = 3;

@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get isConfigured(): boolean {
    return Boolean(this.config.amap.key);
  }

  /** 逆地理编码。未配置高德 Key 时返回降级结果，不阻断创建流程。 */
  async reverse(lat: number, lng: number): Promise<GeoMeta> {
    if (!isValidLatLng(lat, lng)) {
      throw AppException.badRequest('经纬度不合法');
    }

    if (!this.isConfigured) {
      return { province: null, city: null, district: null, address: null, source: 'unavailable' };
    }

    const cacheKey = `${lng.toFixed(CACHE_PRECISION)},${lat.toFixed(CACHE_PRECISION)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.value, source: 'cached' };
    }

    const url = new URL(`${this.config.amap.baseUrl}/geocode/regeo`);
    url.searchParams.set('key', this.config.amap.key);
    url.searchParams.set('location', `${lng},${lat}`);
    url.searchParams.set('extensions', 'base');

    const payload = await this.request<AmapRegeoResponse>(url);
    const component = payload.regeocode?.addressComponent;
    const province = pickText(component?.province);
    let city = pickText(component?.city);
    // 直辖市（北京/上海/天津/重庆）高德只返回 province，不返回 city。
    // 不用 province 兜底的话，这些城市新建的机位 city 为空 —— 地图会聚合成"未知地区"，
    // 发现页按城市筛选也看不到它们。
    if (!city && province && province.endsWith('市')) city = province;

    const meta: GeoMeta = {
      province,
      city,
      district: pickText(component?.district),
      address: payload.regeocode?.formatted_address ?? null,
      source: 'amap',
    };

    this.writeCache(cacheKey, meta);
    return meta;
  }

  /** POI 关键字搜索，用于创建时按地标快速定位。 */
  async searchPoi(keyword: string, city?: string): Promise<PoiCandidate[]> {
    const trimmed = keyword.trim();
    if (trimmed.length < 2) {
      throw AppException.badRequest('关键词至少 2 个字');
    }
    if (!this.isConfigured) {
      return [];
    }

    const url = new URL(`${this.config.amap.baseUrl}/place/text`);
    url.searchParams.set('key', this.config.amap.key);
    url.searchParams.set('keywords', trimmed);
    url.searchParams.set('offset', '10');
    url.searchParams.set('page', '1');
    if (city) url.searchParams.set('city', city);

    const payload = await this.request<AmapPlaceResponse>(url);

    return (payload.pois ?? [])
      .map((poi) => {
        const [lng, lat] = (poi.location ?? '').split(',').map(Number);
        if (!isValidLatLng(lat, lng)) return null;
        return {
          id: poi.id,
          name: poi.name,
          address: pickText(poi.address) ?? '',
          lat,
          lng,
          district: pickText(poi.adname),
        } satisfies PoiCandidate;
      })
      .filter((item): item is PoiCandidate => item !== null);
  }

  private async request<T extends { status: string; info?: string }>(url: URL): Promise<T> {
    let payload: T;
    try {
      const response = await fetch(url, { method: 'GET' });
      payload = (await response.json()) as T;
    } catch (error) {
      this.logger.error(`高德请求失败: ${(error as Error).message}`);
      throw new AppException('GEO_UNAVAILABLE', '地址服务暂时不可用，请手动确认位置', 502);
    }

    if (payload.status !== '1') {
      const rawInfo = payload.info ?? '未知错误';
      this.logger.warn(`高德返回错误: ${rawInfo}`);
      const hint = AMAP_ERROR_HINTS[rawInfo];
      throw new AppException(
        'GEO_UNAVAILABLE',
        hint ? `地址服务异常（${rawInfo}）：${hint}` : `地址服务返回异常: ${rawInfo}`,
        502,
      );
    }
    return payload;
  }

  private writeCache(key: string, value: GeoMeta) {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const now = Date.now();
      for (const [cacheKey, entry] of this.cache) {
        if (entry.expiresAt <= now) this.cache.delete(cacheKey);
      }
      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) this.cache.delete(oldest.value);
      }
    }
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

/** 高德的直辖市会把 city 返回成空数组，这里统一成 null。 */
function pickText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) return null;
  return null;
}
