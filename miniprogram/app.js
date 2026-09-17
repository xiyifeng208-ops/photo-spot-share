const config = require('./config/index');
const auth = require('./utils/auth');

App({
  globalData: {
    config,
    user: null,
    // 用户最近一次定位（GCJ-02），用于列表页计算距离
    lastLocation: null
  },

  onLaunch() {
    // 静默登录：失败不阻塞进入地图，浏览接口对未登录用户开放
    auth.ensureLogin().catch((error) => {
      console.warn('[app] 登录失败', error);
    });
  },

  onShow() {
    if (this.globalData.user) return;
    auth.ensureLogin().catch(() => {});
  }
});

