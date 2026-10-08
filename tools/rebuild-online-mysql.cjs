// Explicit cutover tool for the user's already-authorized old-table rebuild.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const api = path.resolve(__dirname, '../api');
const dotenv = require(path.join(api, 'node_modules/dotenv'));
const mysql = require(path.join(api, 'node_modules/mysql2/promise'));
async function main() {
  const directory = path.resolve(process.argv[2]);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  const verification = JSON.parse(fs.readFileSync(path.join(directory, 'restore-verification.json')));
  if (!verification.completeFieldComparisonPassed || manifest.database !== 'photo_spot_share') throw new Error('Verified backup required');
  for (const file of manifest.files) {
    if (crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file.name))).digest('hex') !== file.sha256) throw new Error('Backup changed');
  }
  const env = dotenv.parse(fs.readFileSync(path.join(api, '.env.mysql.local')));
  const url = new URL(env.TARGET_DATABASE_URL);
  if (url.hostname !== 'mysql6.sqlpub.com' || url.port !== '3311' || url.pathname !== '/photo_spot_share') throw new Error('Unexpected target');
  const expected = ['content_check_tasks','photos','schema_migrations','spot_best_seasons','spot_best_times','spot_reports','spots','upload_tickets','users'].sort();
  const client = await mysql.createConnection({ uri: env.TARGET_DATABASE_URL, connectTimeout: 10000,
    ssl: env.TARGET_DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
  try {
    const [tables] = await client.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME');
    if (JSON.stringify(tables.map(t => t.name).sort()) !== JSON.stringify(expected)) throw new Error('Target table set changed; rebuild refused');
    for (const name of expected) {
      const [rows] = await client.query('SELECT COUNT(*) AS n FROM `' + name + '`');
      if (Number(rows[0].n) !== manifest.counts[name]) throw new Error('Target count changed: ' + name);
    }
    // Only the known nine old tables in this one authorized database are removed.
    await client.query('SET FOREIGN_KEY_CHECKS=0');
    try {
      for (const name of expected) await client.query('DROP TABLE `' + name + '`');
    } finally { await client.query('SET FOREIGN_KEY_CHECKS=1'); }
    console.log('Authorized old nine tables removed from photo_spot_share; verified local backup retained.');
  } finally { await client.end(); }
}
main().catch(error => { console.error('Rebuild failed:', error.code || error.message); process.exitCode = 1; });
