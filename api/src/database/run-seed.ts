import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';
import { loadConfig } from '../config/configuration';

loadEnv();

async function main() {
  const config = loadConfig();
  const client = new Client({ connectionString: config.database.url });
  await client.connect();
  try {
    const sql = readFileSync(join(__dirname, '..', '..', 'seeds', 'dev_seed.sql'), 'utf8');
    await client.query(sql);
    console.log('[seed] 已完成开发种子数据写入');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[seed] 失败:', error.message);
  process.exit(1);
});

