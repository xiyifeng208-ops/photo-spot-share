const HEADING_LABELS = {
  N: '朝北',
  NE: '朝东北',
  E: '朝东',
  SE: '朝东南',
  S: '朝南',
  SW: '朝西南',
  W: '朝西',
  NW: '朝西北'
};

const BEST_TIME_LABELS = {
  sunrise: '日出',
  morning: '上午',
  noon: '正午',
  afternoon: '下午',
  sunset: '日落',
  blue_hour: '蓝调',
  night: '夜景'
};

const SEASON_LABELS = {
  spring: '春',
  summer: '夏',
  autumn: '秋',
  winter: '冬'
};

const FOCAL_LENGTH_LABELS = {
  ultrawide: '超广角',
  standard: '标准焦段',
  tele: '长焦',
  macro: '微距',
  drone: '航拍'
};

const DIFFICULTY_LABELS = {
  1: '轻松到达',
  2: '需要步行',
  3: '较难到达'
};

// 表单里的候选项，与后端枚举一一对应
const HEADING_OPTIONS = Object.keys(HEADING_LABELS).map((value) => ({
  value,
  label: HEADING_LABELS[value]
}));
const BEST_TIME_OPTIONS = Object.keys(BEST_TIME_LABELS).map((value) => ({
  value,
  label: BEST_TIME_LABELS[value]
}));
const SEASON_OPTIONS = Object.keys(SEASON_LABELS).map((value) => ({
  value,
  label: SEASON_LABELS[value]
}));
const FOCAL_LENGTH_OPTIONS = Object.keys(FOCAL_LENGTH_LABELS).map((value) => ({
  value,
  label: FOCAL_LENGTH_LABELS[value]
}));
const DIFFICULTY_OPTIONS = [1, 2, 3].map((value) => ({
  value,
  label: DIFFICULTY_LABELS[value]
}));

function formatDistance(meters) {
  if (meters === null || meters === undefined || !isFinite(meters) || meters < 0) return '';
  if (meters < 1000) return `${Math.round(meters)}m`;
  if (meters < 10000) return `${(meters / 1000).toFixed(1)}km`;
  return `${Math.round(meters / 1000)}km`;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (isNaN(date.getTime())) return '';
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value) {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 列表卡片用的标签组合，避免 WXML 里写复杂表达式。 */
function buildTags(spot, limit = 4) {
  const tags = [];
  if (spot.headingLabel) tags.push(spot.headingLabel);
  (spot.bestTimeLabels || []).forEach((label) => tags.push(label));
  if (spot.focalLengthLabel) tags.push(spot.focalLengthLabel);
  if (spot.difficultyLabel) tags.push(spot.difficultyLabel);
  return tags.slice(0, limit);
}

module.exports = {
  HEADING_LABELS,
  BEST_TIME_LABELS,
  SEASON_LABELS,
  FOCAL_LENGTH_LABELS,
  DIFFICULTY_LABELS,
  HEADING_OPTIONS,
  BEST_TIME_OPTIONS,
  SEASON_OPTIONS,
  FOCAL_LENGTH_OPTIONS,
  DIFFICULTY_OPTIONS,
  formatDistance,
  formatDate,
  buildTags
};

