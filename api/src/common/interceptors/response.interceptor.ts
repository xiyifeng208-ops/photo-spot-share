import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResult<T> {
  data: T;
}

/** 统一成功响应：{ data: ... }。 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResult<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiResult<T>> {
    return next.handle().pipe(map((data) => ({ data })));
  }
}

