import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { ContentCheckService, type MediaCheckVerdict } from './content-check.service';

/** 回调迟迟不来时，超过这个时间就按"检测失败"处理（fail-closed，转 hidden 待人工确认）。 */
const PENDING_TIMEOUT_MINUTES = 10;

interface TaskRow {
  id: string;
  spot_id: string;
  trace_id: string | null;
  status: 'pending' | 'pass' | 'risky' | 'failed';
}

/**
 * 图片机审的任务表：每个待检图片一行，靠 trace_id 与微信回调对上。
 * 一张图命中风险 → 整个机位 hidden；全部通过 → 机位转 active。
 */
@Injectable()
export class ContentCheckTasksService {
  private readonly logger = new Logger(ContentCheckTasksService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly contentCheck: ContentCheckService,
  ) {}

  /**
   * 给刚发布的机位提交全部样张的图片机审。
   * 返回 true = 已提交、等回调（机位应保持 pending）；
   * 返回 false = 没有可用的图片机审通道（机位应直接 active）。
   */
  async submitForSpot(params: {
    spotId: string;
    openid: string;
    photoKeys: string[];
  }): Promise<boolean> {
    if (!this.contentCheck.mediaCheckReady) {
      if (this.contentCheck.enabled) {
        this.logger.warn(
          '图片机审未生效：缺少 WX_CALLBACK_TOKEN（小程序后台消息推送里的 Token），本次按文本机审结果直接发布',
        );
      }
      return false;
    }

    let submitted = 0;
    for (const key of params.photoKeys) {
      const mediaUrl = this.storage.publicUrl(key);
      const traceId = await this.contentCheck.submitMediaCheck(params.openid, mediaUrl);
      if (!traceId) continue;
      await this.db.query(
        `INSERT INTO content_check_tasks (spot_id, trace_id, status)
         VALUES ($1, $2, 'pending')`,
        [params.spotId, traceId],
      );
      submitted += 1;
    }

    if (submitted === 0) {
      this.logger.warn(`机位 ${params.spotId} 的图片机审提交全部失败，按文本机审结果直接发布`);
      return false;
    }
    return true;
  }

  /** 微信回调拿到结果后调用。 */
  async applyVerdict(traceId: string, verdict: MediaCheckVerdict, label?: number): Promise<void> {
    const task = await this.db.queryOne<TaskRow>(
      'SELECT id, spot_id, trace_id, status FROM content_check_tasks WHERE trace_id = $1',
      [traceId],
    );
    if (!task) {
      this.logger.warn(`收到未知 trace_id 的机审回调: ${traceId}`);
      return;
    }
    if (task.status !== 'pending') return; // 幂等：重复回调直接忽略

    await this.db.query(
      `UPDATE content_check_tasks SET status = $2, detail = $3, updated_at = now() WHERE id = $1`,
      [task.id, verdict, label === undefined ? null : `label=${label}`],
    );
    await this.recomputeSpot(task.spot_id);
  }

  /** 定时兜底：回调丢了也要有个结论，不能让机位永远停在"审核中"。 */
  @Cron('0 */5 * * * *')
  async handleTimeoutSweep(): Promise<void> {
    const cleared = await this.sweepTimeouts();
    if (cleared > 0) this.logger.warn(`机审超时兜底：${cleared} 个机位转人工确认`);
  }

  async sweepTimeouts(): Promise<number> {
    const { rows } = await this.db.query<TaskRow>(
      `UPDATE content_check_tasks
          SET status = 'failed', detail = '回调超时', updated_at = now()
        WHERE status = 'pending'
          AND created_at < now() - ($1 || ' minutes')::interval
        RETURNING id, spot_id, trace_id, status`,
      [PENDING_TIMEOUT_MINUTES],
    );

    for (const row of rows) {
      this.logger.warn(`机审回调超时，机位 ${row.spot_id} 转人工确认`);
      await this.recomputeSpot(row.spot_id);
    }
    return rows.length;
  }

  /** 按该机位所有图片任务的状态，决定机位是 active / hidden / 继续 pending。 */
  private async recomputeSpot(spotId: string): Promise<void> {
    const tasks = (
      await this.db.query<TaskRow>(
        'SELECT id, spot_id, trace_id, status FROM content_check_tasks WHERE spot_id = $1',
        [spotId],
      )
    ).rows;
    if (!tasks.length) return;

    if (tasks.some((t) => t.status === 'risky')) {
      await this.setSpotStatus(spotId, 'hidden');
      this.logger.warn(`机位 ${spotId} 图片机审未通过，已隐藏`);
      return;
    }
    if (tasks.some((t) => t.status === 'failed')) {
      await this.setSpotStatus(spotId, 'hidden');
      return;
    }
    if (tasks.every((t) => t.status === 'pass')) {
      await this.setSpotStatus(spotId, 'active');
      this.logger.log(`机位 ${spotId} 图片机审通过，已公开`);
    }
  }

  private async setSpotStatus(spotId: string, status: 'active' | 'hidden'): Promise<void> {
    // 只动"审核中"的机位：作者自己删掉的（deleted）不要被回调复活
    await this.db.query(
      `UPDATE spots SET status = $2, updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [spotId, status],
    );
  }
}
