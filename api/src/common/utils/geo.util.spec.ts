import {
  bboxToWkt,
  clampZoom,
  CLUSTER_ZOOM_THRESHOLD,
  distanceInMeters,
  formatDistance,
  isInMainlandChina,
  isValidLatLng,
  normalizeLimit,
  parseBbox,
} from './geo.util';
import { decodeCursor, encodeCursor } from './cursor.util';

describe('parseBbox', () => {
  it('解析合法 bbox', () => {
    expect(parseBbox('121.4,31.2,121.6,31.4')).toEqual({
      minLng: 121.4,
      minLat: 31.2,
      maxLng: 121.6,
      maxLat: 31.4,
    });
  });

  it('支持负数坐标', () => {
    const bbox = parseBbox('-10.5,-20.25,-9.75,-19.5');
    expect(bbox.minLng).toBeCloseTo(-10.5);
    expect(bbox.maxLat).toBeCloseTo(-19.5);
  });

  it.each([
    ['缺少分段', '121.4,31.2,121.6'],
    ['非数字', 'a,b,c,d'],
    ['经纬度反序', '121.6,31.2,121.4,31.4'],
    ['纬度反序', '121.4,31.4,121.6,31.2'],
    ['超出经度范围', '121.4,31.2,200,31.4'],
    ['空字符串', ''],
  ])('拒绝 %s', (_label, raw) => {
    expect(() => parseBbox(raw)).toThrow();
  });
});

describe('isValidLatLng / isInMainlandChina', () => {
  it('上海的坐标合法且在大陆范围', () => {
    expect(isValidLatLng(31.2397, 121.4903)).toBe(true);
    expect(isInMainlandChina(31.2397, 121.4903)).toBe(true);
  });

  it('东京坐标合法但不在大陆范围', () => {
    expect(isValidLatLng(35.6762, 139.6503)).toBe(true);
    expect(isInMainlandChina(35.6762, 139.6503)).toBe(false);
  });

  it('非法纬度', () => {
    expect(isValidLatLng(95, 121)).toBe(false);
    expect(isValidLatLng(NaN, 121)).toBe(false);
  });
});

describe('distanceInMeters', () => {
  it('相同点为 0', () => {
    expect(distanceInMeters({ lat: 31.2, lng: 121.5 }, { lat: 31.2, lng: 121.5 })).toBe(0);
  });

  it('1 个纬度约 111km', () => {
    const d = distanceInMeters({ lat: 31, lng: 121 }, { lat: 32, lng: 121 });
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });

  it('同一经度差在赤道最长', () => {
    const atEquator = distanceInMeters({ lat: 0, lng: 121 }, { lat: 0, lng: 122 });
    const atShanghai = distanceInMeters({ lat: 31, lng: 121 }, { lat: 31, lng: 122 });
    expect(atEquator).toBeGreaterThan(atShanghai);
  });
});

describe('clampZoom / normalizeLimit', () => {
  it('zoom 收敛到 3–20', () => {
    expect(clampZoom(0)).toBe(3);
    expect(clampZoom(25)).toBe(20);
    expect(clampZoom('11.4')).toBe(11);
    expect(clampZoom(undefined)).toBe(12);
  });

  it('limit 上限 500，非法值走默认', () => {
    expect(normalizeLimit(9999)).toBe(500);
    expect(normalizeLimit(-3)).toBe(200);
    expect(normalizeLimit('30')).toBe(30);
    expect(normalizeLimit('abc')).toBe(200);
  });

  it('聚合阈值与产品约定一致', () => {
    expect(CLUSTER_ZOOM_THRESHOLD).toBe(9);
  });
});

describe('bboxToWkt', () => {
  it('生成闭合多边形', () => {
    expect(bboxToWkt({ minLng: 1, minLat: 2, maxLng: 3, maxLat: 4 })).toBe(
      'POLYGON((1 2, 3 2, 3 4, 1 4, 1 2))',
    );
  });
});

describe('formatDistance', () => {
  it.each([
    [120, '120m'],
    [1500, '1.5km'],
    [12345, '12km'],
  ])('%i 米展示为 %s', (meters, label) => {
    expect(formatDistance(meters)).toBe(label);
  });
});

describe('cursor', () => {
  it('编解码可往返', () => {
    const cursor = { createdAt: '2026-09-14T02:33:00.000Z', id: 'abc-123' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('空游标返回 null', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('非法游标抛 400', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow();
  });
});

