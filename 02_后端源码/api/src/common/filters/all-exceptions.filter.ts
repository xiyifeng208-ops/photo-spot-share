import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ErrorCodes } from '../errors';

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/** 统一错误响应：{ error: { code, message, details } }。 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ErrorBody = {
      code: ErrorCodes.INTERNAL_ERROR,
      message: '服务开小差了，请稍后再试',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        body = { code: this.codeFromStatus(status), message: payload };
      } else if (payload && typeof payload === 'object') {
        const raw = payload as Record<string, unknown>;
        const message = raw.message;
        body = {
          code: (raw.code as string) ?? this.codeFromStatus(status),
          message: Array.isArray(message)
            ? String(message[0])
            : String(message ?? this.codeFromStatus(status)),
          details: raw.details ?? (Array.isArray(message) ? message : undefined),
        };
      }
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    if (status >= 500) {
      this.logger.error(`${status} ${body.code} ${body.message}`);
    }

    response.status(status).json({ error: body });
  }

  private codeFromStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCodes.BAD_REQUEST;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCodes.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCodes.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCodes.NOT_FOUND;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCodes.RATE_LIMITED;
      default:
        return status >= 500 ? ErrorCodes.INTERNAL_ERROR : ErrorCodes.BAD_REQUEST;
    }
  }
}

