import { createHash } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Logger } from '@nestjs/common';
import { AppException } from '../common/errors';
import type { SignedUpload, StorageDriver } from './storage.types';
import { MIME_EXTENSIONS } from './storage.types';

/**
 * 本地磁盘驱动：零云依赖，让整条链路在本机就能跑通。
 * 图片通过 /static 静态目录对外提供，接口形态与 COS 驱动保持一致。
 */
export class LocalStorageDriver implements StorageDriver {
  readonly kind = 'local' as const;
  private readonly logger = new Logger(LocalStorageDriver.name);
  private readonly rootDir: string;

  constructor(
    localDir: string,
    private readonly publicBaseUrl: string,
  ) {
    this.rootDir = resolve(process.cwd(), localDir);
  }

  buildObjectKey(userId: string, mime: string): string {
    const ext = MIME_EXTENSIONS[mime];
    if (!ext) throw AppException.badRequest(`不支持的图片类型: ${mime}`);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `uploads/${userId}/${stamp}/${randomId()}.${ext}`;
  }

  async signUpload(
    userId: string,
    items: { mime: string }[],
    baseUrlOverride?: string,
  ): Promise<SignedUpload> {
    const keys = items.map((item) => this.buildObjectKey(userId, item.mime));
    // 前端从哪个地址进来就用哪个地址，手机用局域网 IP 访问时也能拿到正确地址
    const base = baseUrlOverride || this.publicBaseUrl;
    return {
      driver: 'local',
      bucket: null,
      region: null,
      uploadUrl: `${base}/api/v1/uploads/local`,
      fieldName: 'file',
      credentials: { tmpSecretId: null, tmpSecretKey: null, sessionToken: null, expiredTime: null },
      keys,
      urls: Object.fromEntries(keys.map((key) => [key, `${base}/static/${key}`])),
    };
  }

  publicUrl(objectKey: string): string {
    return `${this.publicBaseUrl}/static/${objectKey}`;
  }

  /** 写入本地磁盘。key 必须是本驱动签发的 uploads/ 开头路径，防止目录穿越。 */
  async saveObject(objectKey: string, buffer: Buffer): Promise<void> {
    const absolute = this.resolveObjectPath(objectKey);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, buffer);
  }

  async deleteObject(objectKey: string): Promise<void> {
    if (!objectKey.startsWith('uploads/')) {
      this.logger.warn(`拒绝删除非 uploads/ 前缀的对象: ${objectKey}`);
      return;
    }
    try {
      await unlink(this.resolveObjectPath(objectKey));
    } catch {
      // 文件可能已被删除，幂等处理
    }
  }

  private resolveObjectPath(objectKey: string): string {
    const absolute = resolve(this.rootDir, normalize(objectKey));
    if (!absolute.startsWith(this.rootDir + sep)) {
      throw AppException.badRequest('非法的对象 key');
    }
    return absolute;
  }
}

export function randomId(): string {
  return createHash('sha1')
    .update(`${Date.now()}-${Math.random()}-${process.pid}`)
    .digest('hex')
    .slice(0, 24);
}

export function joinKey(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

export function staticRoot(processCwd: string, localDir: string): string {
  return join(resolve(processCwd), localDir);
}
