import { AppException } from '../common/errors';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const BEIJING_OFFSET_MS = 8 * 60 * MINUTE_MS;
const DEGREE = Math.PI / 180;
const SOURCE_URL = 'https://gml.noaa.gov/grad/solcalc/calcdetails.html';

export interface ShootingTimeWindow { start: string; end: string }
export interface ShootingTimes {
  date: string;
  timeZone: 'Asia/Shanghai';
  sunrise: string | null;
  sunset: string | null;
  goldenMorning: ShootingTimeWindow | null;
  goldenEvening: ShootingTimeWindow | null;
  blueMorning: ShootingTimeWindow | null;
  blueEvening: ShootingTimeWindow | null;
  notes: string[];
  method: {
    name: 'NOAA solar equations';
    coordinateSystem: 'GCJ-02 approximation';
    sunriseSunsetAltitude: -0.833;
    goldenAltitudeRange: [-4, 6];
    blueAltitudeRange: [-6, -4];
    sourceUrl: string;
  };
}

/** Only an omitted date defaults to today; malformed, repeated or blank input is an error. */
export function parseShootingDate(raw: unknown, now = Date.now()): string {
  if (raw === undefined) return new Date(now + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw AppException.badRequest('日期须为 YYYY-MM-DD，范围为 2000-01-01 至 2100-12-31');
  }
  const [year, month, day] = raw.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  if (year < 2000 || year > 2100 || new Date(timestamp).toISOString().slice(0, 10) !== raw) {
    throw AppException.badRequest('日期无效，范围为 2000-01-01 至 2100-12-31');
  }
  return raw;
}

/**
 * Independent implementation of the Meeus solar-position equations described by NOAA.
 * Formula/constant reference: https://gml.noaa.gov/grad/solcalc/main.js (checked 2026-09-18).
 * No third-party source file is bundled or executed at runtime. This is not NOAA's
 * lower-precision fractional-year approximation, and does not include refraction here:
 * sunrise/sunset use the conventional geometric centre altitude -0.833 degrees instead.
 */
export function solarAltitude(timestamp: number, latitude: number, longitude: number): number {
  const century = (timestamp / DAY_MS + 2440587.5 - 2451545) / 36525;
  const meanLongitude = (280.46646 + century * (36000.76983 + 0.0003032 * century)) * DEGREE;
  const anomaly = (357.52911 + century * (35999.05029 - 0.0001537 * century)) * DEGREE;
  const eccentricity = 0.016708634 - century * (0.000042037 + 0.0000001267 * century);
  const centre = Math.sin(anomaly) * (1.914602 - century * (0.004817 + 0.000014 * century))
    + Math.sin(2 * anomaly) * (0.019993 - 0.000101 * century) + Math.sin(3 * anomaly) * 0.000289;
  const omega = (125.04 - 1934.136 * century) * DEGREE;
  const apparentLongitude = meanLongitude + (centre - 0.00569 - 0.00478 * Math.sin(omega)) * DEGREE;
  const obliquitySeconds = 21.448 - century * (46.815 + century * (0.00059 - century * 0.001813));
  const obliquity = (23 + (26 + obliquitySeconds / 60) / 60 + 0.00256 * Math.cos(omega)) * DEGREE;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));
  const y = Math.tan(obliquity / 2) ** 2;
  const equationOfTime = 4 / DEGREE * (
    y * Math.sin(2 * meanLongitude) - 2 * eccentricity * Math.sin(anomaly)
    + 4 * eccentricity * y * Math.sin(anomaly) * Math.cos(2 * meanLongitude)
    - 0.5 * y * y * Math.sin(4 * meanLongitude) - 1.25 * eccentricity ** 2 * Math.sin(2 * anomaly)
  );
  const utcMinutes = ((timestamp % DAY_MS) + DAY_MS) % DAY_MS / MINUTE_MS;
  const hourAngle = ((utcMinutes + equationOfTime + 4 * longitude) / 4 - 180) * DEGREE;
  const latitudeRadians = latitude * DEGREE;
  const sineAltitude = Math.sin(latitudeRadians) * Math.sin(declination)
    + Math.cos(latitudeRadians) * Math.cos(declination) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sineAltitude))) / DEGREE;
}

