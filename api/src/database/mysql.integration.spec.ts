import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { createConnection } from 'mysql2/promise';
import { runMysqlMigrations } from './mysql-migration-runner';
import { exportPostgres, transferMysql, snapshotChecksum } from './transfer-mysql';
import { DatabaseService } from './database.service';
import { loadConfig } from '../config/configuration';

const url = process.env.TEST_MYSQL_TRANSFER_URL;
const describeMysql = url ? describe : describe.skip;

describeMysql('PostgreSQL to MySQL real database migration', () => {
  let snapshot: Awaited<ReturnType<typeof exportPostgres>>;
  beforeAll(async () => {
    if (!new URL(url!).pathname.includes('test')) throw new Error('Use a dedicated test database');
    await runMysqlMigrations(url!, false, () => undefined);
    const env = parse(readFileSync('.env'));
    snapshot = await exportPostgres(process.env.TEST_POSTGRES_SOURCE_URL || env.DATABASE_URL);
  }, 60000);

  it('rolls back all imported rows on a foreign key failure', async () => {
    const broken = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    if (!broken.tables.spots.length) throw new Error('Test source needs at least one spot');
    broken.tables.spots[0].user_id = '00000000-0000-0000-0000-000000000000';
    broken.sha256 = snapshotChecksum(broken.tables);
    await expect(transferMysql(url!, broken)).rejects.toThrow();
    const client = await createConnection(url!);
    try {
      const [rows] = await client.query('SELECT COUNT(*) AS n FROM users');
      expect((rows as { n: number }[])[0].n).toBe(0);
    } finally { await client.end(); }
  });

  it('imports and verifies every field, preserving original IDs, arrays and microseconds', async () => {
    const counts = await transferMysql(url!, snapshot);
    expect(counts.spots).toBe(snapshot.tables.spots.length);
    await expect(transferMysql(url!, snapshot, true)).resolves.toEqual(counts);
  });

  it('refuses to import a second time into populated tables', async () => {
    await expect(transferMysql(url!, snapshot)).rejects.toThrow('not empty');
  });

  it('allows unchanged migrations to run repeatedly', async () => {
    await expect(runMysqlMigrations(url!, false, () => undefined)).resolves.toBeUndefined();
  });

  it('rolls back application transactions without changing imported data', async () => {
    const db = new DatabaseService(loadConfig({ DATABASE_URL: url!, DATABASE_POOL_MAX: '2' }));
    try {
      const result = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM spots WHERE created_at > $1`, ['1900-01-01 00:00:00.000000']);
      expect(Number(result.rows[0].n)).toBe(snapshot.tables.spots.length);
      await expect(db.withTransaction(async client => {
        await client.query('UPDATE spots SET title = $1 WHERE id = $2', ['rollback-title', snapshot.tables.spots[0].id]);
        throw new Error('rollback-test');
      })).rejects.toThrow('rollback-test');
      const spot = await db.queryOne<{ title: string }>('SELECT title FROM spots WHERE id = $1', [snapshot.tables.spots[0].id]);
      expect(spot?.title).toBe(snapshot.tables.spots[0].title);
    } finally { await db.onModuleDestroy(); }
  });
});
