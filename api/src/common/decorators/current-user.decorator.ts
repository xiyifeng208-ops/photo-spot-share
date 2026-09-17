import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RequestUser } from '../guards/jwt-auth.guard';
import { AppException } from '../errors';

/** 取当前登录用户；require=true 时未登录直接 401。 */
export const CurrentUser = createParamDecorator(
  (require: boolean | undefined, context: ExecutionContext): RequestUser | undefined => {
    const request = context.switchToHttp().getRequest();
    const user = request.user as RequestUser | undefined;
    if (!user && require !== false) {
      throw AppException.unauthorized();
    }
    return user;
  },
);

