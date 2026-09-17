import { HttpException, HttpStatus } from '@nestjs/common';

export const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  GEO_UNAVAILABLE: 'GEO_UNAVAILABLE',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  WECHAT_LOGIN_FAILED: 'WECHAT_LOGIN_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppException extends HttpException {
  constructor(
    code: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    details?: unknown,
  ) {
    super({ code, message, details }, status);
  }

  static badRequest(message: string, details?: unknown) {
    return new AppException(ErrorCodes.BAD_REQUEST, message, HttpStatus.BAD_REQUEST, details);
  }

  static unauthorized(message = '登录状态已失效，请重新进入小程序') {
    return new AppException(ErrorCodes.UNAUTHORIZED, message, HttpStatus.UNAUTHORIZED);
  }

  static forbidden(message = '没有权限操作该内容') {
    return new AppException(ErrorCodes.FORBIDDEN, message, HttpStatus.FORBIDDEN);
  }

  static notFound(message = '内容不存在或已被删除') {
    return new AppException(ErrorCodes.NOT_FOUND, message, HttpStatus.NOT_FOUND);
  }

  static rateLimited(message = '操作太频繁，请稍后再试') {
    return new AppException(ErrorCodes.RATE_LIMITED, message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

