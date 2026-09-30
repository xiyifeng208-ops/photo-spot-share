import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { loadConfig } from '../config/configuration';
import { DatabaseService } from './database.service';

/** Standalone diagnostics: does not load AppModule, cron jobs, .env or .env.local. */
async function main() {
  const env = parse(readFileSync(resolve(process.cwd(), '.env.mysql-check')));
  if (!env.MYSQL_HOST || !env.MYSQL_DATABASE || !env.MYSQL_USER || !env.MYSQL_PASSWORD) {
    throw new Error('请在 api/.env.mysql-check 中填写连接信息和密码；不要修改现有 .env');
  }
  const url = new URL('mysql://localhost');
  url.hostname = env.MYSQL_HOST;
  url.port = env.MYSQL_PORT || '3306';
  url.username = env.MYSQL_USER;
  url.password = env.MYSQL_PASSWORD;
  url.pathname = '/' + env.MYSQL_DATABASE;
  const db = new DatabaseService(loadConfig({ ...env, DATABASE_URL: url.toString() }));
  try {
    console.log(await db.queryOne(`SELECT VERSION() AS version, DATABASE() AS database_name,
      @@session.time_zone AS session_time_zone`));
    console.log((await db.query("SHOW SESSION STATUS WHERE Variable_name IN ('Ssl_cipher', 'Ssl_version')")).rows);
    console.log((await db.query(`SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`)).rows);
    console.log('只读连接检查完成：没有建表、导入或修改业务数据；这不代表完整迁移验收通过。');
  } finally { await db.onModuleDestroy(); }
}

main().catch((error: unknown) => {
  // Avoid printing driver errors/URLs that can contain credentials or query values.
  const code = (error as { code?: string }).code;
  console.error('连接检查未完成。', code || '请检查独立配置文件及运行环境；密码不能为空。');
  process.exitCode = 1;
});
