const config = require('../config/index');

const STORAGE_KEYS = {
  token: 'pss_token',
  user: 'pss_user',
  deviceId: 'pss_device_id'
};

/**
 * 开发环境可能配了多个候选后端地址（公司 Wi-Fi / 电脑热点）。
 * 请求纯粹因为网络层失败时自动换下一个候选重试，成功后固定用那个地址——
 * 这样真机换网络不用改代码重新编译。
 */
const BASE_CANDIDATES = [config.apiBaseUrl, ...(config.fallbackApiBaseUrls || [])].filter(
  (url, index, list) => url && list.indexOf(url) === index
);
let activeBaseUrl = BASE_CANDIDATES[0];

function getToken() {
  return wx.getStorageSync(STORAGE_KEYS.token) || '';
}

function setSession(token, user) {
  wx.setStorageSync(STORAGE_KEYS.token, token);
  if (user) wx.setStorageSync(STORAGE_KEYS.user, user);
}

function clearSession() {
  wx.removeStorageSync(STORAGE_KEYS.token);
  wx.removeStorageSync(STORAGE_KEYS.user);
}

/**
 * 统一请求封装：
 * - 自动带 Bearer token
 * - 401 时清掉本地会话并回调 onUnauthorized，由调用方决定是否重登
 * - 统一把后端的 { data } / { error } 拆开
 */
function request(options) {
  return dispatch(options, false);
}

// Opt-in mutation binding. This is a client-only guard, not an HTTP userId;
// the server still derives identity exclusively from its authenticated token.
function boundSessionError(options, allowMissing = false) {
  if (!options.boundUserId) return null;
  const auth = require('./auth');
  const user = typeof auth.currentUser === 'function' ? auth.currentUser() : null;
  const currentId = user && user.id;
  if (currentId === options.boundUserId || (allowMissing && !currentId)) return null;
  return { statusCode: 0, code: 'ACCOUNT_CHANGED', message: '当前账号已变化，请重新选择后提交' };
}

function dispatch(options, retried) {
  const sessionError = boundSessionError(options);
  if (sessionError) return Promise.reject(sessionError);
  const {
    url,
    method = 'GET',
    data,
    skipAuth = false,
    // 8 秒足够本地和公网正常请求；缩短后失败能更快暴露，而不是让页面长时间转圈
    timeout = 8000,
    header = {}
  } = options;

  const token = getToken();
  const finalHeader = { 'content-type': 'application/json', ...header };
  if (!skipAuth && token) finalHeader.Authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${activeBaseUrl}${url}`,
      method,
      data,
      header: finalHeader,
      timeout,
      success(res) {
        const changedAccount = boundSessionError(options, res.statusCode === 401);
        if (changedAccount) { reject(changedAccount); return; }
        const body = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body.data);
          return;
        }

        const error = (body && body.error) || {};
        const normalized = {
          statusCode: res.statusCode,
          code: error.code || 'UNKNOWN',
          message: error.message || `请求失败(${res.statusCode})`,
          details: error.details
        };

        if (res.statusCode === 401) {
          clearSession();
          const app = getApp();
          if (app) app.globalData.user = null;

          // token 过期（30 天）时自动重登并重放一次，用户无感知
          if (!skipAuth && !retried) {
            // 延迟 require，避免 request <-> auth 的循环依赖
            const auth = require('./auth');
            auth
              .ensureLogin(true)
              .then(() => {
                const changed = boundSessionError(options);
                if (changed) reject(changed);
                else resolve(dispatch(options, true));
              })
              .catch(() => reject(normalized));
            return;
          }
        }

        reject(normalized);
      },
      fail(err) {
        const changedAccount = boundSessionError(options);
        if (changedAccount) { reject(changedAccount); return; }
        // 网络层失败：还有没试过的候选就换一个再试一次（只试一轮，避免打转）
        if (!retried && BASE_CANDIDATES.length > 1) {
          const index = BASE_CANDIDATES.indexOf(activeBaseUrl);
          const next = BASE_CANDIDATES[(index + 1) % BASE_CANDIDATES.length];
          if (next && next !== activeBaseUrl) {
            console.warn(`[request] ${activeBaseUrl} 不通，换用 ${next} 重试`);
            activeBaseUrl = next;
            resolve(dispatch(options, true));
            return;
          }
        }

        // 真机调试最常见的失败：apiBaseUrl 指向 localhost（手机上的 localhost 是手机自己）。
        // 把目标地址 + 微信给的真实原因一起带出来，否则"域名没放行"和"网络不通"看起来一模一样。
        const host = activeBaseUrl.replace(/^https?:\/\//, '').split('/')[0];
        const reason = (err && err.errMsg ? String(err.errMsg) : '未知原因').replace(
          /^request:fail\s*/,
          ''
        );
        console.error(`[request] ${method} ${url} 失败\n  目标: ${host}\n  原因: ${reason}`, err);
        reject({
          statusCode: 0,
          code: 'NETWORK_ERROR',
          message: `网络不可用（目标 ${host}；${reason}）`,
          raw: err
        });
      }
    });
  });
}

/** 业务里最常用：失败时统一 toast，返回 null 让调用方判断。 */
async function requestSafe(options) {
  try {
    return await request(options);
  } catch (error) {
    wx.showToast({ title: error.message || '请求失败', icon: 'none' });
    return null;
  }
}

module.exports = {
  request,
  requestSafe,
  getToken,
  setSession,
  clearSession,
  STORAGE_KEYS
};
