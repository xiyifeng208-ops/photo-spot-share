import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, type QueryResultRow } from 'pg';
import { readFileSync } from 'node:fs';
import { createPool, Pool as MysqlPool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { mysqlParameters } from './mysql-parameters';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';

export interface DatabaseResult<T> { rows: T[]; rowCount: number | null }
export interface DatabaseClient {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<DatabaseResult<T>>;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool?: Pool;
  private mysql?: MysqlPool;
  private closed = false;
  readonly isMysql: boolean;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const url = new URL(config.database.url);
    this.isMysql = url.protocol === 'mysql:';
    if (this.isMysql) {
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      const insecureDevelopment = config.nodeEnv === 'development' && config.database.allowInsecureRemote === true;
      if (!config.database.ssl && (config.nodeEnv === 'production' || (!local && !insecureDevelopment))) {
        throw new Error('MySQL 必须启用 DATABASE_SSL=true；仅 development 可显式开启 DATABASE_ALLOW_INSECURE_REMOTE');
      }
      if (!config.database.ssl && !local) {
        this.logger.warn('开发环境已显式允许非加密远程 MySQL：连接不受 TLS 保护，不应用于生产或敏感数据');
      }
      if (url.search) throw new Error('MySQL URL query options are unsupported; use DATABASE_SSL / DATABASE_SSL_CA');
      this.mysql = createPool({
        host: url.hostname, port: Number(url.port || 3306),
        user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
        connectionLimit: config.database.poolMax, timezone: 'Z', charset: 'utf8mb4',
        supportBigNumbers: true, decimalNumbers: true, multipleStatements: false,
        ssl: config.database.ssl ? {
          rejectUnauthorized: true,
          verifyIdentity: true,
          ca: config.database.sslCa ? readFileSync(config.database.sslCa, 'utf8') : undefined,
        } : undefined,
      });
    } else {
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Unsupported database protocol');
      this.pool = this.createPool();
    }
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
      await this.onModuleDestroy();
      throw error;
    }
  }

  async onModuleDestroy() {
    if (this.closed) return;
    this.closed = true;
    await this.pool?.end();
    await this.mysql?.end();
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<DatabaseResult<T>> {
    if (this.pool) return this.pool.query<T>(sql, params);
    const connection = await this.mysqlConnection();
    try { return await this.mysqlClient(connection).query<T>(sql, params); }
    finally { connection.release(); }
  }

  async queryOne<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const result = await this.query<T>(sql, params);
    return result.rows[0] ?? null;
  }

  private async mysqlConnection(): Promise<PoolConnection> {
    const connection = await this.mysql!.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      return connection;
    } catch (error) { connection.release(); throw error; }
  }

  private mysqlClient(connection: PoolConnection): DatabaseClient {
    return { query: async <T extends QueryResultRow>(sql: string, params: unknown[] = []) => {
      const bound = mysqlParameters(sql, params);
      const [result] = await connection.execute<RowDataPacket[] | ResultSetHeader>(bound.sql, bound.values as never[]);
      return Array.isArray(result)
        ? { rows: result as T[], rowCount: result.length }
        : { rows: [] as T[], rowCount: result.affectedRows };
    } };
  }

  async withTransaction<T>(handler: (client: DatabaseClient) => Promise<T>): Promise<T> {
    const connection = this.pool ? await this.pool.connect() : await this.mysqlConnection();
    const client: DatabaseClient = this.pool ? connection as DatabaseClient : this.mysqlClient(connection as PoolConnection);
    try {
      if (this.pool) await client.query('BEGIN');
      else await (connection as PoolConnection).beginTransaction();
      const result = await handler(client);
      if (this.pool) await client.query('COMMIT');
      else await (connection as PoolConnection).commit();
      return result;
    } catch (error) {
      try {
        if (this.pool) await client.query('ROLLBACK');
        else await (connection as PoolConnection).rollback();
      } catch { /* Preserve original error. */ }
      throw error;
    } finally {
      connection.release();
    }
  }
}

