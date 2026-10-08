import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection, type RowDataPacket } from 'mysql2/promise';

export async function runMysqlMigrations(url: string, ssl = false, logger = console.log) {
  const client = await createConnection({ uri: url, timezone: 'Z', multipleStatements: true,
    ssl: ssl ? { rejectUnauthorized: true } : undefined });
  let locked = false;
  try {
    await client.query("SET time_zone = '+00:00'");
    const [lock] = await client.query<RowDataPacket[]>("SELECT GET_LOCK(CONCAT(DATABASE(), ':schema-migrations'), 10) AS acquired");
    if (Number(lock[0].acquired) !== 1) throw new Error('Could not acquire migration lock');
    locked = true;
    const [tables] = await client.query<RowDataPacket[]>(`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`);
    if (tables.some(t => t.name !== 'schema_migrations') && !tables.some(t => t.name === 'schema_migrations')) {
      throw new Error('Target contains existing tables; use a fresh database, not an automatic overwrite');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) COLLATE utf8mb4_bin PRIMARY KEY, checksum CHAR(64) NOT NULL,
      applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
    const [history] = await client.query<RowDataPacket[]>('SELECT name, checksum FROM schema_migrations');
    if (!history.length && tables.some(t => t.name !== 'schema_migrations')) {
      throw new Error('Target has business tables without migration history; stop for manual review');
    }
    const directory = join(__dirname, '../../migrations/mysql');
    for (const name of readdirSync(directory).filter(n => n.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(directory, name), 'utf8').replace(/\r\n/g, '\n');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const applied = history.find(row => row.name === name);
      if (applied) {
        if (applied.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        logger(`跳过已执行的 MySQL 迁移 ${name}`);
        continue;
      }
      // MySQL DDL commits implicitly: never claim schema changes can be rolled back.
      await client.query(sql);
      await client.execute('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [name, checksum]);
      logger(`已执行 MySQL 迁移 ${name}`);
    }
  } finally {
    if (locked) await client.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':schema-migrations'))");
    await client.end();
  }
}
