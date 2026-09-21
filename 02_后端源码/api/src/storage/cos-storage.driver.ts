import { createRequire } from 'node:module';
import { Logger } from '@nestjs/common';
import { AppException } from '../common/errors';
import { randomId } from './local-storage.driver';
import type { SignedUpload, StorageDriver } from './storage.types';
import { MIME_EXTENSIONS } from './storage.types';

const require_ = createRequire(__filename);

export interface CosSettings {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  prefix: string;
  cdnBaseUrl: string;
  publicBaseUrl: string;
}

/** 临时密钥有效期 10 分钟。 */
const CREDENTIAL_TTL_SECONDS = 600;

/**
 * 腾讯云 COS 驱动：下发限定在 `uploads/{userId}/*` 前缀下的临时密钥，
 * 小程序端用官方 cos-wx-sdk-v5 直传，服务端不中转图片流量。
 */
export class CosStorageDriver implements StorageDriver {
  readonly kind = 'cos' as const;
  private readonly logger = new Logger(CosStorageDriver.name);

  constructor(private readonly settings: CosSettings) {
    if (
      !settings.secretId ||
      !settings.secretKey ||
      !settings.bucket ||
      !settings.region
    ) {
      throw new Error(
        'STORAGE_DRIVER=cos 时必须配置 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION',
      );
    }
  }

  /** COS 驱动下 prefix 已经是 uploads，避免出现 uploads/uploads 双前缀。 */
  private get prefix(): string {
    return this.settings.prefix || 'uploads';
  }

  buildObjectKey(userId: string, mime: string): string {
    const ext = MIME_EXTENSIONS[mime];
    if (!ext) throw AppException.badRequest(`不支持的图片类型: ${mime}`);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `${this.prefix}/${userId}/${stamp}/${randomId()}.${ext}`;
  }

  async signUpload(userId: string, items: { mime: string }[]): Promise<SignedUpload> {
    const keys = items.map((item) => this.buildObjectKey(userId, item.mime));

    let credential: {
      credentials: { tmpSecretId: string; tmpSecretKey: string; sessionToken: string };
      expiredTime: number;
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const STS = require_('qcloud-cos-sts');
      const policy = {
        version: '2.0',
        statement: [
          {
            action: [
              'name/cos:PutObject',
              'name/cos:PostObject',
              'name/cos:InitiateMultipartUpload',
              'name/cos:UploadPart',
              'name/cos:CompleteMultipartUpload',
              'name/cos:AbortMultipartUpload',
            ],
            effect: 'allow',
            // 权限严格限定在用户自己的目录，避免拿到密钥后越权覆盖他人图片
            resource: [
              `qcs::cos:${this.settings.region}:uid/${this.settings.bucket}:${this.prefix}/${userId}/*`,
            ],
          },
        ],
      };

      credential = await new Promise((resolve, reject) => {
        STS.getCredential(
          {
            secretId: this.settings.secretId,
            secretKey: this.settings.secretKey,
            policy,
            durationSeconds: CREDENTIAL_TTL_SECONDS,
            region: this.settings.region,
          },
          (err: Error | null, result: never) => {
            if (err) reject(err);
            else resolve(result);
          },
        );
      });
    } catch (error) {
      this.logger.error(`获取 COS 临时密钥失败: ${(error as Error).message}`);
      throw new AppException('STORAGE_UNAVAILABLE', '图片上传服务暂时不可用', 502);
    }

    return {
      driver: 'cos',
      bucket: this.settings.bucket,
      region: this.settings.region,
      uploadUrl: null,
      fieldName: null,
      credentials: {
        tmpSecretId: credential.credentials.tmpSecretId,
        tmpSecretKey: credential.credentials.tmpSecretKey,
        sessionToken: credential.credentials.sessionToken,
        expiredTime: credential.expiredTime,
      },
      keys,
      urls: Object.fromEntries(keys.map((key) => [key, this.publicUrl(key)])),
    };
  }

  publicUrl(objectKey: string): string {
    if (this.settings.cdnBaseUrl) {
      return `${this.settings.cdnBaseUrl}/${objectKey}`;
    }
    return `https://${this.settings.bucket}.cos.${this.settings.region}.myqcloud.com/${objectKey}`;
  }

  async deleteObject(objectKey: string): Promise<void> {
    // 孤儿对象清理走 COS 的生命周期规则或运维脚本，这里只记录，避免误删线上图片。
    this.logger.warn(`COS 孤儿对象待清理: ${objectKey}`);
  }
}

