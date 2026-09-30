const { randomUUID } = require('node:crypto');
const { existsSync, readFileSync, unlinkSync } = require('node:fs');
const { resolve, sep } = require('node:path');
const { parse } = require('../../api/node_modules/dotenv');
const mysql = require('../../api/node_modules/mysql2/promise');

const root = resolve(__dirname, '../..');
const apiDir = resolve(root, 'api');
const env = parse(readFileSync(resolve(apiDir, '.env'), 'utf8'));
const url = new URL(env.DATABASE_URL);
if (url.protocol !== 'mysql:' || url.pathname !== '/photo_spot_share') {
  throw new Error('Refusing smoke test: backend is not configured for the expected MySQL database');
}

const base = `http://127.0.0.1:${env.PORT || 3000}`;
const marker = `codex-switch-smoke-${randomUUID()}`;
let userId;
let spotId;
let objectKey;
let pool;

async function request(path, options = {}, expected = 200) {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({}));
  if (response.status !== expected) {
    throw new Error(`${options.method || 'GET'} ${path}: expected ${expected}, got ${response.status}: ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function counts() {
  const names = ['users', 'spots', 'spot_best_times', 'spot_best_seasons', 'photos', 'upload_tickets', 'content_check_tasks', 'spot_reports'];
  const result = {};
  for (const name of names) {
    const [rows] = await pool.query(`SELECT COUNT(*) count FROM ${name}`);
    result[name] = Number(rows[0].count);
  }
  return result;
}

async function cleanup() {
  if (pool && userId) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('UPDATE spots SET cover_photo_id = NULL WHERE user_id = ? AND id = ?', [userId, spotId || '']);
      await connection.execute('DELETE FROM users WHERE id = ? AND openid = ?', [userId, `dev:${marker}`]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  if (objectKey) {
    const uploadRoot = resolve(apiDir, env.LOCAL_STORAGE_DIR || 'var/uploads');
    const target = resolve(uploadRoot, objectKey);
    if (!target.startsWith(uploadRoot + sep)) throw new Error('Refusing to clean an unsafe upload path');
    if (existsSync(target)) unlinkSync(target);
  }
}

async function main() {
  pool = mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    connectionLimit: 1,
    timezone: 'Z',
  });
  const before = await counts();
  if (before.users !== 3 || before.spots !== 6 || before.spot_best_times !== 12 || before.spot_best_seasons !== 18) {
    throw new Error(`Unexpected baseline counts: ${JSON.stringify(before)}`);
  }

  const health = await request('/health');
  if (health.status !== 'ok' || health.database !== 'up') throw new Error('Health check did not report database up');

  const login = await request('/api/v1/auth/wx-login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: `dev:${marker}` }),
  }, 201);
  userId = login.user.id;
  const auth = { Authorization: `Bearer ${login.token}` };

  const signed = await request('/api/v1/uploads/photos/sign', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ mime: 'image/jpeg', size: 16, width: 2, height: 2 }] }),
  }, 201);
  objectKey = signed.keys[0];

  const form = new FormData();
  form.set('key', objectKey);
  form.set('file', new Blob([Buffer.from('smoke-test-image')], { type: 'image/jpeg' }), 'smoke.jpg');
  await request('/api/v1/uploads/local', { method: 'POST', headers: auth, body: form }, 201);

  const spot = await request('/api/v1/spots', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: '远程数据库切换验收机位', description: marker, lat: 31.2397, lng: 121.4903,
      heading: 'NE', bestTimes: ['sunset'], bestSeasons: ['autumn'], focalLength: 'standard',
      difficulty: 1, photoKeys: [objectKey], geo: { province: '上海市', city: '上海市', district: '黄浦区' },
    }),
  }, 201);
  spotId = spot.id;

  const detail = await request(`/api/v1/spots/${spotId}`);
  const map = await request('/api/v1/spots?bbox=120,30,122,32&zoom=14&limit=100');
  const feed = await request('/api/v1/spots/feed?limit=100');
  if (detail.id !== spotId || !map.items.some((item) => item.id === spotId) || !feed.items.some((item) => item.id === spotId)) {
    throw new Error('Created smoke-test spot was not readable through all expected endpoints');
  }

  await request(`/api/v1/spots/${spotId}`, { method: 'DELETE', headers: auth });
  await cleanup();
  userId = undefined;
  objectKey = undefined;
  const after = await counts();
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`Cleanup did not restore counts: ${JSON.stringify({ before, after })}`);

  console.log(JSON.stringify({
    accepted: true,
    health: 'ok',
    login: 'ok',
    upload: 'ok',
    createReadDelete: 'ok',
    mapAndFeed: 'ok',
    temporaryDataRemoved: true,
    finalCounts: after,
  }, null, 2));
}

main().catch(async (error) => {
  try { await cleanup(); } catch (cleanupError) { console.error(`Cleanup failed: ${cleanupError.message}`); }
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => { if (pool) await pool.end(); });
