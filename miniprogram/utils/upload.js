const config = require('../config/index');
const { request, getToken } = require('./request');

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
};

function extOf(filePath) {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filePath || '');
  return match ? match[1].toLowerCase() : 'jpg';
}

function mimeOf(filePath) {
  return MIME_BY_EXT[extOf(filePath)] || 'image/jpeg';
}

function statFile(filePath) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().getFileInfo({
      filePath,
      success: (res) => resolve(res.size || 0),
      fail: () => resolve(0)
    });
  });
}

function imageInfo(filePath) {
  return new Promise((resolve) => {
    wx.getImageInfo({
      src: filePath,
      success: (res) => resolve({ width: res.width, height: res.height }),
      fail: () => resolve({ width: 0, height: 0 })
    });
  });
}

/** 本地存储驱动：走我们自己的 /uploads/local，用业务 token 鉴权。 */
function uploadToLocal(signed, index, filePath) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: signed.uploadUrl,
      filePath,
      name: signed.fieldName || 'file',
      formData: { key: signed.keys[index] },
      header: { Authorization: `Bearer ${getToken()}` },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const body = JSON.parse(res.data || '{}');
            if (body.data && body.data.key) {
              resolve(body.data.key);
              return;
            }
            reject(new Error((body.error && body.error.message) || '上传失败'));
          } catch (error) {
            reject(new Error('上传响应解析失败'));
          }
          return;
        }
        reject(new Error(`上传失败(${res.statusCode})`));
      },
      fail: () => reject(new Error('上传中断，请重试'))
    });
  });
}

/**
 * COS 直传：用后端下发的临时密钥（10 分钟、限定在 uploads/{userId}/*）。
 * 需要在小程序目录执行 `npm i cos-wx-sdk-v5` 并在开发者工具里「构建 npm」。
 */
function uploadToCos(signed, index, filePath, onProgress) {
  let COS;
  try {
    COS = require('cos-wx-sdk-v5');
  } catch (error) {
    return Promise.reject(
      new Error('未安装 COS SDK：请在 miniprogram 目录执行 npm i cos-wx-sdk-v5 后构建 npm')
    );
  }

  const creds = signed.credentials || {};
  const cos = new COS({
    getAuthorization(options, callback) {
      callback({
        TmpSecretId: creds.tmpSecretId,
        TmpSecretKey: creds.tmpSecretKey,
        SecurityToken: creds.sessionToken,
        StartTime: Math.floor(Date.now() / 1000),
        ExpiredTime: creds.expiredTime
      });
    }
  });

  return new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: signed.bucket,
        Region: signed.region,
        Key: signed.keys[index],
        FilePath: filePath,
        onProgress(progress) {
          if (typeof onProgress === 'function') onProgress(progress);
        }
      },
      (err) => {
        if (err) reject(new Error(err.message || '图片上传失败'));
        else resolve(signed.keys[index]);
      }
    );
  });
}

/**
 * 批量上传：先申请凭证，再逐张上传。
 * 返回 keys（顺序与入参一致）与 urls（key -> 可直接预览的地址）。
 */
async function uploadPhotos(filePaths, options = {}) {
  if (!filePaths || !filePaths.length) return { keys: [], urls: {} };
  if (filePaths.length > config.maxPhotos) {
    throw new Error(`最多上传 ${config.maxPhotos} 张照片`);
  }

  const items = [];
  for (const filePath of filePaths) {
    const [size, info] = await Promise.all([statFile(filePath), imageInfo(filePath)]);
    items.push({
      mime: mimeOf(filePath),
      size: size || undefined,
      width: info.width || undefined,
      height: info.height || undefined
    });
  }

  const tooLarge = items.find((item) => item.size && item.size > config.maxPhotoMB * 1024 * 1024);
  if (tooLarge) throw new Error(`单张图片不能超过 ${config.maxPhotoMB}MB`);

  const signed = await request({
    url: '/uploads/photos/sign',
    method: 'POST',
    data: { items }
  });

  const keys = [];
  for (let index = 0; index < filePaths.length; index += 1) {
    if (typeof options.onProgress === 'function') {
      options.onProgress({ index, total: filePaths.length, phase: 'uploading' });
    }
    const key =
      signed.driver === 'cos'
        ? await uploadToCos(signed, index, filePaths[index], options.onItemProgress)
        : await uploadToLocal(signed, index, filePaths[index]);
    keys.push(key);
  }

  return { keys, urls: signed.urls || {}, driver: signed.driver };
}

module.exports = {
  uploadPhotos,
  mimeOf
};

