// Preserve every unrelated .env setting; only switch after source/target verification.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const api = path.resolve(__dirname, '../api');
const dotenv = require(path.join(api, 'node_modules/dotenv'));

async function main() {
  const snapshotFile = path.resolve(process.argv[2]);
  const configFile = path.join(api, '.env');
  const original = fs.readFileSync(configFile, 'utf8');
  const runtime = dotenv.parse(original);
  const migration = dotenv.parse(fs.readFileSync(path.join(api, '.env.mysql.local')));
  const url = new URL(migration.TARGET_DATABASE_URL);
  if (url.hostname !== 'mysql6.sqlpub.com' || url.port !== '3311' || url.pathname !== '/photo_spot_share') throw new Error('Unexpected target');
  if (!runtime.DATABASE_URL?.startsWith('postgres')) throw new Error('Runtime is no longer PostgreSQL; stop for review');
  if (runtime.DATABASE_URL !== migration.SOURCE_DATABASE_URL) throw new Error('Configured source does not match original runtime');
  process.chdir(api);
  require(path.join(api, 'node_modules/ts-node')).register({ project: path.join(api, 'tsconfig.json') });
  const { exportPostgres, transferMysql } = require(path.join(api, 'src/database/transfer-mysql.ts'));
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile));
  const currentSource = await exportPostgres(migration.SOURCE_DATABASE_URL);
  if (currentSource.sha256 !== snapshot.sha256) throw new Error('Source changed since final snapshot; switch refused');
  const counts = await transferMysql(migration.TARGET_DATABASE_URL, snapshot, true, migration.TARGET_DATABASE_SSL === 'true');
  const directory = path.resolve(api, '../backups/runtime-cutover-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'api.env.before-mysql'), original, { flag: 'wx' });
  let updated = original;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const settings = { DATABASE_URL: migration.TARGET_DATABASE_URL, DATABASE_POOL_MAX: '3', DATABASE_SSL: migration.TARGET_DATABASE_SSL === 'true' ? 'true' : 'false' };
  for (const [key, value] of Object.entries(settings)) {
    const line = key + '=' + JSON.stringify(value);
    const regex = new RegExp('^\\s*' + key + '\\s*=.*$', 'gm');
    updated = regex.test(updated) ? updated.replace(regex, () => line) : updated + eol + line + eol;
  }
  const after = dotenv.parse(updated);
  for (const [key, value] of Object.entries(runtime)) {
    if (!(key in settings) && after[key] !== value) throw new Error('Unrelated runtime setting changed: ' + key);
  }
  fs.writeFileSync(configFile, updated);
  const report = { switchedAt: new Date().toISOString(), target: url.hostname + ':' + url.port + url.pathname,
    snapshotFile, sourceSha256: currentSource.sha256, counts, changedKeys: Object.keys(settings),
    tlsEnabled: settings.DATABASE_SSL === 'true', beforeConfigSha256: crypto.createHash('sha256').update(original).digest('hex'),
    afterConfigSha256: crypto.createHash('sha256').update(updated).digest('hex') };
  fs.writeFileSync(path.join(directory, 'cutover.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ switched: true, backupDirectory: directory, changedKeys: report.changedKeys, counts, sourceUnchanged: true, targetVerified: true }, null, 2));
}
main().catch(error => { console.error('Runtime switch failed:', error.code || error.message); process.exitCode = 1; });
