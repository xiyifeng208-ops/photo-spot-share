import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';
import { CosStorageDriver } from './cos-storage.driver';
import { LocalStorageDriver } from './local-storage.driver';
import type { StorageDriver } from './storage.types';
import { currentRequestBaseUrl } from '../common/request-context';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  readonly driver: StorageDriver;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    if (config.storage.driver === 'cos') {
      this.driver = new CosStorageDriver({
        ...config.storage.cos,
        cdnBaseUrl: config.storage.cdnBaseUrl,
        publicBaseUrl: config.publicBaseUrl,
      });
    } else {
      this.driver = new LocalStorageDriver(config.storage.localDir, config.publicBaseUrl);
    }
    this.logger.log(`图片存储驱动: ${this.driver.kind}`);
  }

  get kind() {
    return this.driver.kind;
  }

  publicUrl(objectKey: string): string {
    // 本地驱动按请求来源拼地址；COS 驱动走 CDN 域名，不受访问地址影响
    const requestBaseUrl = currentRequestBaseUrl();
    if (requestBaseUrl && this.driver.kind === 'local') {
      return `${requestBaseUrl}/static/${objectKey}`;
    }
    return this.driver.publicUrl(objectKey);
  }

  /** 签发上传凭证；本地驱动会用本次请求的访问地址。 */
  signUpload(userId: string, items: { mime: string }[]) {
    return this.driver.signUpload(userId, items, currentRequestBaseUrl());
  }

  /** 校验 key 是否属于该用户（防止把别人的图片挂到自己的打卡点上）。 */
  belongsToUser(objectKey: string, userId: string): boolean {
    return typeof objectKey === 'string' && objectKey.includes(`/${userId}/`);
  }
}
