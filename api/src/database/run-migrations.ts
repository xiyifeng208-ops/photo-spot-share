import { config as loadEnv } from 'dotenv';
import { loadConfig } from '../config/configuration';
import { runMigrations } from './migration-runner';

loadEnv();

async function main() {
  const config = loadConfig();
  await runMigrations(config.database.url, (message) => console.log(`[migrate] ${message}`));
}

main().catch((error) => {
  console.error('[migrate] 失败:', error.message);
  process.exit(1);
});

