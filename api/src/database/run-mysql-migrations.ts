import { config as loadEnv } from 'dotenv';
import { runMysqlMigrations } from './mysql-migration-runner';

loadEnv({ path: process.env.MIGRATION_ENV_FILE || '.env.mysql.local' });
async function main() {
  const url = process.env.TARGET_DATABASE_URL;
  if (!url?.startsWith('mysql://')) throw new Error('Set TARGET_DATABASE_URL=mysql://... in .env.mysql.local');
  await runMysqlMigrations(url, process.env.TARGET_DATABASE_SSL === 'true');
}
main().catch(error => { console.error(`[migrate:mysql] ${(error as Error).message}`); process.exitCode = 1; });
