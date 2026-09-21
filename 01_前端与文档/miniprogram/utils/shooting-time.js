const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const pad = value => String(value).padStart(2, '0');

// Use UTC fields after an explicit UTC+08 shift; device timezone is irrelevant.
function beijingDate(now = Date.now()) {
  const date = new Date(Number(now) + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function beijingTime(value, date) {
  const instant = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(instant)) return '—';
  const shifted = new Date(instant + BEIJING_OFFSET_MS);
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  return date && beijingDate(instant) === date ? time : `${beijingDate(instant)} ${time}`;
}
function rows(payload) {
  return [
    ['sunrise', '日出', false], ['sunset', '日落', false],
    ['goldenMorning', '早间黄金时段', true], ['goldenEvening', '傍晚黄金时段', true],
    ['blueMorning', '早间蓝调时段', true], ['blueEvening', '傍晚蓝调时段', true]
  ].map(([key, label, range]) => {
    const value = payload[key];
    return { key, label, available: Boolean(value), text: !value ? '当日无此时段' : range
      ? `${beijingTime(value.start, payload.date)} — ${beijingTime(value.end, payload.date)}`
      : beijingTime(value, payload.date) };
  });
}

module.exports = { beijingDate, validDate, beijingTime, rows };
