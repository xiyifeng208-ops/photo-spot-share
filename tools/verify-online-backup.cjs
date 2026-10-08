const fs = require('node:fs');
const path = require('node:path');
const api = path.resolve(__dirname, '../api');
const mysql = require(path.join(api, 'node_modules/mysql2/promise'));
const crypto = require('node:crypto');

async function main() {
  const directory = path.resolve(process.argv[2]);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  for (const file of manifest.files) {
    if (crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file.name))).digest('hex') !== file.sha256) throw new Error('Backup checksum mismatch');
  }
  // Hard-coded local validation endpoint: never execute restore SQL against online DB.
  const client = await mysql.createConnection({ host: '127.0.0.1', port: 3307, user: 'root', multipleStatements: true,
    dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
  try {
    await client.query('CREATE DATABASE IF NOT EXISTS photo_spot_share CHARACTER SET utf8mb4');
    await client.query(fs.readFileSync(path.join(directory, 'restore-old-online.sql'), 'utf8'));
    const original = JSON.parse(fs.readFileSync(path.join(directory, 'old-online-data.json')));
    function canonical(value) {
      if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
      if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
      return JSON.stringify(value);
    }
    for (const [table, rows] of Object.entries(original)) {
      const [columns] = await client.query('SHOW COLUMNS FROM `' + table + '`');
      const select = columns.map(c => /^(point|geometry|polygon|linestring)/i.test(c.Type)
        ? 'ST_AsText(`' + c.Field + '`) AS `' + c.Field + '`, ST_SRID(`' + c.Field + '`) AS `__srid_' + c.Field + '`'
        : '`' + c.Field + '`').join(',');
      const [actual] = await client.query('SELECT ' + select + ' FROM `' + table + '`');
      const expectedRows = rows.map(canonical).sort();
      const actualRows = actual.map(canonical).sort();
      if (JSON.stringify(expectedRows) !== JSON.stringify(actualRows)) throw new Error('Restore mismatch: ' + table);
    }
    fs.writeFileSync(path.join(directory, 'restore-verification.json'), JSON.stringify({
      verifiedAt: new Date().toISOString(), restoredTo: '127.0.0.1:3307/photo_spot_share',
      completeFieldComparisonPassed: true, counts: manifest.counts,
    }, null, 2));
    console.log('Old online SQL backup restored to local test server; all fields match.');
  } finally { await client.end(); }
}
main().catch(error => { console.error('Backup verification failed:', error.code || error.message); process.exitCode = 1; });
