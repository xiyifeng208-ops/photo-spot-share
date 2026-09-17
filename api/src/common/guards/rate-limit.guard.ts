import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../errors';

export interface RateLimitOptions {
  /** 限流维度，默认按用户（未登录时按 IP）。 */
  scope: 'user' | 'ip' | 'user-and-route';
  limit: number;
  windowMs: number;
}

export const RATE_LIMIT_KEY = 'rate_limit_options';

export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * 单机内存滑动窗口限流。几千个用户规模下够用；
 * 未来横向扩容时把 store 换成 Redis 即可，接口不变。
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const ip: string = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    const route = `${request.method}:${request.route?.path ?? request.url}`;

    const identity =
      options.scope === 'ip'
        ? `ip:${ip}`
        : options.scope === 'user-and-route'
          ? `user:${user?.id ?? ip}:${route}`
          : `user:${user?.id ?? ip}`;

    this.sweep();
    const now = Date.now();
    const bucket = this.buckets.get(identity);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(identity, { count: 1, resetAt: now + options.windowMs });
      return true;
    }

    if (bucket.count >= options.limit) {
      throw AppException.rateLimited();
    }

    bucket.count += 1;
    return true;
  }

  private sweep() {
    if (this.buckets.size < 5000) return;
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

