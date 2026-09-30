// Read-only inventory. No application bootstrap, migrations, schedules, or data writes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const api = path.join(root, 'api');
const req = createRequire(path.join(api, 'package.json'));
const { parse } = req('dotenv');
const mysql = req('mysql2/promise');
const { Client } = req('pg');
const envFile = name => fs.existsSync(path.join(api, name)) ? parse(fs.readFileSync(path.join(api, name))) : {};
const names = ['users','spots','photos','upload_tickets','content_check_tasks','spot_reports'];
const remoteNames = [...names, 'spot_best_times','spot_best_seasons','schema_migrations'];

async function remoteAudit() {
  const e = envFile('.env.mysql-check');
  if (e.NODE_ENV !== 'development' || e.DATABASE_SSL !== 'false' || e.DATABASE_ALLOW_INSECURE_REMOTE !== 'true') {
    throw new Error('AUDIT_REQUIRES_EXPLICIT_DEVELOPMENT_CONFIGURATION');
  }
  const db = await mysql.createConnection({ host: e.MYSQL_HOST, port: Number(e.MYSQL_PORT || 3306),
    user: e.MYSQL_USER, password: e.MYSQL_PASSWORD, database: e.MYSQL_DATABASE,
    connectTimeout: 10000, timezone: 'Z', multipleStatements: false });
  const q = async sql => (await db.query(sql))[0];
  try {
    await q('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await q('START TRANSACTION READ ONLY');
    const result = { info: await q('SELECT VERSION() AS version, DATABASE() AS db, @@session.time_zone AS session_timezone, @@sql_mode AS sql_mode'),
      tls: await q("SHOW SESSION STATUS WHERE Variable_name IN ('Ssl_cipher','Ssl_version')"),
      tables: await q('SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME'),
      counts: {}, ddl: {},
      checks: await q(`SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.ENFORCED, cc.CHECK_CLAUSE
        FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc
        ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.CONSTRAINT_TYPE='CHECK' ORDER BY tc.TABLE_NAME,tc.CONSTRAINT_NAME`),
      constraints: await q(`SELECT CONSTRAINT_TYPE, COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE() GROUP BY CONSTRAINT_TYPE`),
      spatial: await q(`SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, SRS_ID FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='spots' AND COLUMN_NAME='location'`),
      grants: await q('SHOW GRANTS FOR CURRENT_USER') };
    for (const name of remoteNames) {
      result.counts[name] = (await q(`SELECT COUNT(*) AS n FROM \`${name}\``))[0].n;
      result.ddl[name] = (await q(`SHOW CREATE TABLE \`${name}\``))[0]['Create Table'];
    }
    await q('ROLLBACK');
    return result;
  } finally { await db.end(); }
}

async function localAudit() {
  const e = { ...envFile('.env'), ...envFile('.env.local') };
  const u = new URL(e.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['localhost','127.0.0.1','[::1]'].includes(u.hostname)) throw new Error('NOT_LOCAL_POSTGRES');
  const db = new Client({ connectionString: e.DATABASE_URL, connectionTimeoutMillis: 5000,
    statement_timeout: 20000, application_name: 'migration_readonly_audit' });
  try {
    await db.connect();
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const q = async sql => (await db.query(sql)).rows;
    const result = { endpoint: { host: u.hostname, port: u.port || '5432', database: u.pathname.slice(1),
      config: fs.existsSync(path.join(api,'.env.local')) ? '.env.local overrides .env' : '.env', processOverridePresent: !!process.env.DATABASE_URL },
      info: await q("SELECT version(), current_database(), current_setting('data_directory') AS data_directory, current_setting('transaction_read_only') AS read_only"),
      tables: await q("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"),
      migrations: await q('SELECT name FROM schema_migrations ORDER BY name'), counts: {}, checks: {}, sourceFields: {},
      maxima: {}, timestampSubmillisecond: {}, expectedAssociationRows: {}, storage: {}, seedComparison: {} };
    const data = {};
    for (const name of names) {
      result.sourceFields[name] = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${name}' ORDER BY ordinal_position`)).map(r => r.column_name);
      data[name] = (await q(`SELECT to_jsonb(t) ${name === 'spots' ? "- 'location'" : ''} AS row FROM ${name} t`)).map(r => r.row);
      result.counts[name] = data[name].length;
    }
    const check = (name, rows) => { result.checks[name] = { count: rows.length, sampleIds: rows.slice(0,10).map(r => r.id) }; };
    const lengths = { users: {openid:128,nickname:24,avatar_url:512}, spots: {title:40,description:1000,province:64,city:64,district:64,address:256,heading:2,focal_length:16,access_note:300,status:16},
      photos: {object_key:512,mime:64}, upload_tickets:{object_key:512,mime:64}, content_check_tasks:{trace_id:128,status:16,detail:500},spot_reports:{reason:64,detail:200,status:16} };
    for (const name of names) {
      result.maxima[name] = {};
      for (const [field,limit] of Object.entries(lengths[name])) {
        result.maxima[name][field] = Math.max(0, ...data[name].map(r => r[field] == null ? 0 : [...r[field]].length));
        check(`${name}.${field}.overlength`,data[name].filter(r => r[field] != null && [...r[field]].length > limit));
      }
      check(`${name}.invalid_uuid`,data[name].filter(r => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.id)));
      result.timestampSubmillisecond[name] = data[name].filter(r => Object.entries(r).some(([k,v]) => /_at$/.test(k) && typeof v==='string' && /\.\d{3}[0-9]*[1-9][0-9]*(?:Z|[+-]\d\d:\d\d)$/.test(v))).length;
      check(`${name}.invalid_mysql_datetime`,data[name].filter(r => Object.entries(r).some(([k,v]) => /_at$/.test(k) && v != null && (!Number.isFinite(Date.parse(v)) || +v.slice(0,4)<1000 || +v.slice(0,4)>9999))));
    }
    const duplicate = (table, fields) => {
      const seen = new Set(); const dup = [];
      for (const r of data[table]) {
        if (fields.some(f => r[f]==null)) continue;
        const key = JSON.stringify(fields.map(f=>r[f]));
        if (seen.has(key)) dup.push(r); seen.add(key);
      }
      check(`${table}.duplicate_${fields.join('_')}`,dup);
    };
    duplicate('users',['openid']); duplicate('photos',['object_key']); duplicate('photos',['spot_id','sort_order']);
    duplicate('upload_tickets',['object_key']); duplicate('content_check_tasks',['trace_id']); duplicate('spot_reports',['spot_id','reporter_id']);
    for (const [table,fields] of Object.entries({users:['openid'],photos:['object_key','mime'],upload_tickets:['object_key','mime'],content_check_tasks:['trace_id']})) {
      check(`${table}.non_ascii`,data[table].filter(r=>fields.some(f=>r[f]!=null&&/[^\x00-\x7f]/.test(r[f]))));
    }
    const users = new Map(data.users.map(r=>[r.id,r])); const spots = new Map(data.spots.map(r=>[r.id,r])); const photos = new Map(data.photos.map(r=>[r.id,r]));
    check('spots.orphan_user',data.spots.filter(r=>!users.has(r.user_id)));
    for (const name of ['photos','upload_tickets']) {
      check(`${name}.orphan_user`,data[name].filter(r=>!users.has(r.user_id)));
      check(`${name}.orphan_spot`,data[name].filter(r=>r.spot_id!=null&&!spots.has(r.spot_id)));
      check(`${name}.owner_mismatch`,data[name].filter(r=>r.spot_id!=null&&spots.get(r.spot_id)?.user_id!==r.user_id));
      check(`${name}.invalid_dimensions`,data[name].filter(r=>['size_bytes','width','height'].some(f=>r[f]!=null&&(!Number.isInteger(r[f])||r[f]<=0))));
      check(`${name}.dimensions_overflow`,data[name].filter(r=>['width','height'].some(f=>r[f]!=null&&r[f]>4294967295)));
    }
    check('photos.invalid_sort_order',data.photos.filter(r=>r.sort_order<0||r.sort_order>255));
    check('spots.invalid_cover',data.spots.filter(r=>r.cover_photo_id!=null&&photos.get(r.cover_photo_id)?.spot_id!==r.id));
    check('spots.without_photos',data.spots.filter(r=>!data.photos.some(p=>p.spot_id===r.id)));
    check('spots.over_nine_photos',data.spots.filter(r=>data.photos.filter(p=>p.spot_id===r.id).length>9));
    check('spots.invalid_coordinates',data.spots.filter(r=>!Number.isFinite(r.lat)||!Number.isFinite(r.lng)||Math.abs(r.lat)>90||Math.abs(r.lng)>180));
    check('spots.invalid_view_count',data.spots.filter(r=>r.view_count<0));
    check('spots.invalid_difficulty',data.spots.filter(r=>![1,2,3].includes(r.difficulty)));
    for (const [field,allowed] of Object.entries({status:['pending','active','hidden','deleted'],heading:['N','NE','E','SE','S','SW','W','NW'],focal_length:['ultrawide','standard','tele','macro','drone']})) {
      check(`spots.invalid_${field}`,data.spots.filter(r=>r[field]!=null&&!allowed.includes(r[field])));
    }
    for (const [field,allowed] of Object.entries({best_times:['sunrise','morning','noon','afternoon','sunset','blue_hour','night'],best_seasons:['spring','summer','autumn','winter']})) {
      check(`spots.invalid_${field}`,data.spots.filter(r=>!Array.isArray(r[field])||r[field].some(v=>!allowed.includes(v))||new Set(r[field]).size!==r[field].length));
      result.expectedAssociationRows[field] = data.spots.reduce((sum,r)=>sum+(r[field]?.length||0),0);
    }
    check('spots.location_mismatch',await q('SELECT id FROM spots WHERE ST_X(location::geometry) IS DISTINCT FROM lng OR ST_Y(location::geometry) IS DISTINCT FROM lat OR ST_SRID(location::geometry)<>4326'));
    for (const [table,allowed] of Object.entries({content_check_tasks:['pending','pass','risky','failed'],spot_reports:['open','resolved','rejected']})) {
      check(`${table}.invalid_status`,data[table].filter(r=>!allowed.includes(r.status)));
      check(`${table}.orphan_spot`,data[table].filter(r=>!spots.has(r.spot_id)));
    }
    check('content_check_tasks.invalid_attempts',data.content_check_tasks.filter(r=>r.attempts<0||r.attempts>4294967295));
    check('spot_reports.orphan_reporter',data.spot_reports.filter(r=>!users.has(r.reporter_id)));
    const seed = fs.readFileSync(path.join(api,'seeds/dev_seed.sql'),'utf8');
    result.seedComparison = { usersWithIdsInSeed:data.users.filter(r=>seed.includes(r.id)).length,
      spotsWithIdsInSeed:data.spots.filter(r=>seed.includes(r.id)).length,
      devUsers:data.users.filter(r=>r.openid.startsWith('dev:')).length };
    result.idFingerprint = Object.fromEntries(names.map(n=>[n,crypto.createHash('sha256').update(data[n].map(r=>r.id).sort().join('\n')).digest('hex')]));
    const storageRoot = path.resolve(api,e.LOCAL_STORAGE_DIR||'var/uploads');
    let files=0,bytes=0;
    function scan(dir) { if (!fs.existsSync(dir)) return; for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const p=path.join(dir,entry.name); if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) scan(p); else if(entry.isFile()) {files++;bytes+=fs.statSync(p).size;}
    } }
    scan(storageRoot);
    result.storage={driver:e.STORAGE_DRIVER||'local',root:storageRoot,exists:fs.existsSync(storageRoot),files,bytes,
      alternativeRootExists:fs.existsSync(path.join(root,e.LOCAL_STORAGE_DIR||'var/uploads'))};
    check('photos.missing_local_file',data.photos.filter(r=>{ const p=path.resolve(storageRoot,r.object_key);return !p.startsWith(storageRoot+path.sep)||!fs.existsSync(p); }));
    await db.query('ROLLBACK');
    return result;
  } finally { await db.end(); }
}

(async()=>{
  const result={at:new Date().toISOString(),readOnly:true};
  for (const [key,fn] of [['remote',remoteAudit],['local',localAudit]]) {
    try {result[key]=await fn();} catch(error) { result[key]={error:error.code||error.name||'UNKNOWN'}; process.exitCode=1; }
  }
  console.log(JSON.stringify(result,null,2));
})().catch(()=>{console.error('AUDIT_FAILED');process.exitCode=1;});
