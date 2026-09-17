const { request } = require('../../utils/request');
const auth = require('../../utils/auth');
const geo = require('../../utils/geo');
const format = require('../../utils/format');

const PAGE_SIZE = 10;

function decorate(spot) {
  return {
    ...spot,
    distanceText: format.formatDistance(spot.distanceMeters),
    createdText: format.formatDate(spot.createdAt),
    tagList: format.buildTags(spot)
  };
}

Page({
  data: {
    city: '',
    defaultCity: '',
    spots: [],
    cursor: '',
    loading: false,
    finished: false,
    located: false
  },

  onLoad() {
    // 首屏先出列表：登录和定位都放到后台，别让 3 秒的定位把首屏拖住
    this.reload();
    this.bootstrapCity();
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  /**
   * 后台补一次"我附近"的筛选：登录 → 低精度定位 → 反查城市。
   * 任何一步慢或不成功都只影响筛选，不影响已经渲染出来的列表。
   */
  async bootstrapCity() {
    await auth.ensureLogin().catch(() => null);
    if (this.userPickedCity) return;

    const location = await geo.getUserLocation({ highAccuracy: false, timeoutMs: 3000 });
    if (!location || this.userPickedCity) return;

    const meta = await request({
      url: `/geo/reverse?lng=${location.longitude}&lat=${location.latitude}`
    }).catch(() => null);
    if (this.userPickedCity) return;

    if (meta && meta.city) {
      this.setData({ city: meta.city, defaultCity: meta.city, located: true });
      this.reload();
    }
  },

  async reload() {
    this.setData({ spots: [], cursor: '', finished: false });
    return this.loadMore();
  },

  async loadMore() {
    if (this.data.loading || this.data.finished) return;
    this.setData({ loading: true });

    const app = getApp();
    const viewer = (app && app.globalData.lastLocation) || null;
    const query = [`limit=${PAGE_SIZE}`];
    if (this.data.city) query.push(`city=${encodeURIComponent(this.data.city)}`);
    if (this.data.cursor) query.push(`cursor=${encodeURIComponent(this.data.cursor)}`);
    if (viewer) query.push(`viewerLat=${viewer.latitude}`, `viewerLng=${viewer.longitude}`);

    const result = await request({ url: `/spots/feed?${query.join('&')}` }).catch((error) => {
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
      return null;
    });

    if (!result) {
      this.setData({ loading: false });
      return;
    }

    this.setData({
      spots: this.data.spots.concat(result.items.map(decorate)),
      cursor: result.nextCursor || '',
      finished: !result.nextCursor,
      loading: false
    });
  },

  onToggleCity() {
    // 用户自己切过之后，后台定位回来的城市不许再覆盖
    this.userPickedCity = true;
    const next = this.data.city ? '' : this.data.defaultCity || '';
    this.setData({ city: next });
    this.reload();
  },

  onSpotTap(event) {
    const { id } = event.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/spot/detail?id=${id}` });
  },

  /** 封面加载失败时标出来，避免"静默空白"让人以为是没图 */
  onCoverError(event) {
    const id = event.currentTarget.dataset.id;
    console.warn('[cover] 封面加载失败', id, event.detail);
    const spots = this.data.spots.map((spot) =>
      spot.id === id ? { ...spot, coverFailed: true, coverUrl: '' } : spot
    );
    this.setData({ spots });
  },

  onCreateTap() {
    wx.navigateTo({ url: '/pages/spot/create' });
  }
});