type Crossing = { rising: number | null; setting: number | null };

function findCrossing(left: number, right: number, target: number, rising: boolean, lat: number, lng: number): number {
  // Refine a one-minute bracket to < 0.25 s. Sampling precision is not an accuracy claim.
  while (right - left > 250) {
    const middle = (left + right) / 2;
    if ((solarAltitude(middle, lat, lng) < target) === rising) left = middle;
    else right = middle;
  }
  return (left + right) / 2;
}

function beijingTimestamp(timestamp: number | null): string | null {
  if (timestamp === null || !Number.isFinite(timestamp)) return null;
  return new Date(Math.floor(timestamp / 1000) * 1000 + BEIJING_OFFSET_MS).toISOString().slice(0, 19) + '+08:00';
}

function window(start: number | null, end: number | null): ShootingTimeWindow | null {
  if (start === null || end === null || start >= end) return null;
  return { start: beijingTimestamp(start)!, end: beijingTimestamp(end)! };
}

export function calculateShootingTimes(date: string, latitude: number, longitude: number): ShootingTimes {
  const validDate = parseShootingDate(date);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw AppException.badRequest('机位坐标无效，暂不能计算拍摄时间');
  }
  const start = Date.parse(`${validDate}T00:00:00+08:00`);
  const end = start + DAY_MS;
  const crossings = new Map<number, Crossing>([-6, -4, -0.833, 6].map(angle => [angle, { rising: null, setting: null }]));
  let previous = solarAltitude(start, latitude, longitude);
  for (let right = start + MINUTE_MS; right <= end; right += MINUTE_MS) {
    const current = solarAltitude(right, latitude, longitude);
    for (const [target, crossing] of crossings) {
      const rising = previous <= target && current > target;
      const setting = previous >= target && current < target;
      if ((rising && crossing.rising === null) || (setting && crossing.setting === null)) {
        const timestamp = findCrossing(right - MINUTE_MS, right, target, rising, latitude, longitude);
        // Never borrow the following day's events when a complete window is unavailable.
        if (timestamp < end) crossing[rising ? 'rising' : 'setting'] = timestamp;
      }
    }
    previous = current;
  }
  const horizon = crossings.get(-0.833)!;
  const minusSix = crossings.get(-6)!;
  const minusFour = crossings.get(-4)!;
  const plusSix = crossings.get(6)!;
  const result: ShootingTimes = {
    date: validDate,
    timeZone: 'Asia/Shanghai',
    sunrise: beijingTimestamp(horizon.rising),
    sunset: beijingTimestamp(horizon.setting),
    goldenMorning: window(minusFour.rising, plusSix.rising),
    goldenEvening: window(plusSix.setting, minusFour.setting),
    blueMorning: window(minusSix.rising, minusFour.rising),
    blueEvening: window(minusFour.setting, minusSix.setting),
    notes: [
      '时间均为北京时间（UTC+8），按所选日期和机位坐标估算，仅供拍摄安排参考。',
      '使用 GCJ-02 机位坐标近似计算，未计入海拔、地形、建筑遮挡或实际大气条件，不保证现场可见日出日落。',
      '黄金时段按太阳中心高度 -4° 至 +6°、蓝调时段按 -6° 至 -4°估算，不代表天气预报或保证出片。',
    ],
    method: {
      name: 'NOAA solar equations', coordinateSystem: 'GCJ-02 approximation',
      sunriseSunsetAltitude: -0.833, goldenAltitudeRange: [-4, 6], blueAltitudeRange: [-6, -4], sourceUrl: SOURCE_URL,
    },
  };
  if (!result.sunrise || !result.sunset || !result.goldenMorning || !result.goldenEvening || !result.blueMorning || !result.blueEvening) {
    result.notes.push('部分时间暂不可用：所选北京时间日期内未找到对应太阳高度交点或完整时段，高纬地区可能出现极昼、极夜或整夜暮光。');
  }
  return result;
}
