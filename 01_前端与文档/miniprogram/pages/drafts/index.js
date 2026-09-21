const auth = require('../../utils/auth');
const drafts = require('../../utils/drafts');
const format = require('../../utils/format');

Page({
  data: { items: [], loading: false, error: '', deletingId: '' },
  onLoad() { this.revision = 0; this.unloaded = false; },
  onShow() { return this.reload(); },
  onUnload() { this.unloaded = true; this.revision += 1; },
  onPullDownRefresh() { return this.reload().finally(() => wx.stopPullDownRefresh()); },
  async reload() {
    const revision = ++this.revision;
    const current = () => !this.unloaded && revision === this.revision;
    this.setData({ loading: true, error: '', items: [] });
    try {
      const user = await auth.ensureLogin();
      if (!current()) return;
      if (!user || !user.id) throw new Error('无法确定当前账号，请重试登录');
      this.owner = user.id;
      const items = await drafts.list(user.id);
      if (!current()) return;
      this.setData({ loading: false, items: items.map(item => ({
        id: item.id, title: item.title || '未命名草稿', updatedText: format.formatDate(item.updatedAt),
        cover: item.photos.length ? item.photos[0].path : '', photoCount: item.photos.length,
        region: item.geoMeta && (item.geoMeta.city || item.geoMeta.district) || '地区待填写'
      })) });
    } catch (error) {
      if (current()) this.setData({ loading: false, error: error.message || '读取草稿失败，请重试' });
    }
  },
  onResume(event) {
    const user = auth.currentUser();
    if (!user || user.id !== this.owner) { this.reload(); return; }
    wx.navigateTo({ url: `/pages/spot/create?draftId=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  },
  onDelete(event) {
    if (this.data.deletingId) return;
    const { id, title } = event.currentTarget.dataset;
    const owner = this.owner;
    wx.showModal({ title: '删除本机草稿', content: `删除「${title}」及其草稿照片？此操作无法恢复，不影响已发布作品。`,
      confirmColor: '#e5484d', success: async result => {
        if (!result.confirm || this.unloaded || this.data.deletingId) return;
        const user = auth.currentUser();
        if (!user || user.id !== owner) { this.reload(); return; }
        this.setData({ deletingId: id });
        try {
          const cleanup = await drafts.remove(owner, id);
          if (!this.unloaded) {
            wx.showToast({ title: cleanup && cleanup.cleanupPending ? '草稿已删除，照片待重试清理' : '草稿及本地照片已删除', icon: 'none' });
            await this.reload();
          }
        } catch (error) {
          if (!this.unloaded) wx.showToast({ title: error.message || '删除失败，请重试', icon: 'none' });
        } finally { if (!this.unloaded) this.setData({ deletingId: '' }); }
      }
    });
  },
  onCoverError(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ items: this.data.items.map(item => item.id === id ? { ...item, cover: '' } : item) });
  },
  onNew() { wx.navigateTo({ url: '/pages/spot/create?fresh=1' }); }
});
