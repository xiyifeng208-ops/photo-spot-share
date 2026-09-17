import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.pool = this.createPool();
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
      await this.pool.query('SELECT 1');
      this.logger.log('数据库连接就绪');
    } catch (error) {
      this.logger.error(
        `数据库连接失败，请检查 DATABASE_URL 与容器状态: ${(error as Error).message}`,
      );
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params as never[]);
  }

  async queryOne<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const result = await this.query<T>(sql, params);
    return result.rows[0] ?? null;
  }

  async withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await handler(client);
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

