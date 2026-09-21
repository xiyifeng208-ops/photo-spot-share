import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/errors';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';

export interface WechatSession {
  openid: string;
  sessionKey?: string;
  unionid?: string;
}

interface Code2SessionResponse {
  openid?: string;
  session_key?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

@Injectable()
export class WechatService {
  private readonly logger = new Logger(WechatService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get isConfigured(): boolean {
    return Boolean(this.config.wechat.appId && this.config.wechat.appSecret);
  }

  /** 调用 jscode2session，把小程序 code 换成 openid。 */
  async code2Session(code: string): Promise<WechatSession> {
    if (!this.isConfigured) {
      throw new AppException(
        'WECHAT_LOGIN_FAILED',
        '服务端未配置 WX_APPID / WX_SECRET，无法完成微信登录',
        500,
      );
    }

    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', this.config.wechat.appId);
    url.searchParams.set('secret', this.config.wechat.appSecret);
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');

    let payload: Code2SessionResponse;
    try {
      const response = await fetch(url, { method: 'GET' });
      payload = (await response.json()) as Code2SessionResponse;
    } catch (error) {
      this.logger.error(`jscode2session 请求失败: ${(error as Error).message}`);
      throw new AppException('WECHAT_LOGIN_FAILED', '微信登录服务暂时不可用', 502);
    }

    if (!payload.openid) {
      this.logger.warn(`jscode2session 返回异常: ${payload.errcode} ${payload.errmsg}`);
      throw AppException.badRequest(
        `微信登录失败(${payload.errcode ?? 'unknown'}): ${payload.errmsg ?? 'code 无效或已过期'}`,
      );
    }

    return { openid: payload.openid, sessionKey: payload.session_key, unionid: payload.unionid };
  }
}

