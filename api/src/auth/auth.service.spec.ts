import { loadConfig } from '../config/configuration';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { WechatService } from './wechat.service';
import { AppException } from '../common/errors';

function buildService(options: { devMode?: boolean; openid?: string; throwOnWechat?: boolean } = {}) {
  const config = loadConfig({
    NODE_ENV: 'development',
    AUTH_DEV_MODE: options.devMode === false ? 'false' : 'true',
    JWT_SECRET: 'test-secret',
  } as NodeJS.ProcessEnv);

  const inserted: string[] = [];
  const db = {
    queryOne: jest.fn(async (_sql: string, params: unknown[]) => {
      inserted.push(String(params[0]));
      return {
        id: 'user-1',
        openid: String(params[0]),
        nickname: null,
        avatar_url: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      };
    }),
  };

  const wechat = {
    code2Session: jest.fn(async (code: string) => {
      if (options.throwOnWechat) throw AppException.badRequest('微信登录失败');
      return { openid: options.openid ?? `openid-${code}` };
    }),
  };

  const tokens = new TokenService(config);
  const service = new AuthService(
    config,
    db as never,
    wechat as unknown as WechatService,
    tokens,
  );
  return { service, db, wechat, tokens, inserted };
}

describe('AuthService', () => {
  it('开发模式下 dev: 前缀 code 直接生成稳定 openid', async () => {
    const { service, wechat } = buildService();
    const result = await service.loginWithCode('dev:alice');

    expect(result.user.id).toBe('user-1');
    expect(wechat.code2Session).not.toHaveBeenCalled();
    expect(result.token.split('.')).toHaveLength(3);
  });

  it('dev: 前缀只取设备标识部分，保证同一设备复用同一账号', async () => {
    const { service, inserted } = buildService();
    await service.loginWithCode('dev:device-abc');
    expect(inserted[0]).toBe('dev:device-abc');
  });

  it('关闭 dev 模式后拒绝 dev: code', async () => {
    const { service } = buildService({ devMode: false });
    await expect(service.loginWithCode('dev:alice')).rejects.toThrow(AppException);
  });

  it('真实 code 走微信换取 openid', async () => {
    const { service, wechat } = buildService({ openid: 'wx-openid-1' });
    await service.loginWithCode('real-code');
    expect(wechat.code2Session).toHaveBeenCalledWith('real-code');
  });

  it('dev: 后面为空时报错', async () => {
    const { service } = buildService();
    await expect(service.loginWithCode('dev:   ')).rejects.toThrow('开发登录缺少设备标识');
  });

  it('签发的 token 可被校验并带出 openid', async () => {
    const { service, tokens } = buildService();
    const { token } = await service.loginWithCode('dev:alice');
    const payload = tokens.verify(token);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.openid).toBe('dev:alice');
  });

  it('被篡改的 token 校验失败', async () => {
    const { tokens } = buildService();
    expect(tokens.verify('eyJhbGciOiJIUzI1NiJ9.fake.signature')).toBeNull();
  });
});

