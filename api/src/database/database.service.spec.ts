import { createPool } from 'mysql2/promise';
import { Pool } from 'pg';
import { DatabaseService } from './database.service';
import { loadConfig } from '../config/configuration';

jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));
jest.mock('pg', () => ({ Pool: jest.fn() }));

describe('database selection and safety', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps the PostgreSQL URL and pool configuration', async () => {
    const pool = { on: jest.fn(), end: jest.fn() };
    (Pool as unknown as jest.Mock).mockReturnValue(pool);
    const config = loadConfig({ DATABASE_URL: 'postgres://spot:spot@localhost:5432/spot' });
    const db = new DatabaseService(config);
    expect(db.isMysql).toBe(false);
    expect(Pool).toHaveBeenCalledWith({ connectionString: config.database.url, max: 10, ssl: undefined });
    expect(createPool).not.toHaveBeenCalled();
    await db.onModuleDestroy();
  });

  it('requires remote TLS and verifies both certificate trust and hostname', async () => {
    expect(() => new DatabaseService(loadConfig({ DATABASE_URL: 'mysql://test:password@db.example/test' })))
      .toThrow('DATABASE_SSL=true');
    (createPool as jest.Mock).mockReturnValue({ end: jest.fn() });
    const db = new DatabaseService(loadConfig({ DATABASE_URL: 'mysql://test:password@db.example/test', DATABASE_SSL: 'true' }));
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'Z', multipleStatements: false,
      ssl: expect.objectContaining({ rejectUnauthorized: true, verifyIdentity: true }) }));
    await db.onModuleDestroy();
  });

  it('sets UTC on every checkout and rolls back/release on failure', async () => {
    const connection = { query: jest.fn().mockResolvedValue([]), execute: jest.fn().mockResolvedValue([[{ n: 1 }]]),
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() };
    const pool = { getConnection: jest.fn().mockResolvedValue(connection), end: jest.fn() };
    (createPool as jest.Mock).mockReturnValue(pool);
    const db = new DatabaseService(loadConfig({ DATABASE_URL: 'mysql://test:password@127.0.0.1/test' }));
    expect(await db.queryOne('SELECT $1 AS n', [1])).toEqual({ n: 1 });
    await expect(db.withTransaction(async () => { throw new Error('failed transaction'); })).rejects.toThrow('failed transaction');
    expect(connection.query).toHaveBeenNthCalledWith(1, "SET SESSION time_zone = '+00:00'");
    expect(connection.query).toHaveBeenCalledTimes(2);
    expect(connection.execute).toHaveBeenCalledWith('SELECT ? AS n', [1]);
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(2);
    await db.onModuleDestroy();
    await db.onModuleDestroy();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('allows explicit development-only plaintext without weakening enabled TLS', async () => {
    (createPool as jest.Mock).mockReturnValue({ end: jest.fn() });
    const env = { NODE_ENV: 'development', DATABASE_URL: 'mysql://test:password@db.example/test',
      DATABASE_SSL: 'false', DATABASE_ALLOW_INSECURE_REMOTE: 'true' };
    const db = new DatabaseService(loadConfig(env));
    expect(createPool).toHaveBeenLastCalledWith(expect.objectContaining({ ssl: undefined }));
    await db.onModuleDestroy();
    const encrypted = new DatabaseService(loadConfig({ ...env, DATABASE_SSL: 'true' }));
    expect(createPool).toHaveBeenLastCalledWith(expect.objectContaining({
      ssl: expect.objectContaining({ rejectUnauthorized: true, verifyIdentity: true }) }));
    await encrypted.onModuleDestroy();
  });

  it.each(['production', 'test', 'staging'])('cannot opt out of remote TLS in %s', (nodeEnv) => {
    expect(() => new DatabaseService(loadConfig({ NODE_ENV: nodeEnv,
      DATABASE_URL: 'mysql://test:password@db.example/test', DATABASE_ALLOW_INSECURE_REMOTE: 'true' })))
      .toThrow('DATABASE_SSL=true');
    expect(createPool).not.toHaveBeenCalled();
  });

  it('also requires TLS for loopback MySQL in production', () => {
    expect(() => new DatabaseService(loadConfig({ NODE_ENV: 'production',
      DATABASE_URL: 'mysql://test:password@127.0.0.1/test', DATABASE_ALLOW_INSECURE_REMOTE: 'true' })))
      .toThrow('DATABASE_SSL=true');
  });

  it('rejects connection-string flags that could silently alter TLS', () => {
    expect(() => new DatabaseService(loadConfig({ DATABASE_URL: 'mysql://test:password@localhost/test?ssl=false' })))
      .toThrow('query options');
  });
});
