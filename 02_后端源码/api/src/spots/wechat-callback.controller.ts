import { Body, Controller, Get, Logger, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/guards/jwt-auth.guard';
import { ContentCheckService } from './content-check.service';
import { ContentCheckTasksService } from './content-check-tasks.service';

/**
 * 小程序「消息推送」回调地址：图片机审结果通过它回来。
 *
 * 在微信后台「开发管理 → 开发设置 → 消息推送」里配置：
 *   服务器地址 https://api.你的域名/api/v1/wechat/callback
 *   Token      与后端 WX_CALLBACK_TOKEN 一致
 *   数据格式   JSON（XML 也能解析）
 *   加密方式   明文模式
 *
 * 注意：这里必须直接写响应，不能走统一的 { data } 包装，否则微信 URL 校验会失败。
 */
@Controller('wechat')
export class WechatCallbackController {
  private readonly logger = new Logger(WechatCallbackController.name);

  constructor(
    private readonly contentCheck: ContentCheckService,
    private readonly tasks: ContentCheckTasksService,
  ) {}

  /** URL 校验：微信带 echostr 来，校验签名后原样返回 */
  @Public()
  @Get('callback')
  verify(
    @Query('signature') signature: string,
    @Query('timestamp') timestamp: string,
    @Query('nonce') nonce: string,
    @Query('echostr') echostr: string,
    @Res() res: Response,
  ) {
    if (!this.contentCheck.verifyCallbackSignature({ signature, timestamp, nonce })) {
      this.logger.warn('消息推送 URL 校验签名不匹配');
      res.status(401).type('text/plain').send('invalid signature');
      return;
    }
    res.type('text/plain').send(echostr ?? '');
  }

  /** 事件推送：图片机审结果 */
  @Public()
  @Post('callback')
  async handle(
    @Query('signature') signature: string,
    @Query('timestamp') timestamp: string,
    @Query('nonce') nonce: string,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    if (!this.contentCheck.verifyCallbackSignature({ signature, timestamp, nonce })) {
      res.status(401).type('text/plain').send('invalid signature');
      return;
    }

    const event = this.contentCheck.parseMediaCheckEvent(body);
    if (event) {
      await this.tasks.applyVerdict(event.traceId, event.verdict, event.label);
    } else {
      this.logger.log(`忽略未识别的消息推送: ${JSON.stringify(body).slice(0, 120)}`);
    }

    // 微信要求 5 秒内返回，失败会重试；统一回 success
    res.type('text/plain').send('success');
  }
}

