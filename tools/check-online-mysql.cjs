// Read-only connection probe. Never log connection URLs or passwords.
const fs = require('node:fs');
const path = require('node:path');
const api = path.resolve(__dirname, '../api');
const dotenv = require(path.join(api, 'node_modules/dotenv'));
const mysql = require(path.join(api, 'node_modules/mysql2/promise'));

async function main() {
  const file = path.join(api, '.env.mysql.local');
  if (!fs.existsSync(file)) throw Object.assign(new Error(), { code: 'MISSING_LOCAL_CONFIG' });
  const env = dotenv.parse(fs.readFileSync(file));
  let url;
  try { url = new URL(env.TARGET_DATABASE_URL); }
  catch { throw Object.assign(new Error(), { code: 'INVALID_TARGET_URL' }); }
  if (url.protocol !== 'mysql:' || url.hostname !== 'mysql6.sqlpub.com' || url.port !== '3311' || url.pathname !== '/photo_spot_share') {
    throw Object.assign(new Error(), { code: 'TARGET_DOES_NOT_MATCH_AUTHORIZED_DATABASE' });
  }
  const ssl = process.argv.includes('--tls') || env.TARGET_DATABASE_SSL === 'true';
  const client = await mysql.createConnection({ uri: env.TARGET_DATABASE_URL, timezone: 'Z',
    connectTimeout: 10000, ssl: ssl ? { rejectUnauthorized: true } : undefined });
  try {
    const query = async sql => {
      try { return (await client.query({ sql, timeout: 10000 }))[0]; }
      catch (error) { error.probeSql = sql; throw error; }
    };
    const identity = await query('SELECT VERSION() AS version, DATABASE() AS database_name, CURRENT_USER() AS account');
    const tables = await query('SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME');
    const counts = {};
    const allowed = ['users','spots','photos','upload_tickets','spot_reports','content_check_tasks','spot_best_times','spot_best_seasons','schema_migrations'];
    for (const table of tables) {
      if (allowed.includes(table.name)) counts[table.name] = (await query('SELECT COUNT(*) AS n FROM `' + table.name + '`'))[0].n;
    }
    const tls = await query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    const grants = await query('SHOW GRANTS FOR CURRENT_USER');
    const capabilities = await query(`SELECT ST_SRID(POINT(121.49,31.24)) AS point_srid,
      JSON_SCHEMA_VALID('{"type":"array"}', JSON_ARRAY('sunset')) AS json_schema_valid,
      UTC_TIMESTAMP(6) AS utc_now`);
    console.log(JSON.stringify({ endpoint: url.hostname + ':' + url.port, identity, tlsRequested: ssl,
      tlsCipher: tls[0]?.Value || '', tables, counts, grants, capabilities }, null, 2));
  } finally { await client.end(); }
}
main().catch(error => {
  console.error('Connection check failed:', error.code || error.name);
  if (error.probeSql) console.error('Read-only query:', error.probeSql, '\nServer:', error.sqlMessage);
  process.exitCode = 1;
});
