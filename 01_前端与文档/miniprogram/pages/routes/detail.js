const { request } = require('../../utils/request');
const format = require('../../utils/format');

Page({
  data: { id: '', route: null, loading: false, error: '', unavailable: false },

  onLoad(query) {
    this.revision = 0;
    this.unloaded = false;
    this.hasShown = false;
    this.setData({ id: query.id || '' });
    this.reload();
  },
  onShow() {
    if (this.hasShown) this.reload();
    this.hasShown = true;
  },
  onUnload() { this.unloaded = true; this.revision += 1; },
  onPullDownRefresh() { return this.reload(); },
  onRetry() { return this.reload(); },
  onFavoriteCountsChanged() { if (!this.unloaded) return this.reload(); },

  async reload() {
    const revision = ++this.revision;
    this.setData({ route: null, loading: true, error: '', unavailable: false });
    try {
      if (!this.data.id) throw { code: 'NOT_FOUND', message: '路线不存在或暂不可用' };
      const route = await request({ url: `/routes/${encodeURIComponent(this.data.id)}`, skipAuth: true });
      if (this.unloaded || revision !== this.revision) return;
      this.setData({ route: { ...route, stops: route.stops.map(stop => ({
        ...stop, spot: { ...stop.spot, tagList: format.buildTags(stop.spot),
          favoriteCount: Number.isSafeInteger(stop.spot.favoriteCount) && stop.spot.favoriteCount >= 0 ? stop.spot.favoriteCount : 0 }
      })) } });
    } catch (error) {
      if (!this.unloaded && revision === this.revision) {
        this.setData({ error: error.message || '路线加载失败，请重试', unavailable: error.code === 'NOT_FOUND' });
      }
    } finally {
      if (!this.unloaded && revision === this.revision) {
        this.setData({ loading: false });
        wx.stopPullDownRefresh();
      }
    }
  },

  onSpotTap(event) {
    const id = event.currentTarget.dataset.id;
    if (this.data.route && this.data.route.stops.some(stop => stop.spot.id === id)) {
      wx.navigateTo({ url: `/pages/spot/detail?id=${encodeURIComponent(id)}` });
    }
  },
  onCoverError(event) {
    if (!this.data.route) return;
    const id = event.currentTarget.dataset.id;
    this.setData({ route: { ...this.data.route, stops: this.data.route.stops.map(stop => stop.spot.id === id
      ? { ...stop, spot: { ...stop.spot, coverUrl: '', coverFailed: true } } : stop) } });
  },
  onGoRoutes() { wx.redirectTo({ url: '/pages/routes/index' }); }
});
