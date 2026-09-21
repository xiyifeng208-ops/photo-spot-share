import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';
import { runWithRequestContext } from './request-context';

/**
 * 把本次请求的访问地址放进 AsyncLocalStorage，供本地存储驱动拼接图片 / 上传地址。
 * 注册在 AppModule 里（而不是 main.ts），这样测试环境和生产环境的装配完全一致。
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  use(req: Request, _res: Response, next: NextFunction) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const forwardedHost = req.headers['x-forwarded-host'];
    const proto =
      (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0] ??
      req.protocol ??
      'http';
    const host =
      (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(',')[0] ??
      req.headers.host ??
      '';
    const baseUrl = host ? `${proto}://${host}` : this.config.publicBaseUrl;
    runWithRequestContext(baseUrl, () => next());
  }
}

