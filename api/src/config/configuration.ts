export interface AppConfig {
  nodeEnv: string;
  port: number;
  publicBaseUrl: string;
  database: {
    url: string;
    ssl: boolean;
    poolMax: number;
  };
  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
    devMode: boolean;
  };
  wechat: {
    appId: string;
    appSecret: string;
    /** 小程序后台「消息推送」里配置的 Token，用于校验回调签名 */
    callbackToken: string;
  };
  amap: {
    key: string;
    baseUrl: string;
  };
  storage: {
    driver: 'local' | 'cos';
    localDir: string;
    cdnBaseUrl: string;
    cos: {
      secretId: string;
      secretKey: string;
      bucket: string;
      region: string;
      prefix: string;
    };
  };
  limits: {
    geoPerMinute: number;
    spotPerDay: number;
  };
  contentCheckEnabled: boolean;
  /** 运营接口令牌；为空则关闭运营接口 */
  adminToken: string;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const driver = (env.STORAGE_DRIVER ?? 'local').toLowerCase() === 'cos' ? 'cos' : 'local';

  return {
    nodeEnv,
    port: int(env.PORT, 3000),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    database: {
      url: env.DATABASE_URL ?? 'postgres://spot:spot@localhost:5432/spot',
      ssl: bool(env.DATABASE_SSL, false),
      poolMax: int(env.DATABASE_POOL_MAX, 10),
    },
    auth: {
      jwtSecret: env.JWT_SECRET ?? 'dev-only-secret-change-me',
      jwtExpiresIn: env.JWT_EXPIRES_IN ?? '30d',
      // 生产环境强制关闭 dev 登录，避免绕过微信鉴权
      devMode: nodeEnv !== 'production' && bool(env.AUTH_DEV_MODE, false),
    },
    wechat: {
      appId: env.WX_APPID ?? '',
      appSecret: env.WX_SECRET ?? '',
      callbackToken: env.WX_CALLBACK_TOKEN ?? '',
    },
    amap: {
      key: env.AMAP_KEY ?? '',
      baseUrl: (env.AMAP_BASE_URL ?? 'https://restapi.amap.com/v3').replace(/\/+$/, ''),
    },
    storage: {
      driver,
      localDir: env.LOCAL_STORAGE_DIR ?? 'var/uploads',
      cdnBaseUrl: (env.CDN_BASE_URL ?? '').replace(/\/+$/, ''),
      cos: {
        secretId: env.COS_SECRET_ID ?? '',
        secretKey: env.COS_SECRET_KEY ?? '',
        bucket: env.COS_BUCKET ?? '',
        region: env.COS_REGION ?? 'ap-shanghai',
        prefix: (env.COS_UPLOAD_PREFIX ?? 'uploads').replace(/^\/+|\/+$/g, ''),
      },
    },
    limits: {
      geoPerMinute: int(env.RATE_LIMIT_GEO_PER_MINUTE, 30),
      spotPerDay: int(env.RATE_LIMIT_SPOT_PER_DAY, 20),
    },
    contentCheckEnabled: bool(env.CONTENT_CHECK_ENABLED, false),
    adminToken: env.ADMIN_TOKEN ?? '',
  };
}

export const APP_CONFIG = 'APP_CONFIG';
