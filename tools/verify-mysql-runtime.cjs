const fs = require('node:fs');
const path = require('node:path');
const api = path.resolve(__dirname, '../api');
const dotenv = require(path.join(api, 'node_modules/dotenv'));
const jwt = require(path.join(api, 'node_modules/jsonwebtoken'));

async function main() {
  const snapshotFile = path.resolve(process.argv[2]);
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile));
  const env = dotenv.parse(fs.readFileSync(path.join(api, '.env')));
  const target = new URL(env.DATABASE_URL);
  if (target.protocol !== 'mysql:' || target.hostname !== 'mysql6.sqlpub.com' || target.pathname !== '/photo_spot_share') throw new Error('Runtime is not the migrated MySQL');
  const user = snapshot.tables.users[0];
  // Use existing user identity; never print JWT or create a test account online.
  const token = jwt.sign({ sub: user.id, openid: user.openid }, env.JWT_SECRET || 'dev-only-secret-change-me', { expiresIn: '5m' });
  const request = async (route, authenticated = false) => {
    const response = await fetch('http://127.0.0.1:3000' + route, { signal: AbortSignal.timeout(15000),
      headers: authenticated ? { Authorization: 'Bearer ' + token } : {} });
    const body = await response.json();
    if (!response.ok) throw new Error('API failed: ' + route.split('?')[0] + ' status=' + response.status);
    return body.data;
  };
  const health = await request('/health');
  if (health.database !== 'up') throw new Error('Database health failed');
  const me = await request('/api/v1/auth/me', true);
  if (me.id !== user.id) throw new Error('Existing user identity mismatch');
  const feed = await request('/api/v1/spots/feed?limit=2');
  const active = snapshot.tables.spots.filter(row => row.status === 'active').length;
  const ids = new Set(feed.items.map(row => row.id));
  let cursor = feed.nextCursor;
  for (let page = 0; cursor && page < 20; page++) {
    const next = await request('/api/v1/spots/feed?limit=2&cursor=' + encodeURIComponent(cursor));
    for (const row of next.items) {
      if (ids.has(row.id)) throw new Error('Duplicate paginated result');
      ids.add(row.id);
    }
    cursor = next.nextCursor;
  }
  if (ids.size !== active) throw new Error('Feed missing migrated rows');
  const mine = await request('/api/v1/spots/mine?limit=50', true);
  const mineExpected = snapshot.tables.spots.filter(row => row.user_id === user.id && row.status !== 'deleted').length;
  if (mine.items.length !== mineExpected) throw new Error('Existing user spot ownership mismatch');
  const points = await request('/api/v1/spots?bbox=73,18,135,54&zoom=14');
  const clusters = await request('/api/v1/spots?bbox=73,18,135,54&zoom=4');
  if (points.mode !== 'points' || clusters.mode !== 'cluster') throw new Error('Map mode mismatch');
  const expectedPoints = snapshot.tables.spots.filter(row => row.status === 'active' && row.lng >= 73 && row.lng <= 135 && row.lat >= 18 && row.lat <= 54).length;
  if (points.items.length !== expectedPoints || clusters.clusters.reduce((sum, row) => sum + row.count, 0) !== expectedPoints) throw new Error('Map data count mismatch');
  const report = { verifiedAt: new Date().toISOString(), target: target.hostname + ':' + target.port + target.pathname,
    health: health.status, database: health.database, existingUserVerified: true, paginatedFeedCount: ids.size,
    mineCount: mine.items.length, mapPointCount: points.items.length, cityClusterCount: clusters.clusters.length,
    onlineWritesPerformed: false };
  const file = path.resolve(__dirname, '../backups/mysql-runtime-verification-20261008.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error('Runtime verification failed:', error.code || error.message); process.exitCode = 1; });
