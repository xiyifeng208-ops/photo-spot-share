const { request } = require('../../utils/request');

Page({
  data: { routes: [], loading: false, error: '' },

  onLoad() {
    this.revision = 0;
    this.unloaded = false;
    this.hasShown = false;
    this.reload();
  },
  onShow() {
    if (this.hasShown) this.reload();
    this.hasShown = true;
  },
  onUnload() { this.unloaded = true; this.revision += 1; },
  onPullDownRefresh() { return this.reload(); },
  onRetry() { return this.reload(); },

  async reload() {
    const revision = ++this.revision;
    this.setData({ loading: true, error: '', routes: [] });
    try {
      const data = await request({ url: '/routes', skipAuth: true });
      if (this.unloaded || revision !== this.revision) return;
      this.setData({ routes: data.items || [] });
    } catch (error) {
      if (!this.unloaded && revision === this.revision) {
        this.setData({ error: error.message || '路线加载失败，请重试' });
      }
    } finally {
      if (!this.unloaded && revision === this.revision) {
        this.setData({ loading: false });
        wx.stopPullDownRefresh();
      }
    }
  },

  onRouteTap(event) {
    const route = this.data.routes.find(item => item.id === event.currentTarget.dataset.id);
    if (route) wx.navigateTo({ url: `/pages/routes/detail?id=${encodeURIComponent(route.id)}` });
  },
  onCoverError(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ routes: this.data.routes.map(route => route.id === id ? { ...route, coverUrl: '', coverFailed: true } : route) });
  },
  onGoDiscover() { wx.switchTab({ url: '/pages/discover/index' }); }
});
