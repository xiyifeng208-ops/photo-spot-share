import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AppException } from '../common/errors';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { LocalStorageDriver } from '../storage/local-storage.driver';
import { StorageService } from '../storage/storage.service';
import type { SignedUpload } from '../storage/storage.types';
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_SPOT } from '../storage/storage.types';
import type { UploadItemDto } from './dto/sign-upload.dto';

/** 未被引用的上传票据保留 24 小时后清理。 */
export const ORPHAN_TICKET_TTL_HOURS = 24;

export interface UploadTicketRow {
  id: string;
  user_id: string;
  object_key: string;
  spot_id: string | null;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  /** 签发直传凭证，并把 object_key 登记成票据。 */
  async signUploads(userId: string, items: UploadItemDto[]): Promise<SignedUpload> {
    if (items.length === 0) throw AppException.badRequest('至少上传 1 张照片');
    if (items.length > MAX_PHOTOS_PER_SPOT) {
      throw AppException.badRequest(`每个打卡点最多 ${MAX_PHOTOS_PER_SPOT} 张样张`);
    }
    for (const item of items) {
      if (item.size && item.size > MAX_PHOTO_BYTES) {
        throw AppException.badRequest('单张图片不能超过 10MB，请压缩后重试');
      }
    }

    const signed = await this.storage.signUpload(userId, items);

    await this.db.withTransaction(async (client) => {
      for (const [index, key] of signed.keys.entries()) {
        const item = items[index];
        await client.query(
          `INSERT INTO upload_tickets (user_id, object_key, mime, size_bytes, width, height)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (object_key) DO UPDATE
             SET mime = EXCLUDED.mime,
                 size_bytes = EXCLUDED.size_bytes,
                 width = EXCLUDED.width,
                 height = EXCLUDED.height`,
          [
            userId,
            key,
            item?.mime ?? null,
            item?.size ?? null,
            item?.width ?? null,
            item?.height ?? null,
          ],
        );
      }
    });

    return signed;
  }

  /** 本地驱动：确认票据有效后落盘，避免被当成免费图床刷爆磁盘。 */
  async recordLocalUpload(params: {
    userId: string;
    key: string;
    buffer: Buffer;
    mime?: string;
  }): Promise<{ key: string; url: string; size: number }> {
    if (!(this.storage.driver instanceof LocalStorageDriver)) {
      throw AppException.badRequest('当前存储驱动不支持本地上传接口');
    }
    if (!this.storage.belongsToUser(params.key, params.userId)) {
      throw AppException.forbidden('上传路径不属于当前用户');
    }
    if (params.buffer.length > MAX_PHOTO_BYTES) {
      throw AppException.badRequest('单张图片不能超过 10MB，请压缩后重试');
    }

    const ticket = await this.db.queryOne<UploadTicketRow>(
      `SELECT id, user_id, object_key, spot_id
         FROM upload_tickets
        WHERE object_key = $1 AND user_id = $2`,
      [params.key, params.userId],
    );
    if (!ticket) {
      throw AppException.forbidden('请先申请上传凭证再上传图片');
    }
    if (ticket.spot_id) {
      throw AppException.badRequest('该图片已发布，不能重复上传');
    }

    const driver = this.storage.driver;
    if (!(driver instanceof LocalStorageDriver)) {
      throw AppException.badRequest('当前存储驱动不支持本地上传接口');
    }
    await driver.saveObject(params.key, params.buffer);
    await this.db.query('UPDATE upload_tickets SET size_bytes = $2 WHERE id = $1', [
      ticket.id,
      params.buffer.length,
    ]);

    return {
      key: params.key,
      url: this.storage.publicUrl(params.key),
      size: params.buffer.length,
    };
  }

  /**
   * 创建/更新打卡点前校验：所有图片 key 都属于该用户，且票据未被其他打卡点占用。
   * allowSpotId 用于编辑场景 —— 该打卡点自己已有的图片可以继续引用。
   */
  async assertUsableKeys(
    userId: string,
    keys: string[],
    options: { client?: PoolClient; allowSpotId?: string } = {},
  ) {
    const { client, allowSpotId } = options;
    if (keys.length === 0) return;
    if (keys.length > MAX_PHOTOS_PER_SPOT) {
      throw AppException.badRequest(`每个打卡点最多 ${MAX_PHOTOS_PER_SPOT} 张样张`);
    }
    const unique = Array.from(new Set(keys));
    if (unique.length !== keys.length) {
      throw AppException.badRequest('存在重复图片');
    }
    for (const key of unique) {
      if (!this.storage.belongsToUser(key, userId)) {
        throw AppException.forbidden('图片归属校验失败，请重新上传');
      }
    }

    const sql = `SELECT id, user_id, object_key, spot_id
                   FROM upload_tickets
                  WHERE object_key = ANY($1::text[])`;
    const { rows } = client
      ? await client.query<UploadTicketRow>(sql, [unique])
      : await this.db.query<UploadTicketRow>(sql, [unique]);

    if (rows.length !== unique.length) {
      throw AppException.badRequest('部分图片未完成上传，请重试');
    }
    for (const row of rows) {
      if (row.user_id !== userId) throw AppException.forbidden('图片归属校验失败');
      if (row.spot_id && row.spot_id !== allowSpotId) {
        throw AppException.badRequest('图片已被其他打卡点使用');
      }
    }
  }

  /** 清理超过 TTL 仍未发布的图片：先删对象存储，再删票据。 */
  async cleanupOrphans(ttlHours = ORPHAN_TICKET_TTL_HOURS): Promise<{ removed: number }> {
    const { rows } = await this.db.query<{ object_key: string; id: string }>(
      `SELECT id, object_key
         FROM upload_tickets
        WHERE spot_id IS NULL
          AND created_at < now() - ($1 || ' hours')::interval
        LIMIT 500`,
      [ttlHours],
    );

    for (const row of rows) {
      try {
        await this.storage.driver.deleteObject(row.object_key);
        await this.db.query('DELETE FROM upload_tickets WHERE id = $1', [row.id]);
      } catch (error) {
        this.logger.warn(`清理孤儿图片失败 ${row.object_key}: ${(error as Error).message}`);
      }
    }

    if (rows.length > 0) {
      this.logger.log(`已清理 ${rows.length} 个未使用的上传票据`);
    }
    return { removed: rows.length };
  }
}
