import { MAINLAND_CHINA_BBOX } from '../enums';

export interface Bbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

const BBOX_PATTERN = /^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/;

/**
 * 解析 `minLng,minLat,maxLng,maxLat`。
 * 非法格式、越界、反序（min > max）一律抛错，避免把脏参数透传给 PostGIS。
 */
export function parseBbox(raw: string): Bbox {
  if (typeof raw !== 'string' || !BBOX_PATTERN.test(raw.trim())) {
    throw new Error('bbox 格式应为 minLng,minLat,maxLng,maxLat');
  }

  const [minLng, minLat, maxLng, maxLat] = raw
    .trim()
    .split(',')
    .map((part) => Number(part));

  for (const value of [minLng, minLat, maxLng, maxLat]) {
    if (!Number.isFinite(value)) {
      throw new Error('bbox 含非法数值');
    }
  }
  if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) {
    throw new Error('bbox 超出经纬度范围');
  }
  if (minLng >= maxLng || minLat >= maxLat) {
    throw new Error('bbox 需要满足 minLng < maxLng 且 minLat < maxLat');
  }

  // 超大视野直接收敛到大陆范围，避免一次扫全表
  return {
    minLng: Math.max(minLng, -180),
    minLat: Math.max(minLat, -90),
    maxLng: Math.min(maxLng, 180),
    maxLat: Math.min(maxLat, 90),
  };
}

export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** 粗判是否落在（含边界的）中国大陆包围盒内，用于创建时给出友好提示。 */
export function isInMainlandChina(lat: number, lng: number): boolean {
  return (
    lng >= MAINLAND_CHINA_BBOX.minLng &&
    lng <= MAINLAND_CHINA_BBOX.maxLng &&
    lat >= MAINLAND_CHINA_BBOX.minLat &&
    lat <= MAINLAND_CHINA_BBOX.maxLat
  );
}

/** Haversine 距离（米）。入参与返回均基于同一坐标系，全链路为 GCJ-02。 */
export function distanceInMeters(from: LatLng, to: LatLng): number {
  const R = 6371008.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 地图缩放级别收敛到微信 map 组件支持的 3–20。 */
export function clampZoom(raw: unknown, fallback = 12): number {
  const zoom = Number(raw);
  if (!Number.isFinite(zoom)) return fallback;
  return Math.min(20, Math.max(3, Math.round(zoom)));
}

/** 明细点少于该 zoom 时改为按城市聚合返回。 */
export const CLUSTER_ZOOM_THRESHOLD = 9;

export const MAX_SPOT_LIMIT = 500;

export function normalizeLimit(raw: unknown, fallback = 200): number {
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(MAX_SPOT_LIMIT, Math.floor(limit));
}

/** 基于 GCJ-02 的 1 度约 111km，把 bbox 转成 PostGIS 需要的 WKT 多边形。 */
export function bboxToWkt(bbox: Bbox): string {
  const { minLng, minLat, maxLng, maxLat } = bbox;
  return `POLYGON((${minLng} ${minLat}, ${maxLng} ${minLat}, ${maxLng} ${maxLat}, ${minLng} ${maxLat}, ${minLng} ${minLat}))`;
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '';
  if (meters < 1000) return `${Math.round(meters)}m`;
  if (meters < 10000) return `${(meters / 1000).toFixed(1)}km`;
  return `${Math.round(meters / 1000)}km`;
}

