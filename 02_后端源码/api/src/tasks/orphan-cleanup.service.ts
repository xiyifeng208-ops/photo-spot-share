import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UploadsService } from '../uploads/uploads.service';

@Injectable()
export class OrphanCleanupService {
  private readonly logger = new Logger(OrphanCleanupService.name);

  constructor(private readonly uploads: UploadsService) {}

  /** 每天 03:10 清理 24 小时内未被任何打卡点引用的图片。 */
  @Cron('0 10 3 * * *')
  async handleCron() {
    const { removed } = await this.uploads.cleanupOrphans();
    this.logger.log(`孤儿图片清理完成，删除 ${removed} 条`);
  }
}
