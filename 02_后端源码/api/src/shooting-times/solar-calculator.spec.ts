import { calculateShootingTimes, parseShootingDate, solarAltitude, type ShootingTimes } from './solar-calculator';

const SHANGHAI = [31.2304, 121.4737] as const;
const outputTimes = (value: ShootingTimes): string[] => [
  value.sunrise, value.sunset,
  ...[value.blueMorning, value.goldenMorning, value.goldenEvening, value.blueEvening].flatMap(item => item ? [item.start, item.end] : []),
].filter((item): item is string => item !== null);

describe('拍摄时间日期校验', () => {
  it.each(['2000-01-01', '2000-02-29', '2024-02-29', '2100-12-31'])('接受有效边界及闰年 %s', date => {
    expect(parseShootingDate(date)).toBe(date);
  });
  it.each(['1999-12-31', '2101-01-01', '2100-02-29', '2023-02-29', '2026-04-31', '2026-00-01',
    '2026-13-01', '2026-01-00', '2026-1-01', '2026-01-01T00:00:00Z', ' 2026-01-01 ', '', 'not-a-date'])('拒绝非法日期 %s', date => {
    expect(() => parseShootingDate(date)).toThrow();
  });
  it.each([null, 20260918, ['2026-09-18'], { date: '2026-09-18' }])('拒绝非单个字符串 %j', value => {
    expect(() => parseShootingDate(value)).toThrow();
  });
  it('省略日期以北京零点而不是 UTC 零点分界', () => {
    expect(parseShootingDate(undefined, Date.parse('2026-09-17T15:59:59Z'))).toBe('2026-09-17');
    expect(parseShootingDate(undefined, Date.parse('2026-09-17T16:00:00Z'))).toBe('2026-09-18');
    expect(parseShootingDate(undefined, Date.parse('2025-12-31T16:00:00Z'))).toBe('2026-01-01');
  });
});

