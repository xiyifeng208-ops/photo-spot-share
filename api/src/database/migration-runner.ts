import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/**
 * 极简迁移器：按文件名排序执行 migrations/*.sql，
 * 已执行过的记录在 schema_migrations 表里，支持重复运行。
 */
export async function runMigrations(connectionString: string, logger = console.log) {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        logger(`跳过已执行的迁移 ${file}`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger(`已执行迁移 ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`迁移 ${file} 失败: ${(error as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

