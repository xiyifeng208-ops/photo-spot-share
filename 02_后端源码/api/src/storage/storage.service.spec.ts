import { loadConfig } from '../config/configuration';
import { runWithRequestContext } from '../common/request-context';
import { StorageService } from './storage.service';

function buildStorage(env: Record<string, string> = {}) {
  return new StorageService(
    loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:3000',
      STORAGE_DRIVER: 'local',
      ...env,
    } as NodeJS.ProcessEnv),
  );
}

describe('StorageService 的地址推导', () => {
  const key = 'uploads/user-1/20260916/a.jpg';

  it('没有请求上下文时用配置里的 PUBLIC_BASE_URL（模拟器场景）', () => {
    const storage = buildStorage();
    expect(storage.publicUrl(key)).toBe(`http://localhost:3000/static/${key}`);
  });

  // 真机通过局域网 IP / 电脑热点访问时，返回的地址必须是同一个来源，
  // 否则手机会拿到 localhost 的图片和上传地址（就是"上传中断请重试"的根因）
  it.each([
    'http://10.163.213.42:3000',
    'http://192.168.137.1:3000',
  ])('有请求上下文时按请求来源返回图片地址：%s', (base) => {
    const storage = buildStorage();
    runWithRequestContext(base, () => {
      expect(storage.publicUrl(key)).toBe(`${base}/static/${key}`);
    });
    // 上下文结束后回到默认值，不会污染后续请求
    expect(storage.publicUrl(key)).toBe(`http://localhost:3000/static/${key}`);
  });

  it('签发上传凭证时同样按请求来源给出上传地址', async () => {
    const storage = buildStorage();

    const viaLocalhost = await storage.signUpload('user-1', [{ mime: 'image/jpeg' }]);
    expect(viaLocalhost.uploadUrl).toBe('http://localhost:3000/api/v1/uploads/local');

    const viaLan = await new Promise<{ uploadUrl: string | null }>((resolve, reject) => {
      runWithRequestContext('http://192.168.137.1:3000', () => {
        storage.signUpload('user-1', [{ mime: 'image/jpeg' }]).then(resolve, reject);
      });
    });
    expect(viaLan.uploadUrl).toBe('http://192.168.137.1:3000/api/v1/uploads/local');
  });

  it('COS 驱动不受请求来源影响（走 CDN 域名）', () => {
    const storage = buildStorage({
      STORAGE_DRIVER: 'cos',
      COS_SECRET_ID: 'id',
      COS_SECRET_KEY: 'key',
      COS_BUCKET: 'bucket-1250000000',
      COS_REGION: 'ap-shanghai',
      CDN_BASE_URL: 'https://cdn.example.com',
    });

    runWithRequestContext('http://192.168.137.1:3000', () => {
      expect(storage.publicUrl(key)).toBe(`https://cdn.example.com/${key}`);
    });
  });
});

