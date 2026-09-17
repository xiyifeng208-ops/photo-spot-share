const config = require('../config/index');

/**
 * 取地图当前可视区域，用于按视野拉点位。
 * 必须带超时：地图组件没渲染出来时 getRegion 既不回调 success 也不回调 fail，
 * 调用方会永远停在"加载中"（开发者工具模拟器里就是这样）。
 */
function getRegionBbox(mapContext, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('地图尚未渲染完成')), timeoutMs);

    mapContext.getRegion({
      success(res) {
        const { southwest, northeast } = res;
        if (!southwest || !northeast) {
          finish(reject, new Error('地图视野不可用'));
          return;
        }
        finish(resolve, {
          bbox: [
            southwest.longitude.toFixed(6),
            southwest.latitude.toFixed(6),
            northeast.longitude.toFixed(6),
            northeast.latitude.toFixed(6)
          ].join(','),
          southwest,
          northeast
        });
      },
      fail(err) {
        finish(reject, err instanceof Error ? err : new Error('获取地图视野失败'));
      }
    });
  });
}

/** 取地图中心点，同样带超时，避免选点页卡死。 */
function getCenterLocation(mapContext, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('地图尚未渲染完成')), timeoutMs);

    mapContext.getCenterLocation({
      success: (res) => finish(resolve, res),
      fail: (err) => finish(reject, err instanceof Error ? err : new Error('获取地图中心点失败'))
    });
  });
}

/**
 * 获取用户位置（GCJ-02）。被拒绝、超时都不抛错，返回 null 由页面降级。
 * 默认不启用高精度：弱网/模拟器下高精度定位可能耗秒级甚至不回调，
 * 只有"创建机位需要精确落点"的场景才传 highAccuracy: true。
 */
function getUserLocation(options = {}) {
  const { highAccuracy = false, timeoutMs = 3000 } = options;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: highAccuracy,
      highAccuracyExpireTime: highAccuracy ? 4000 : undefined,
      success(res) {
        const location = { latitude: res.latitude, longitude: res.longitude };
        const app = getApp();
        if (app) app.globalData.lastLocation = location;
        finish(location);
      },
      fail() {
        finish(null);
      }
    });
  });
}

/** 引导用户去设置页重新打开地理位置权限。 */
function openLocationSetting() {
  return new Promise((resolve) => {
    wx.showModal({
      title: '需要定位权限',
      content: '打开定位后可以显示你附近的机位，并按距离排序。',
      confirmText: '去设置',
      success(res) {
        if (res.confirm) {
          wx.openSetting({ complete: () => resolve(true) });
        } else {
          resolve(false);
        }
      },
      fail: () => resolve(false)
    });
  });
}

function defaultRegion() {
  return {
    latitude: config.defaultCenter.latitude,
    longitude: config.defaultCenter.longitude,
    scale: config.defaultCenter.scale
  };
}

module.exports = {
  getRegionBbox,
  getCenterLocation,
  getUserLocation,
  openLocationSetting,
  defaultRegion
};
