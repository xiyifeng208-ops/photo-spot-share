import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../errors';
import { TokenService } from '../../auth/token.service';

export const IS_PUBLIC_KEY = 'is_public';

/** 标记为公开接口：未登录也能访问，但会尽量解析出用户身份（用于 mine 之类的可选鉴权）。 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface RequestUser {
  id: string;
  openid: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const header = request.headers?.authorization as string | undefined;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;

    if (!token) {
      if (isPublic) return true;
      throw AppException.unauthorized('请先登录');
    }

    const payload = this.tokenService.verify(token);
    if (!payload) {
      if (isPublic) return true;
      throw AppException.unauthorized();
    }

    request.user = { id: payload.sub, openid: payload.openid } satisfies RequestUser;
    return true;
  }
}

