// Backup artifact generation and isolated restore verification; never writes source data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const req = createRequire(path.join(root, 'api/package.json'));
const { parse } = req('dotenv');
const { Client } = req('pg');
const tables = ['users','spots','photos','upload_tickets','content_check_tasks','spot_reports','schema_migrations'];
const backups = path.join(root,'work/backups');
const bin = path.join(root,'work/pg/pgsql/bin');
function run(name, url, args) {
  const result = spawnSync(path.join(bin,name+'.exe'),args,{ windowsHide:true, encoding:'utf8', env:{...process.env,
    PGHOST:url.hostname, PGPORT:url.port||'5432', PGDATABASE:url.pathname.slice(1),
    PGUSER:decodeURIComponent(url.username), PGPASSWORD:decodeURIComponent(url.password), PGCONNECT_TIMEOUT:'10'} });
  if (result.status!==0) throw new Error(`${name} failed (${result.status}); backup/restore not certified`);
}
async function inventory(db) {
  await db.query("SET LOCAL TIME ZONE 'UTC'");
  const result={};
  for(const table of tables) {
    const rows=(await db.query(`SELECT to_jsonb(t)::text AS canonical FROM ${table} t ORDER BY ${table==='schema_migrations'?'name':'id'}`)).rows;
    result[table]={count:rows.length,sha256:crypto.createHash('sha256').update(rows.map(r=>r.canonical).join('\n')).digest('hex')};
  }
  return result;
}
async function main() {
  const verify=process.argv[2]==='verify';
  const readEnv=name=>fs.existsSync(path.join(root,'api',name))?parse(fs.readFileSync(path.join(root,'api',name))):{};
  const env={...readEnv('.env'),...readEnv('.env.local')};
  const url=new URL(verify?process.env.VERIFY_DATABASE_URL:env.DATABASE_URL);
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('Local PostgreSQL required');
  if(verify&&(!url.pathname.endsWith('_test')||url.port==='5432'||!url.port)) throw new Error('Restore requires an isolated non-source port and _test database');
  const db=new Client({connectionString:url.toString(),connectionTimeoutMillis:5000});
  await db.connect();
  try {
    if(!verify) {
      fs.mkdirSync(backups,{recursive:true});
      const stamp=new Date().toISOString().slice(0,10).replace(/-/g,'');
      const dir=fs.mkdtempSync(path.join(backups,`docker-spot-${stamp}-`));
      await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot=(await db.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
      const records=await inventory(db);
      run('pg_dump',url,['--format=custom','--no-owner','--no-privileges',`--snapshot=${snapshot}`,`--file=${path.join(dir,'spot.dump')}`]);
      await db.query('ROLLBACK');
      const manifest={at:new Date().toISOString(),source:{host:url.hostname,port:url.port||'5432',database:url.pathname.slice(1)},
        snapshotConsistent:true, records, dumpSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'spot.dump'))).digest('hex')};
      fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
      console.log(JSON.stringify({directory:dir,...manifest},null,2));
    } else {
      const dir=path.resolve(process.argv[3]||'');
      if(!dir.startsWith(backups+path.sep)) throw new Error('Backup directory must be within work/backups');
      const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
      const digest=crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'spot.dump'))).digest('hex');
      if(digest!==manifest.dumpSha256) throw new Error('Backup checksum mismatch');
      const occupied=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'spatial_ref_sys'")).rows;
      if(occupied.length) throw new Error('Restore test database must be empty');
      const extraSchemas=(await db.query("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'")).rows;
      if(extraSchemas.length) throw new Error('Restore test database must be created from template0 without preinstalled extension schemas');
      run('pg_restore',url,['--exit-on-error','--no-owner','--no-privileges','--dbname',url.pathname.slice(1),path.join(dir,'spot.dump')]);
      await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const records=await inventory(db);
      await db.query('ROLLBACK');
      const matches=JSON.stringify(records)===JSON.stringify(manifest.records);
      const verification={at:new Date().toISOString(),matches,records,dumpSha256:digest};
      fs.writeFileSync(path.join(dir,'restore-verification.json'),JSON.stringify(verification,null,2),{flag:'wx'});
      console.log(JSON.stringify(verification,null,2));
      if(!matches) throw new Error('Restored data differs from source snapshot');
    }
  } finally { await db.end(); }
}
main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
