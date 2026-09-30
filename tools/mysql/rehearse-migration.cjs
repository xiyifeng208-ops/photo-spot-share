// PostgreSQL -> MySQL rehearsal. The target is hard-limited to a local *_rehearsal database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const api = path.join(root, 'api');
const req = createRequire(path.join(api, 'package.json'));
const { parse } = req('dotenv');
const { Client } = req('pg');
const mysql = req('mysql2/promise');
const businessTables = ['users', 'spots', 'spot_best_times', 'spot_best_seasons', 'photos',
  'upload_tickets', 'content_check_tasks', 'spot_reports'];
const allTargetTables = [...businessTables, 'schema_migrations'].sort();
const sourceBackupTables = ['users','spots','photos','upload_tickets','content_check_tasks','spot_reports','schema_migrations'];

function readEnv(name) {
  const file = path.join(api, name);
  return fs.existsSync(file) ? parse(fs.readFileSync(file)) : {};
}

function assertLocalRehearsal(url) {
  if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('TARGET_MUST_BE_LOCAL_MYSQL');
  }
  if (!url.pathname.slice(1).endsWith('_rehearsal')) throw new Error('TARGET_DATABASE_MUST_END_WITH_REHEARSAL');
}

function mysqlOptions(url, extra = {}) {
  return { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), database: url.pathname.slice(1), timezone: 'Z',
    dateStrings: true, supportBigNumbers: true, decimalNumbers: true, ...extra };
}

function remoteUrl() {
  const env = readEnv('.env.mysql-check');
  if (!env.MYSQL_HOST || !env.MYSQL_PORT || !env.MYSQL_DATABASE || !env.MYSQL_USER || !env.MYSQL_PASSWORD) throw new Error('REMOTE_PRIVATE_CONFIG_INCOMPLETE');
  if (env.MYSQL_DATABASE !== 'photo_spot_share') throw new Error('UNEXPECTED_REMOTE_DATABASE');
  if (process.env.MYSQL_REMOTE_MIGRATION_CONFIRM !== 'photo_spot_share:3-users:6-spots') throw new Error('REMOTE_CONFIRMATION_MISSING');
  const url = new URL('mysql://localhost');
  url.hostname=env.MYSQL_HOST; url.port=env.MYSQL_PORT; url.username=env.MYSQL_USER;
  url.password=env.MYSQL_PASSWORD; url.pathname='/'+env.MYSQL_DATABASE;
  return url;
}

function finalBackup() {
  const directory = path.resolve(process.env.MYSQL_MIGRATION_BACKUP_DIR || '');
  const backupRoot = path.join(root,'work','backups') + path.sep;
  if (!directory.startsWith(backupRoot)) throw new Error('FINAL_BACKUP_PATH_INVALID');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const restore=JSON.parse(fs.readFileSync(path.join(directory,'restore-verification.json'),'utf8'));
  const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,'spot.dump'))).digest('hex');
  if (!restore.matches || hash!==manifest.dumpSha256 || restore.dumpSha256!==manifest.dumpSha256) throw new Error('FINAL_BACKUP_NOT_VERIFIED');
  return {directory,manifest};
}

async function verifySourceMatchesBackup(source, backup) {
  for (const table of sourceBackupTables) {
    const order = table==='schema_migrations' ? 'name' : 'id';
    const rows=(await source.query(`SELECT to_jsonb(t)::text canonical FROM ${table} t ORDER BY ${order}`)).rows;
    const hash=crypto.createHash('sha256').update(rows.map(row=>row.canonical).join('\n')).digest('hex');
    const saved=backup.manifest.records[table];
    if (!saved || saved.count!==rows.length || saved.sha256!==hash) throw new Error(`SOURCE_CHANGED_AFTER_FINAL_BACKUP:${table}`);
  }
}

