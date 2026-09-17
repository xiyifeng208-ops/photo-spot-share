import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 把"这次请求是从哪个地址进来的"带进调用栈。
 *
 * 为什么需要它：本地存储驱动要返回图片 URL 和上传地址，如果写死 PUBLIC_BASE_URL，
 * 那么手机用局域网 IP / 热点 IP 访问时，拿到的却是 localhost 的地址，上传和图片都会失败。
 * 按请求推导后，前端用哪个地址访问，返回的地址就是哪个，三种场景（模拟器 localhost、
 * 局域网 IP、电脑热点）都不用改配置。
 */
interface RequestContext {
  baseUrl: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(baseUrl: string, callback: () => T): T {
  return storage.run({ baseUrl }, callback);
}

export function currentRequestBaseUrl(): string | undefined {
  return storage.getStore()?.baseUrl;
}

