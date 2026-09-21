import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { AppException } from '../errors';

/**
 * 运营接口鉴权：请求头带 `x-admin-token`，与后端 ADMIN_TOKEN 一致。
 * ADMIN_TOKEN 为空时运营接口整体关闭（返回 403），避免线上被误用。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.adminToken) {
      throw AppException.forbidden('运营接口未开启（未配置 ADMIN_TOKEN）');
    }
    const request = context.switchToHttp().getRequest();
    const token = request.headers?.['x-admin-token'];
    if (token !== this.config.adminToken) {
      throw AppException.forbidden('运营令牌不正确');
    }
    return true;
  }
}