async function preflightRemote(target) {
  const [tables]=await target.query(`SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`);
  if (JSON.stringify(tables.map(row=>row.TABLE_NAME).sort())!==JSON.stringify(allTargetTables)) throw new Error('REMOTE_SCHEMA_TABLE_SET_MISMATCH');
  for (const table of allTargetTables) {
    const [rows]=await target.query(`SELECT COUNT(*) n FROM \`${table}\``);
    if (Number(rows[0].n)!==0) throw new Error(`REMOTE_TARGET_NOT_EMPTY:${table}`);
  }
  const [constraints]=await target.query(`SELECT CONSTRAINT_TYPE type,COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() GROUP BY CONSTRAINT_TYPE`);
  const counts=Object.fromEntries(constraints.map(row=>[row.type,Number(row.n)]));
  if (counts['PRIMARY KEY']!==9 || counts.UNIQUE!==8 || counts['FOREIGN KEY']!==11 || counts.CHECK!==16) throw new Error('REMOTE_CONSTRAINT_COUNT_MISMATCH');
  const [checks]=await target.query(`SELECT ENFORCED FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='CHECK'`);
  if (checks.length!==16 || checks.some(row=>row.ENFORCED!=='YES')) throw new Error('REMOTE_CHECK_NOT_ENFORCED');
  const [spatial]=await target.query(`SELECT c.DATA_TYPE,c.IS_NULLABLE,c.SRS_ID,
    EXISTS(SELECT 1 FROM information_schema.STATISTICS s WHERE s.TABLE_SCHEMA=DATABASE()
      AND s.TABLE_NAME='spots' AND s.INDEX_NAME='spx_spots_location' AND s.INDEX_TYPE='SPATIAL') spatial_index
    FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME='spots' AND c.COLUMN_NAME='location'`);
  if (spatial.length!==1 || spatial[0].DATA_TYPE!=='point' || spatial[0].IS_NULLABLE!=='NO' || Number(spatial[0].SRS_ID)!==0 || Number(spatial[0].spatial_index)!==1) throw new Error('REMOTE_SPATIAL_SCHEMA_MISMATCH');
}

function datetime(value, precision) {
  if (value == null) return null;
  const match = String(value).match(/^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)\.(\d{6})$/);
  if (!match) throw new Error('UNEXPECTED_POSTGRES_TIMESTAMP');
  if (/[1-9]/.test(match[3].slice(3))) precision.truncated += 1;
  return `${match[1]} ${match[2]}.${match[3].slice(0, 3)}`;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function readSource(source, precision) {
  const queries = {
    users: `SELECT id::text, openid, nickname, avatar_url,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') created_at,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') updated_at FROM users ORDER BY id`,
    spots: `SELECT id::text, user_id::text, title, description, lat, lng, province, city, district, address,
      heading::text, best_times::text[], best_seasons::text[], focal_length::text, difficulty,
      access_note, cover_photo_id::text, status::text, view_count,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') created_at,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') updated_at FROM spots ORDER BY id`,
    photos: `SELECT id::text, spot_id::text, user_id::text, object_key, mime, size_bytes::text, width, height,
      sort_order, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') created_at FROM photos ORDER BY id`,
    upload_tickets: `SELECT id::text, user_id::text, object_key, mime, size_bytes::text, width, height, spot_id::text,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') created_at,
      CASE WHEN used_at IS NULL THEN NULL ELSE to_char(used_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') END used_at
      FROM upload_tickets ORDER BY id`,
    content_check_tasks: `SELECT id::text, spot_id::text, trace_id, status, attempts, detail,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') created_at,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') updated_at FROM content_check_tasks ORDER BY id`,
    spot_reports: `SELECT id::text, spot_id::text, reporter_id::text, reason, detail, status,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') created_at FROM spot_reports ORDER BY id`,
  };
  const data = {};
  for (const [name, sql] of Object.entries(queries)) data[name] = (await source.query(sql)).rows;
  for (const row of data.users) { row.created_at = datetime(row.created_at, precision); row.updated_at = datetime(row.updated_at, precision); }
  for (const row of data.spots) { row.created_at = datetime(row.created_at, precision); row.updated_at = datetime(row.updated_at, precision); }
  for (const row of data.photos) row.created_at = datetime(row.created_at, precision);
  for (const row of data.upload_tickets) { row.created_at = datetime(row.created_at, precision); row.used_at = datetime(row.used_at, precision); }
  for (const row of data.content_check_tasks) { row.created_at = datetime(row.created_at, precision); row.updated_at = datetime(row.updated_at, precision); }
  for (const row of data.spot_reports) { row.created_at = datetime(row.created_at, precision); row.updated_at = row.created_at; }
  data.spot_best_times = data.spots.flatMap(row => row.best_times.map((best_time, sort_order) => ({ spot_id: row.id, best_time, sort_order })));
  data.spot_best_seasons = data.spots.flatMap(row => row.best_seasons.map((season, sort_order) => ({ spot_id: row.id, season, sort_order })));
  return data;
}

