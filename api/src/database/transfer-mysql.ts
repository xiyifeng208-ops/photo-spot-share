import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';
import { createConnection, type Connection, type RowDataPacket, type ExecuteValues } from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TABLES = ['users', 'spots', 'photos', 'upload_tickets', 'spot_reports', 'content_check_tasks'] as const;
type Table = typeof TABLES[number];
type Row = Record<string, unknown>;
interface ExportFile { version: 1; exportedAt: string; tables: Record<Table, Row[]>; sha256: string }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const row = value as Row;
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
export function snapshotChecksum(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
const hash = snapshotChecksum;

export async function exportPostgres(url: string): Promise<ExportFile> {
  if (!url.startsWith('postgres')) throw new Error('Source must be PostgreSQL');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = {} as Record<Table, Row[]>;
    for (const table of TABLES) {
      const metadata = (await client.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows;
      if (!metadata.length) throw new Error(`Missing source table: ${table}`);
      const columns = metadata.flatMap(column => {
        const name = column.column_name;
        if (!/^[a-z_]+$/.test(name)) throw new Error('Unexpected source column');
        if (name === 'location') return ['ST_X(location::geometry) AS location_x', 'ST_Y(location::geometry) AS location_y'];
        if (column.data_type === 'timestamp with time zone') return [`to_char(${name} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS ${name}`];
        if (column.data_type === 'ARRAY') return [`${name}::text[] AS ${name}`];
        return [name];
      });
      tables[table] = (await client.query(`SELECT ${columns.join(',')} FROM public.${table} ORDER BY id`)).rows;
    }
    await client.query('COMMIT');
    const result: ExportFile = { version: 1, exportedAt: new Date().toISOString(), tables, sha256: hash(tables) };
    validateExport(result);
    return result;
  } finally { await client.end(); }
}

function validateExport(file: ExportFile) {
  if (file.version !== 1 || hash(file.tables) !== file.sha256) throw new Error('Export checksum/version mismatch');
  for (const table of TABLES) {
    if (!Array.isArray(file.tables[table])) throw new Error(`Missing export table: ${table}`);
    for (const row of file.tables[table]) {
      for (const key of ['openid', 'city', 'object_key', 'trace_id']) {
        if (typeof row[key] === 'string' && Array.from(row[key]).length > 512) throw new Error(`${table}.${key} exceeds target capacity; stop instead of truncating`);
      }
      if (table === 'spots' && (row.lat !== row.location_y || row.lng !== row.location_x)) throw new Error(`Coordinate mismatch in spot ${row.id}`);
    }
  }
}

async function readMysql(client: Connection, file: ExportFile): Promise<Record<Table, Row[]>> {
  const tables = {} as Record<Table, Row[]>;
  for (const table of TABLES) {
    const [rows] = await client.query<RowDataPacket[]>(table === 'spots'
      ? 'SELECT *, ST_X(location) AS location_x, ST_Y(location) AS location_y FROM spots ORDER BY id'
      : `SELECT * FROM ${table} ORDER BY id`);
    tables[table] = rows.map(raw => {
      const row = { ...raw };
      delete row.location;
      for (const [key, value] of Object.entries(row)) {
        if (key.endsWith('_at') && typeof value === 'string') {
          const [date, fraction = ''] = value.split('.');
          row[key] = date + '.' + fraction.padEnd(6, '0');
        }
      }
      return row;
    });
    if (hash(tables[table]) !== hash(file.tables[table])) throw new Error(`Full field comparison failed: ${table}`);
  }
  return tables;
}

export async function transferMysql(url: string, file: ExportFile, verifyOnly = false, ssl = false) {
  validateExport(file);
  if (!url.startsWith('mysql://')) throw new Error('Target must be MySQL');
  const client = await createConnection({ uri: url, timezone: 'Z', dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true,
    ssl: ssl ? { rejectUnauthorized: true } : undefined });
  try {
    await client.query("SET time_zone = '+00:00'");
    const expected = createHash('sha256').update(readFileSync(resolve(__dirname, '../../migrations/mysql/0001_init.sql'), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    const [history] = await client.execute<RowDataPacket[]>('SELECT checksum FROM schema_migrations WHERE name = ?', ['0001_init.sql']);
    if (history[0]?.checksum !== expected) throw new Error('Target schema has not been initialized with the current MySQL migration');
    if (verifyOnly) {
      await client.query('START TRANSACTION READ ONLY');
      await readMysql(client, file);
      await client.commit();
    } else {
      await client.beginTransaction();
      for (const table of TABLES) {
        const [rows] = await client.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`);
        if (Number(rows[0].n) !== 0) throw new Error(`Target table ${table} is not empty; import refused`);
      }
      for (const table of TABLES) {
        for (const original of file.tables[table]) {
          const row = { ...original };
          if (table === 'spots') row.cover_photo_id = null;
          const columns = Object.keys(row).filter(key => !['location_x', 'location_y'].includes(key));
          if (columns.some(key => !/^[a-z_]+$/.test(key))) throw new Error('Unexpected column in export');
          const values = columns.map(key => Array.isArray(row[key]) ? JSON.stringify(row[key]) : row[key]);
          const placeholders = columns.map(() => '?');
          if (table === 'spots') {
            columns.push('location'); placeholders.push('POINT(?, ?)');
            values.push(original.location_x, original.location_y);
          }
          await client.execute(`INSERT INTO ${table} (${columns.map(c => '`' + c + '`').join(',')}) VALUES (${placeholders.join(',')})`, values as ExecuteValues);
        }
      }
      for (const row of file.tables.spots) {
        if (row.cover_photo_id) await client.execute('UPDATE spots SET cover_photo_id = ? WHERE id = ?', [row.cover_photo_id, row.id] as ExecuteValues);
      }
      await readMysql(client, file);
      await client.commit();
    }
    return Object.fromEntries(TABLES.map(table => [table, file.tables[table].length]));
  } catch (error) { await client.rollback(); throw error; }
  finally { await client.end(); }
}

async function main() {
  loadEnv({ path: process.env.MIGRATION_ENV_FILE || '.env.mysql.local' });
  const [mode, filename] = process.argv.slice(2);
  if (!filename || !['export', 'import', 'verify'].includes(mode)) throw new Error('Usage: transfer-mysql.ts export|import|verify <snapshot.json>');
  if (mode === 'export') {
    const source = process.env.SOURCE_DATABASE_URL;
    if (!source) throw new Error('Set SOURCE_DATABASE_URL locally');
    const snapshot = await exportPostgres(source);
    writeFileSync(filename, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
    console.log(`已导出一致性快照 ${filename}; sha256=${snapshot.sha256}`);
  } else {
    const target = process.env.TARGET_DATABASE_URL;
    if (!target) throw new Error('Set TARGET_DATABASE_URL locally');
    const snapshot = JSON.parse(readFileSync(filename, 'utf8')) as ExportFile;
    console.log(await transferMysql(target, snapshot, mode === 'verify', process.env.TARGET_DATABASE_SSL === 'true'));
    console.log(mode === 'verify' ? '逐字段核对通过' : '导入已提交，逐字段核对通过');
  }
}
if (require.main === module) main().catch(error => { console.error(`[transfer] ${(error as Error).message}`); process.exitCode = 1; });
