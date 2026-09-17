export const HEADINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type Heading = (typeof HEADINGS)[number];

export const HEADING_LABELS: Record<Heading, string> = {
  N: '朝北',
  NE: '朝东北',
  E: '朝东',
  SE: '朝东南',
  S: '朝南',
  SW: '朝西南',
  W: '朝西',
  NW: '朝西北',
};

export const BEST_TIMES = [
  'sunrise',
  'morning',
  'noon',
  'afternoon',
  'sunset',
  'blue_hour',
  'night',
] as const;
export type BestTime = (typeof BEST_TIMES)[number];

export const BEST_TIME_LABELS: Record<BestTime, string> = {
  sunrise: '日出',
  morning: '上午',
  noon: '正午',
  afternoon: '下午',
  sunset: '日落',
  blue_hour: '蓝调',
  night: '夜景',
};

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

export const SEASON_LABELS: Record<Season, string> = {
  spring: '春',
  summer: '夏',
  autumn: '秋',
  winter: '冬',
};

export const FOCAL_LENGTHS = ['ultrawide', 'standard', 'tele', 'macro', 'drone'] as const;
export type FocalLength = (typeof FOCAL_LENGTHS)[number];

export const FOCAL_LENGTH_LABELS: Record<FocalLength, string> = {
  ultrawide: '超广角',
  standard: '标准焦段',
  tele: '长焦',
  macro: '微距',
  drone: '航拍',
};

export const DIFFICULTY_LABELS: Record<number, string> = {
  1: '轻松到达',
  2: '需要步行',
  3: '较难到达',
};

export const SPOT_STATUSES = ['active', 'hidden', 'deleted'] as const;
export type SpotStatus = (typeof SPOT_STATUSES)[number];

/** 大陆范围的粗略包围盒，用于拦截明显错误的坐标（境外点 v1 不支持）。 */
export const MAINLAND_CHINA_BBOX = {
  minLng: 73.4,
  maxLng: 135.2,
  minLat: 3.3,
  maxLat: 53.7,
};

