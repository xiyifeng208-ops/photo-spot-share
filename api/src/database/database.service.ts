import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { createPool, type Pool as MysqlPool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';
import { mysqlBindings } from './sql';
import type { ExecuteValues } from 'mysql2';

export interface DatabaseResult<T> { rows: T[]; rowCount: number | null }
export interface DatabaseClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<DatabaseResult<T>>;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly isMysql: boolean;
  private pool?: Pool;
  private mysql?: MysqlPool;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.isMysql = config.database.url.startsWith('mysql://');
    if (this.isMysql) {
      const url = new URL(config.database.url);
      this.mysql = createPool({
        host: url.hostname, port: Number(url.port || 3306),
        user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
        connectionLimit: config.database.poolMax, charset: 'utf8mb4', timezone: 'Z',
        supportBigNumbers: true, bigNumberStrings: true,
        ssl: config.database.ssl ? { rejectUnauthorized: true } : undefined,
      });
      this.mysql.on('connection', connection => { connection.query("SET time_zone = '+00:00'"); });
    } else this.pool = this.createPool();
  }

  private createPool(): Pool {
    const pool = new Pool({
      connectionString: this.config.database.url,
      max: this.config.database.poolMax,
      ssl: this.config.database.ssl ? { rejectUnauthorized: false } : undefined,
    });
    pool.on('error', (error) => {
      this.logger.error(`数据库连接池错误: ${error.message}`);
    });
    return pool;
  }

  async onModuleInit() {
    try {
      await this.query('SELECT 1');
      this.logger.log('数据库连接就绪');
    } catch (error) {
      this.logger.error(
        `数据库连接失败，请检查 DATABASE_URL 与容器状态: ${(error as Error).message}`,
      );
    }
  }

  async onModuleDestroy() {
    await this.pool?.end();
    await this.mysql?.end();
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<DatabaseResult<T>> {
    if (this.mysql) return this.mysqlQuery<T>(this.mysql, sql, params);
    const result = await this.pool!.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const result = await this.query<T>(sql, params);
    return result.rows[0] ?? null;
  }

  private async mysqlQuery<T>(connection: MysqlPool | PoolConnection, sql: string, params: unknown[] = []): Promise<DatabaseResult<T>> {
    const compiled = mysqlBindings(sql, params);
    const [result] = await connection.execute<RowDataPacket[] | ResultSetHeader>(compiled.sql, compiled.values as ExecuteValues);
    return Array.isArray(result) ? { rows: result as T[], rowCount: result.length } : { rows: [], rowCount: result.affectedRows };
  }

  async withTransaction<T>(handler: (client: DatabaseClient) => Promise<T>): Promise<T> {
    if (this.mysql) {
      const connection = await this.mysql.getConnection();
      try {
        await connection.beginTransaction();
        const value = await handler({ query: <R>(sql: string, params?: unknown[]) => this.mysqlQuery<R>(connection, sql, params) });
        await connection.commit();
        return value;
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    }
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      const result = await handler({ query: async <R>(sql: string, params?: unknown[]) => {
        const value = await client.query(sql, params);
        return { rows: value.rows as R[], rowCount: value.rowCount };
      } });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

