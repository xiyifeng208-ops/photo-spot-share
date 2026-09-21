const { request } = require('../../utils/request');
const auth = require('../../utils/auth');
const format = require('../../utils/format');
const { provinces } = require('../../data/cities');
const PAGE_SIZE = 10;
const newList = () => ({ spots: [], cursor: '', loading: false, finished: false, error: '', loaded: false });

function decorate(spot) {
  return {
    ...spot,
    favoriteCount: Number.isSafeInteger(spot.favoriteCount) && spot.favoriteCount >= 0 ? spot.favoriteCount : 0,
    createdText: format.formatDate(spot.createdAt),
    tagList: format.buildTags(spot),
    statusText: spot.status === 'pending' ? '审核中' : spot.status === 'hidden' ? '已隐藏' : ''
  };
}

Page({
  data: {
    activeTab: 'mine',
    mineList: newList(),
    favoritesList: newList(),
    list: newList(),
    user: null,
    favoritePending: {},
    province: '', city: '', district: '', cityLabel: '全部城市',
    cityPickerOpen: false,
    provinces: provinces.map(({ code, name }) => ({ code, name })),
    pickerProvinceCode: provinces[0].code,
    pickerCities: provinces[0].cities,
    selectedCityCode: ''
  },

  onLoad() {
    this.unloaded = false;
    this.revisions = { mine: 0, favorites: 0 };
  },

  onShow() {
    if (!this.revisions) this.onLoad();
    this.setData({ user: auth.currentUser() });
    return this.reload(this.data.activeTab);
  },

  onUnload() {
    this.unloaded = true;
    this.revisions.mine += 1;
    this.revisions.favorites += 1;
  },

  onHide() { this.onCloseCityPicker(); },
  onFavoriteCountsChanged() { if (!this.unloaded) return this.reload(this.data.activeTab); },

  setList(tab, patch) {
    if (this.unloaded) return;
    const key = tab + 'List';
    const list = { ...this.data[key], ...patch };
    this.setData({ [key]: list, ...(this.data.activeTab === tab ? { list } : {}) });
  },

  onSwitchTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (!['mine', 'favorites'].includes(tab) || tab === this.data.activeTab) return;
    this.setData({ activeTab: tab, list: this.data[tab + 'List'], cityPickerOpen: false });
    return this.reload(tab);
  },

  reload(tab = this.data.activeTab) {
    if (this.unloaded) return Promise.resolve();
    const revision = ++this.revisions[tab];
    this.setList(tab, newList());
    return this.fetchPage(tab, revision, '');
  },

  // Retain the existing name used by delete/edit flows.
  load() { return this.reload(); },

  onPullDownRefresh() {
    return this.reload().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.list.error) return this.loadMore();
  },

  loadMore(tab = this.data.activeTab) {
    const list = this.data[tab + 'List'];
    if (this.unloaded || list.loading || list.finished) return Promise.resolve();
    return this.fetchPage(tab, this.revisions[tab], list.cursor);
  },

  async fetchPage(tab, revision, cursor) {
    const isCurrent = () => !this.unloaded && revision === this.revisions[tab];
    if (!isCurrent()) return;
    this.setList(tab, { loading: true, error: '' });
    const query = [`limit=${PAGE_SIZE}`];
    if (cursor) query.push(`cursor=${encodeURIComponent(cursor)}`);
    if (tab === 'favorites') {
      for (const field of ['province', 'city', 'district']) {
        if (this.data[field]) query.push(`${field}=${encodeURIComponent(this.data[field])}`);
      }
    }
    try {
      await auth.ensureLogin();
      if (!isCurrent()) return;
      this.setData({ user: auth.currentUser() });
      const result = await request({ url: `/spots/${tab}?${query.join('&')}` });
      if (!isCurrent()) return;
      const list = this.data[tab + 'List'];
      this.setList(tab, {
        spots: (cursor ? list.spots : []).concat(result.items.map(decorate)),
        cursor: result.nextCursor || '', finished: !result.nextCursor,
        loading: false, error: '', loaded: true
      });
    } catch (error) {
      if (isCurrent()) this.setList(tab, { loading: false, error: error.message || '加载失败，请重试' });
    }
  },

  onRetry() {
    return this.data.list.spots.length ? this.loadMore() : this.reload();
  },

  onToggleCity() {
    if (this.data.activeTab !== 'favorites') return;
    this.setData({ cityPickerOpen: !this.data.cityPickerOpen });
  },

  onCloseCityPicker() { this.setData({ cityPickerOpen: false }); },
  onPanelTouchMove() {},

  onSelectProvince(event) {
    const province = provinces.find(p => p.code === event.currentTarget.dataset.code);
    if (!province) return;
    this.setData({ pickerProvinceCode: province.code, pickerCities: province.cities });
  },

  onSelectCity(event) {
    const province = provinces.find(p => p.code === this.data.pickerProvinceCode);
    const city = province && province.cities.find(c => c.code === event.currentTarget.dataset.code);
    if (!city) return;
    this.setData({
      province: province.name,
      city: city.field === 'city' ? city.name : '',
      district: city.field === 'district' ? city.name : '',
      cityLabel: city.name, selectedCityCode: city.code, cityPickerOpen: false
    });
    return this.reload('favorites');
  },

  onSelectAllCities() {
    this.setData({ province: '', city: '', district: '', cityLabel: '全部城市', selectedCityCode: '', cityPickerOpen: false });
    return this.reload('favorites');
  },

  async onCancelFavorite(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || this.data.favoritePending[id] || this.unloaded) return;
    const listOwnerId = this.data.user && this.data.user.id;
    const initialUser = auth.currentUser();
    const startUserId = initialUser && initialUser.id;
    this.setData({ favoritePending: { ...this.data.favoritePending, [id]: true } });
    try {
      await auth.ensureLogin();
      if (this.unloaded) return;
      const user = auth.currentUser();
      if (!user || !user.id) throw new Error('无法确认当前账号，请重新登录后重试');
      if ((listOwnerId && listOwnerId !== user.id) || (startUserId && startUserId !== user.id)) {
        throw new Error('当前账号已变化，请刷新清单后重试');
      }
      await request({ url: `/spots/${id}/favorite`, method: 'DELETE', boundUserId: user.id });
      const app = getApp();
      if (app && typeof app.notifyFavoriteCountChange === 'function') app.notifyFavoriteCountChange(this);
      else if (app && app.globalData) app.globalData.favoriteCountRevision = (app.globalData.favoriteCountRevision || 0) + 1;
      if (this.unloaded) return;
      wx.showToast({ title: '已取消收藏', icon: 'none' });
      // Reload invalidates in-flight pagination and preserves the current city.
      const activeTab = this.data.activeTab;
      const refreshes = [this.reload('favorites')];
      // The user can switch tabs while the DELETE is pending. Their own work's
      // public count must also be refreshed without changing the active tab.
      if (activeTab !== 'favorites') refreshes.push(this.reload(activeTab));
      return await Promise.all(refreshes);
    } catch (error) {
      if (!this.unloaded) wx.showToast({ title: error.message || '取消收藏失败，请重试', icon: 'none' });
    } finally {
      if (!this.unloaded) {
        const pending = { ...this.data.favoritePending };
        delete pending[id];
        this.setData({ favoritePending: pending });
      }
    }
  },

  onSpotTap(event) {
    wx.navigateTo({ url: `/pages/spot/detail?id=${event.currentTarget.dataset.id}` });
  },

  onCoverError(event) {
    const id = event.currentTarget.dataset.id;
    const tab = this.data.activeTab;
    this.setList(tab, {
      spots: this.data[tab + 'List'].spots.map(spot => spot.id === id ? { ...spot, coverUrl: '' } : spot)
    });
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
        if (result && !this.unloaded) {
          wx.showToast({ title: '已删除', icon: 'success' });
          this.reload('mine');
        }
      }
    });
  },

  onCreateTap() { wx.navigateTo({ url: '/pages/spot/create' }); },
  onDraftsTap() { wx.navigateTo({ url: '/pages/drafts/index' }); },
  onGoDiscover() { wx.switchTab({ url: '/pages/discover/index' }); },

  onOpenLegal(event) {
    const type = event.currentTarget.dataset.type;
    wx.navigateTo({ url: `/pages/legal/index?type=${type}` });
  }
});
