const { request } = require('../../utils/request');
const auth = require('../../utils/auth');
const format = require('../../utils/format');

function decorate(spot) {
  return {
    ...spot,
    createdText: format.formatDate(spot.createdAt),
    tagList: format.buildTags(spot),
    // 机审中的机位只有作者自己能看到，这里明确标出来，避免以为没发出去
    statusText:
      spot.status === 'pending' ? '审核中' : spot.status === 'hidden' ? '已隐藏' : ''
  };
}

Page({
  data: {
    spots: [],
    loading: false,
    user: null
  },

  async onShow() {
    this.setData({ user: auth.currentUser() });
    await auth.ensureLogin().catch(() => null);
    this.setData({ user: auth.currentUser() });
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    const result = await request({ url: '/spots/mine?limit=50' }).catch((error) => {
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
      return null;
    });
    this.setData({
      spots: result ? result.items.map(decorate) : [],
      loading: false
    });
  },

  onSpotTap(event) {
    wx.navigateTo({ url: `/pages/spot/detail?id=${event.currentTarget.dataset.id}` });
  },

  onEditTap(event) {
    wx.navigateTo({ url: `/pages/spot/create?id=${event.currentTarget.dataset.id}` });
  },

  onDeleteTap(event) {
    const { id, title } = event.currentTarget.dataset;
    wx.showModal({
      title: '删除机位',
      content: `确定删除「${title}」吗？删除后其他人将看不到这个机位。`,
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        const result = await request({ url: `/spots/${id}`, method: 'DELETE' }).catch((error) => {
          wx.showToast({ title: error.message || '删除失败', icon: 'none' });
          return null;
        });
        if (result) {
          wx.showToast({ title: '已删除', icon: 'success' });
          this.load();
        }
      }
    });
  },

  onCreateTap() {
    wx.navigateTo({ url: '/pages/spot/create' });
  },

  onOpenLegal(event) {
    const type = event.currentTarget.dataset.type;
    wx.navigateTo({ url: `/pages/legal/index?type=${type}` });
  }
});