async function insertTarget(target, data) {
  const execute = (sql, values) => target.execute(sql, values);
  for (const r of data.users) await execute(`INSERT INTO users
    (id,openid,nickname,avatar_url,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
  [r.id,r.openid,r.nickname,r.avatar_url,r.created_at,r.updated_at]);
  for (const r of data.spots) await execute(`INSERT INTO spots
    (id,user_id,title,description,location,lat,lng,province,city,district,address,heading,focal_length,difficulty,access_note,cover_photo_id,status,view_count,created_at,updated_at)
    VALUES (?,?,?,?,POINT(?,?),?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)`,
  [r.id,r.user_id,r.title,r.description,r.lng,r.lat,r.lat,r.lng,r.province,r.city,r.district,r.address,r.heading,
    r.focal_length,r.difficulty,r.access_note,r.status,r.view_count,r.created_at,r.updated_at]);
  for (const r of data.spot_best_times) await execute('INSERT INTO spot_best_times (spot_id,best_time,sort_order) VALUES (?,?,?)',[r.spot_id,r.best_time,r.sort_order]);
  for (const r of data.spot_best_seasons) await execute('INSERT INTO spot_best_seasons (spot_id,season,sort_order) VALUES (?,?,?)',[r.spot_id,r.season,r.sort_order]);
  for (const r of data.photos) await execute(`INSERT INTO photos
    (id,spot_id,user_id,object_key,mime,size_bytes,width,height,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  [r.id,r.spot_id,r.user_id,r.object_key,r.mime,r.size_bytes,r.width,r.height,r.sort_order,r.created_at]);
  for (const r of data.spots.filter(row => row.cover_photo_id)) await execute('UPDATE spots SET cover_photo_id=?, updated_at=? WHERE id=?',[r.cover_photo_id,r.updated_at,r.id]);
  for (const r of data.upload_tickets) await execute(`INSERT INTO upload_tickets
    (id,user_id,object_key,mime,size_bytes,width,height,spot_id,created_at,used_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  [r.id,r.user_id,r.object_key,r.mime,r.size_bytes,r.width,r.height,r.spot_id,r.created_at,r.used_at]);
  for (const r of data.content_check_tasks) await execute(`INSERT INTO content_check_tasks
    (id,spot_id,trace_id,status,attempts,detail,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  [r.id,r.spot_id,r.trace_id,r.status,r.attempts,r.detail,r.created_at,r.updated_at]);
  for (const r of data.spot_reports) await execute(`INSERT INTO spot_reports
    (id,spot_id,reporter_id,reason,detail,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  [r.id,r.spot_id,r.reporter_id,r.reason,r.detail,r.status,r.created_at,r.updated_at]);
}

async function readTarget(target) {
  const q = async sql => (await target.query(sql))[0];
  const data = {};
  data.users = await q('SELECT id,openid,nickname,avatar_url,created_at,updated_at FROM users ORDER BY id');
  data.spots = await q(`SELECT id,user_id,title,description,lat,lng,province,city,district,address,heading,focal_length,
    difficulty,access_note,cover_photo_id,status,view_count,created_at,updated_at FROM spots ORDER BY id`);
  data.spot_best_times = await q('SELECT spot_id,best_time,sort_order FROM spot_best_times ORDER BY spot_id,sort_order');
  data.spot_best_seasons = await q('SELECT spot_id,season,sort_order FROM spot_best_seasons ORDER BY spot_id,sort_order');
  data.photos = await q('SELECT id,spot_id,user_id,object_key,mime,size_bytes,width,height,sort_order,created_at FROM photos ORDER BY id');
  data.upload_tickets = await q('SELECT id,user_id,object_key,mime,size_bytes,width,height,spot_id,created_at,used_at FROM upload_tickets ORDER BY id');
  data.content_check_tasks = await q('SELECT id,spot_id,trace_id,status,attempts,detail,created_at,updated_at FROM content_check_tasks ORDER BY id');
  data.spot_reports = await q('SELECT id,spot_id,reporter_id,reason,detail,status,created_at,updated_at FROM spot_reports ORDER BY id');
  return data;
}

function canonical(data) {
  return Object.fromEntries(businessTables.map(name => [name, data[name].map(row => {
    const result = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'best_times' || key === 'best_seasons') continue;
      result[key] = typeof value === 'bigint' ? value.toString() : value;
    }
    return result;
  })]));
}

async function main() {
  const remoteMode=process.argv.includes('--remote');
  const targetUrl = remoteMode ? remoteUrl() : new URL(process.env.MYSQL_REHEARSAL_URL || '');
  if (!remoteMode) assertLocalRehearsal(targetUrl);
  const backup = remoteMode ? finalBackup() : null;
  const env = { ...readEnv('.env'), ...readEnv('.env.local') };
  const sourceUrl = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(sourceUrl.protocol) || !['localhost','127.0.0.1','[::1]'].includes(sourceUrl.hostname)) throw new Error('SOURCE_MUST_BE_LOCAL_POSTGRES');

  if (!remoteMode) {
    const bootstrap = await mysql.createConnection(mysqlOptions(targetUrl, { multipleStatements: true }));
    try {
      const [tables] = await bootstrap.query(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()`);
      if (tables.length) throw new Error('REHEARSAL_TARGET_MUST_START_EMPTY');
      await bootstrap.query(fs.readFileSync(path.join(api,'mysql-migrations/0001_mysql_baseline.sql'),'utf8'));
    } finally { await bootstrap.end(); }
  }

  const source = new Client({ connectionString: sourceUrl.toString(), connectionTimeoutMillis: 5000, application_name: remoteMode?'mysql_remote_migration':'mysql_migration_rehearsal' });
  const target = await mysql.createConnection(mysqlOptions(targetUrl));
  const precision = { truncated: 0 };
  try {
    await source.connect();
    await source.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await source.query("SET LOCAL TIME ZONE 'UTC'");
    await target.query("SET SESSION time_zone='+00:00'");
    if (remoteMode) {
      await verifySourceMatchesBackup(source, backup);
      await preflightRemote(target);
    }
    await target.beginTransaction();
    const expected = await readSource(source, precision);
    await insertTarget(target, expected);
    const actual = await readTarget(target);
    const expectedCanonical = canonical(expected);
    const actualCanonical = canonical(actual);
    const verification = {};
    for (const table of businessTables) verification[table] = {
      sourceRows: expectedCanonical[table].length, targetRows: actualCanonical[table].length,
      sourceHash: digest(expectedCanonical[table]), targetHash: digest(actualCanonical[table]),
      matches: digest(expectedCanonical[table]) === digest(actualCanonical[table]),
    };
    const [spatial] = await target.query('SELECT COUNT(*) n FROM spots WHERE ST_X(location)<>lng OR ST_Y(location)<>lat OR ST_SRID(location)<>0');
    const [history] = await target.query('SELECT COUNT(*) n FROM schema_migrations');
    if (Object.values(verification).some(item => !item.matches) || Number(spatial[0].n)!==0 || Number(history[0].n)!==0) throw new Error('SEMANTIC_VERIFICATION_FAILED');
    await target.commit();
    await source.query('ROLLBACK');
    console.log(JSON.stringify({ completedAt:new Date().toISOString(), mode:remoteMode?'remote':'rehearsal',
      finalBackupSha256:backup?.manifest.dumpSha256, target:{host:targetUrl.hostname,port:targetUrl.port,database:targetUrl.pathname.slice(1)},
      utc:true, millisecondPolicy:'truncate PostgreSQL fractional seconds to three digits', timestampsWithDiscardedMicroseconds:precision.truncated,
      spatialMismatches:Number(spatial[0].n), schemaMigrationRows:Number(history[0].n), verification }, null, 2));
  } catch (error) {
    try { await target.rollback(); } catch {}
    try { await source.query('ROLLBACK'); } catch {}
    throw error;
  } finally { await source.end().catch(()=>{}); await target.end(); }
}

main().catch(error => { console.error(error.code || error.message); process.exitCode=1; });