describe('NOAA 太阳位置方程与北京时间数值交点', () => {
  // Independent reference: NOAA official main.js, calcSunriseSetUTC called twice as
  // NOAA calcSunriseSet does; captured 2026-09-18. See METHOD.md for source/procedure.
  const reference = [
    { date: '2026-06-21', lat: 31.2304, lng: 121.4737, rise: 290.41936340105195, set: 1141.2955369886813 },
    { date: '2026-12-21', lat: 31.2304, lng: 121.4737, rise: 408.4703618474593, set: 1015.5514954528406 },
    { date: '2026-06-21', lat: 39.9042, lng: 116.4074, rise: 285.9327661597354, set: 1186.3195555771604 },
    { date: '2026-12-21', lat: 39.9042, lng: 116.4074, rise: 452.1430221523412, set: 1012.4211775527914 },
    { date: '2024-02-29', lat: 31.2304, lng: 121.4737, rise: 381.95594496801266, set: 1071.6590529836174 },
  ];
  it.each(reference)('与独立 NOAA 参考相差小于一分钟：$date ($lat,$lng)', ({ date, lat, lng, rise, set }) => {
    const actual = calculateShootingTimes(date, lat, lng);
    const midnight = Date.parse(`${date}T00:00:00+08:00`);
    expect(actual.sunrise).not.toBeNull(); expect(actual.sunset).not.toBeNull();
    expect(Math.abs((Date.parse(actual.sunrise!) - midnight) / 60000 - rise)).toBeLessThan(1);
    expect(Math.abs((Date.parse(actual.sunset!) - midnight) / 60000 - set)).toBeLessThan(1);
  });
  it.each(['2000-01-01', '2000-02-29', '2026-01-01', '2026-06-21', '2100-12-31'])('所有结果落在北京当天并带 +08:00：%s', date => {
    const result = calculateShootingTimes(date, ...SHANGHAI);
    expect(result.date).toBe(date); expect(result.timeZone).toBe('Asia/Shanghai');
    for (const value of outputTimes(result)) {
      expect(value).toMatch(new RegExp(`^${date}T\\d{2}:\\d{2}:\\d{2}\\+08:00$`));
      expect(Number.isFinite(Date.parse(value))).toBe(true);
    }
    expect(outputTimes(result)).toHaveLength(10);
  });
  it('黄金和蓝调早晚次序及高度阈值一致，不硬编码日出前后固定分钟', () => {
    const result = calculateShootingTimes('2026-09-18', ...SHANGHAI);
    const before = [result.blueMorning!.start, result.blueMorning!.end, result.sunrise!, result.goldenMorning!.end];
    const after = [result.goldenEvening!.start, result.sunset!, result.goldenEvening!.end, result.blueEvening!.end];
    for (const group of [before, after]) expect(group.map(Date.parse)).toEqual(group.map(Date.parse).sort((a, b) => a - b));
    expect(result.blueMorning!.end).toBe(result.goldenMorning!.start);
    expect(result.goldenEvening!.end).toBe(result.blueEvening!.start);
    for (const [value, threshold] of [
      [result.blueMorning!.start, -6], [result.goldenMorning!.start, -4], [result.sunrise!, -0.833],
      [result.goldenMorning!.end, 6], [result.goldenEvening!.start, 6], [result.sunset!, -0.833],
      [result.goldenEvening!.end, -4], [result.blueEvening!.end, -6],
    ] as const) expect(Math.abs(solarAltitude(Date.parse(value), ...SHANGHAI) - threshold)).toBeLessThan(0.01);
  });
  it.each([
    ['2026-06-21', 90], ['2026-12-21', 90], ['2026-06-21', -90], ['2026-12-21', -90],
  ] as const)('极昼/极夜不返回 NaN 或借用隔日事件：%s 纬度 %s', (date, lat) => {
    const result = calculateShootingTimes(date, lat, 120);
    expect(result.sunrise).toBeNull(); expect(result.sunset).toBeNull();
    expect(result.goldenMorning).toBeNull(); expect(result.goldenEvening).toBeNull();
    expect(result.blueMorning).toBeNull(); expect(result.blueEvening).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/NaN|Invalid Date/);
    expect(result.notes.join('')).toContain('部分时间暂不可用');
  });
  it('高纬无日出仍可有完整蓝调，不把部分缺失转换为全部失败', () => {
    const result = calculateShootingTimes('2026-12-21', 70, 120);
    expect(result.sunrise).toBeNull(); expect(result.sunset).toBeNull();
    expect(result.goldenMorning).toBeNull(); expect(result.goldenEvening).toBeNull();
    expect(result.blueMorning).not.toBeNull(); expect(result.blueEvening).not.toBeNull();
  });
  it.each([-180, -179.9, 0, 180])('其他经度也只返回北京所选当天完整事件：经度 %s', lng => {
    const result = calculateShootingTimes('2026-03-20', 0, lng);
    for (const value of outputTimes(result)) expect(value.startsWith('2026-03-20T')).toBe(true);
    for (const item of [result.goldenMorning, result.goldenEvening, result.blueMorning, result.blueEvening]) {
      if (item) expect(Date.parse(item.start)).toBeLessThan(Date.parse(item.end));
    }
  });
  it.each([[NaN, 120], [31, NaN], [Infinity, 120], [31, -Infinity], [91, 120], [-91, 120], [31, 181]])('拒绝非法坐标 %s,%s', (lat, lng) => {
    expect(() => calculateShootingTimes('2026-09-18', lat, lng)).toThrow('机位坐标无效');
  });
  it('返回方法与现实限制，不声称实时天气或精确可见性', () => {
    const result = calculateShootingTimes('2026-09-18', ...SHANGHAI);
    expect(result.method).toMatchObject({ sunriseSunsetAltitude: -0.833, goldenAltitudeRange: [-4, 6], blueAltitudeRange: [-6, -4] });
    expect(result.method.sourceUrl).toBe('https://gml.noaa.gov/grad/solcalc/calcdetails.html');
    expect(result.notes.join('')).toContain('GCJ-02');
    expect(result.notes.join('')).toContain('建筑遮挡');
    expect(result.notes.join('')).toContain('不代表天气预报');
  });
});
