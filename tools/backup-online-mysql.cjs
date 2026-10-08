const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const api = path.resolve(__dirname, '../api');
const dotenv = require(path.join(api, 'node_modules/dotenv'));
const mysql = require(path.join(api, 'node_modules/mysql2/promise'));
const escape = require(path.join(api, 'node_modules/mysql2')).escape;

async function main() {
  const env = dotenv.parse(fs.readFileSync(path.join(api, '.env.mysql.local')));
  const url = new URL(env.TARGET_DATABASE_URL);
  if (url.hostname !== 'mysql6.sqlpub.com' || url.port !== '3311' || url.pathname !== '/photo_spot_share') throw new Error('Unexpected target');
  const client = await mysql.createConnection({ uri: env.TARGET_DATABASE_URL, timezone: 'Z', dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 10000,
    ssl: env.TARGET_DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
  try {
    await client.query("SET time_zone = '+00:00'");
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await client.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [tables] = await client.query('SHOW FULL TABLES WHERE Table_type = \'BASE TABLE\'');
    const data = {};
    const definitions = {};
    const inserts = [];
    for (const table of tables) {
      const name = Object.values(table)[0];
      if (!/^[a-z_]+$/.test(name)) throw new Error('Unexpected table name');
      const [ddl] = await client.query('SHOW CREATE TABLE `' + name + '`');
      definitions[name] = ddl[0]['Create Table'];
      const [columns] = await client.query('SHOW COLUMNS FROM `' + name + '`');
      const geometry = columns.filter(c => /^(point|geometry|polygon|linestring)/i.test(c.Type)).map(c => c.Field);
      const select = columns.map(c => geometry.includes(c.Field)
        ? 'ST_AsText(`' + c.Field + '`) AS `' + c.Field + '`, ST_SRID(`' + c.Field + '`) AS `__srid_' + c.Field + '`'
        : '`' + c.Field + '`').join(',');
      const [rows] = await client.query('SELECT ' + select + ' FROM `' + name + '`');
      data[name] = rows;
      for (const row of rows) {
        const values = columns.map(c => {
          const value = row[c.Field];
          if (geometry.includes(c.Field) && value !== null) return 'ST_GeomFromText(' + escape(value) + ', ' + Number(row['__srid_' + c.Field]) + ')';
          return escape(value !== null && typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
        });
        inserts.push('INSERT INTO `' + name + '` (' + columns.map(c => '`' + c.Field + '`').join(',') + ') VALUES (' + values.join(',') + ');');
      }
    }
    await client.commit();
    const directory = path.resolve(__dirname, '../backups/online-before-rebuild-' + new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(directory, { recursive: true });
    const sql = ['-- Backup of photo_spot_share before authorized rebuild; contains private data.',
      'USE `photo_spot_share`;', 'SET NAMES utf8mb4;', "SET time_zone = '+00:00';", 'SET FOREIGN_KEY_CHECKS = 0;',
      ...Object.entries(definitions).flatMap(([name, ddl]) => ['DROP TABLE IF EXISTS `' + name + '`;', ddl + ';']),
      ...inserts, 'SET FOREIGN_KEY_CHECKS = 1;', ''].join('\n');
    fs.writeFileSync(path.join(directory, 'restore-old-online.sql'), sql);
    fs.writeFileSync(path.join(directory, 'old-online-data.json'), JSON.stringify(data, null, 2));
    const manifest = { endpoint: url.hostname + ':' + url.port, database: 'photo_spot_share',
      createdAt: new Date().toISOString(), counts: Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length])),
      files: ['restore-old-online.sql', 'old-online-data.json'].map(name => ({ name, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex') })) };
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ directory, counts: manifest.counts, backupWritten: true }, null, 2));
  } finally { await client.end(); }
}
main().catch(error => { console.error('Online backup failed:', error.code || error.name); process.exitCode = 1; });
