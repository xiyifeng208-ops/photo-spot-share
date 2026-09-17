import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';

export interface ContentCheckResult {
  pass: boolean;
  label?: number;
  reason?: string;
}

export type MediaCheckVerdict = 'pass' | 'risky';

export interface MediaCheckEvent {
  traceId: string;
  verdict: MediaCheckVerdict;
  label?: number;
}

/**
 * 内容安全钩子：v1 默认关闭（CONTENT_CHECK_ENABLED=false）。
 * 打开后调用微信 msg_sec_check，命中风险的内容会被置为 hidden 待人工确认。
 * 图片检测（img_sec_check）在 v1.1 补充，同样从这里扩展。
 */
@Injectable()
export class ContentCheckService {
  private readonly logger = new Logger(ContentCheckService.name);
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get enabled(): boolean {
    return this.config.contentCheckEnabled && Boolean(this.config.wechat.appId);
  }

  /** 图片机审还需要消息推送 Token 才能接收回调结果 */
  get mediaCheckReady(): boolean {
    return this.enabled && Boolean(this.config.wechat.callbackToken);
  }

  async checkText(openid: string, content: string): Promise<ContentCheckResult> {
    if (!this.enabled) return { pass: true };
    const text = content.trim();
    if (!text) return { pass: true };

    try {
      const token = await this.getAccessToken();
      if (!token) return { pass: true };

      const url = new URL('https://api.weixin.qq.com/wxa/msg_sec_check');
      url.searchParams.set('access_token', token);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 2, openid, scene: 2, content: text.slice(0, 2500) }),
      });
      const payload = (await response.json()) as { errcode?: number; result?: { suggest?: string; label?: number } };

      if (payload.errcode && payload.errcode !== 0) {
        this.logger.warn(`内容检查返回异常 ${payload.errcode}，按通过处理`);
        return { pass: true };
      }

      const suggest = payload.result?.suggest;
      return {
        pass: suggest === 'pass' || suggest === undefined,
        label: payload.result?.label,
        reason: suggest,
      };
    } catch (error) {
      // 内容安全服务不可用时不阻断发布，只记录日志
      this.logger.warn(`内容检查失败: ${(error as Error).message}`);
      return { pass: true };
    }
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    if (!this.config.wechat.appId || !this.config.wechat.appSecret) return null;

    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', this.config.wechat.appId);
    url.searchParams.set('secret', this.config.wechat.appSecret);

    const response = await fetch(url);
    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      errcode?: number;
    };
    if (!payload.access_token) {
      this.logger.warn(`获取 access_token 失败: ${payload.errcode}`);
      return null;
    }

    this.accessToken = {
      value: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 7200) * 1000,
    };
    return this.accessToken.value;
  }

  /**
   * 提交图片异步检测，返回 trace_id。
   * 微信不提供轮询查询接口，结果通过「消息推送」回调到我们的服务器
   * （见 WechatCallbackController），由 ContentCheckTasksService 落库。
   */
  async submitMediaCheck(openid: string, mediaUrl: string): Promise<string | null> {
    if (!this.enabled) return null;
    const token = await this.getAccessToken();
    if (!token) return null;

    const url = new URL('https://api.weixin.qq.com/wxa/media_check_async');
    url.searchParams.set('access_token', token);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          media_url: mediaUrl,
          media_type: 2, // 2 = 图片
          version: 2,
          openid,
          scene: 2,
        }),
      });
      const payload = (await response.json()) as { errcode?: number; errmsg?: string; trace_id?: string };
      if (payload.errcode && payload.errcode !== 0) {
        this.logger.warn(`图片机审提交失败 ${payload.errcode}: ${payload.errmsg}`);
        return null;
      }
      return payload.trace_id ?? null;
    } catch (error) {
      this.logger.warn(`图片机审提交异常: ${(error as Error).message}`);
      return null;
    }
  }

  /** 校验消息推送回调签名：sha1(sort(token, timestamp, nonce)) */
  verifyCallbackSignature(params: {
    signature?: string;
    timestamp?: string;
    nonce?: string;
  }): boolean {
    const token = this.config.wechat.callbackToken;
    if (!token || !params.signature || !params.timestamp || !params.nonce) return false;
    const expected = createHash('sha1')
      .update([token, params.timestamp, params.nonce].sort().join(''))
      .digest('hex');
    return expected === params.signature;
  }

  /** 从消息推送报文里取出图片机审结果（兼容 JSON 与 XML 两种数据格式）。 */
  parseMediaCheckEvent(body: unknown): MediaCheckEvent | null {
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const traceId = matchField(text, 'trace_id') ?? matchField(text, 'TraceId');
    const suggest = matchField(text, 'suggest');
    if (!traceId || !suggest) return null;
    const label = Number(matchField(text, 'label') ?? '');
    return {
      traceId,
      verdict: suggest === 'pass' ? 'pass' : 'risky',
      label: Number.isFinite(label) ? label : undefined,
    };
  }
}

/** 同时兼容 `"trace_id":"xxx"`（JSON）与 `<trace_id>xxx</trace_id>`（XML） */
function matchField(text: string, field: string): string | null {
  const json = new RegExp(`"${field}"\\s*:\\s*"?([^",}]+)"?`).exec(text);
  if (json) return json[1].trim();
  const xml = new RegExp(`<${field}>([^<]+)</${field}>`).exec(text);
  return xml ? xml[1].trim() : null;
}
