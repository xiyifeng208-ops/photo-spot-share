export type StorageDriverKind = 'local' | 'cos';

export interface UploadCredentials {
  /** 腾讯云临时密钥；本地驱动为 null。 */
  tmpSecretId: string | null;
  tmpSecretKey: string | null;
  sessionToken: string | null;
  /** 秒级时间戳 */
  expiredTime: number | null;
}

export interface SignedUpload {
  driver: StorageDriverKind;
  bucket: string | null;
  region: string | null;
  /** 本地驱动：小程序的 wx.uploadFile 目标地址 */
  uploadUrl: string | null;
  /** 本地驱动：表单字段名 */
  fieldName: string | null;
  credentials: UploadCredentials;
  keys: string[];
  /** key -> 可直接放入 <image src> 的地址 */
  urls: Record<string, string>;
}

export interface StorageDriver {
  readonly kind: StorageDriverKind;
  buildObjectKey(userId: string, mime: string): string;
  /** baseUrlOverride：本次请求的访问地址，只有本地驱动会用到（COS 走 CDN 域名）。 */
  signUpload(
    userId: string,
    items: { mime: string; count?: number }[],
    baseUrlOverride?: string,
  ): Promise<SignedUpload>;
  deleteObject(objectKey: string): Promise<void>;
  publicUrl(objectKey: string): string;
}

export const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const ALLOWED_MIME_TYPES = Object.keys(MIME_EXTENSIONS);

/** 单张图片上限 10MB。 */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** 每个打卡点最多 9 张样张。 */
export const MAX_PHOTOS_PER_SPOT = 9;
