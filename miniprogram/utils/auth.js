const config = require('../config/index');
const { request, setSession, clearSession, getToken, STORAGE_KEYS } = require('./request');

let pendingLogin = null;

function getOrCreateDeviceId() {
  let deviceId = wx.getStorageSync(STORAGE_KEYS.deviceId);
  if (!deviceId) {
    deviceId = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    wx.setStorageSync(STORAGE_KEYS.deviceId, deviceId);
  }
  return deviceId;
}

function getWxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (res.code) resolve(res.code);
        else reject(new Error('wx.login 未返回 code'));
      },
      fail(err) {
        reject(err);
      }
    });
  });
}

/** 用 code 换 token；本地开发走 dev:<设备ID> 分支。 */
async function login() {
  let code;
  if (config.useDevLogin) {
    code = `dev:${getOrCreateDeviceId()}`;
  } else {
    code = await getWxLoginCode();
  }

  const session = await request({
    url: '/auth/wx-login',
    method: 'POST',
    data: { code },
    skipAuth: true
  });

  setSession(session.token, session.user);
  const app = getApp();
  if (app) app.globalData.user = session.user;
  return session.user;
}

/** 并发调用时只真正登录一次。 */
function ensureLogin(force = false) {
  if (!force && getToken()) {
    const app = getApp();
    return Promise.resolve((app && app.globalData.user) || wx.getStorageSync(STORAGE_KEYS.user) || null);
  }
  if (pendingLogin) return pendingLogin;

  pendingLogin = login()
    .catch((error) => {
      clearSession();
      throw error;
    })
    .finally(() => {
      pendingLogin = null;
    });

  return pendingLogin;
}

function currentUser() {
  const app = getApp();
  return (app && app.globalData.user) || wx.getStorageSync(STORAGE_KEYS.user) || null;
}

module.exports = {
  ensureLogin,
  currentUser,
  login,
  clearSession
};

