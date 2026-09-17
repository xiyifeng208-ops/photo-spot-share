const { request } = require('../../utils/request');
const format = require('../../utils/format');

Page({
  data: {
    id: '',
    spot: null,
    photos: [],
    marker: [],
    loading: true,
    distanceText: '',
    createdText: '',
    params: []
  },

  onLoad(query) {
    this.setData({ id: query.id });
    this.loadDetail();
  },

  onShow() {
    // 编辑返回后刷新
    if (this.data.spot && this.needsRefresh) {
      this.needsRefresh = false;
      this.loadDetail();
    }
  },

  async loadDetail() {
    if (!this.data.id) {
      wx.showToast({ title: '缺少机位 ID', icon: 'none' });
      return;
    }

    this.setData({ loading: true });
    const location = (getApp() && getApp().globalData.lastLocation) || null;
    const query = location
      ? `?viewerLat=${location.latitude}&viewerLng=${location.longitude}`
      : '';

    const spot = await request({ url: `/spots/${this.data.id}${query}` }).catch((error) => {
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
      return null;
    });

    if (!spot) {
      this.setData({ loading: false });
      return;
    }

    const params = [];
    if (spot.headingLabel) params.push({ label: '机位朝向', value: spot.headingLabel });
    if (spot.bestTimeLabels.length) params.push({ label: '推荐时段', value: spot.bestTimeLabels.join(' / ') });
    if (spot.bestSeasonLabels.length) params.push({ label: '推荐季节', value: spot.bestSeasonLabels.join(' / ') });
    if (spot.focalLengthLabel) params.push({ label: '推荐焦段', value: spot.focalLengthLabel });
    params.push({ label: '到达难度', value: spot.difficultyLabel });
    params.push({ label: '浏览', value: `${spot.viewCount} 次` });

    this.setData({
      spot,
      photos: spot.photos,
      params,
      loading: false,
      distanceText: format.formatDistance(spot.distanceMeters),
      createdText: format.formatDate(spot.createdAt),
      marker: [
        {
          id: 1,
          latitude: spot.lat,
          longitude: spot.lng,
          iconPath: '/images/marker-active.png',
          width: 32,
          height: 43
        }
      ]
    });
  },

  onNavigateTap() {
    const { spot } = this.data;
    if (!spot) return;
    wx.openLocation({
      latitude: spot.lat,
      longitude: spot.lng,
      name: spot.title,
      address: [spot.province, spot.city, spot.district, spot.address].filter(Boolean).join(' '),
      scale: 18
    });
  },

  onCopyCoordinate() {
    const { spot } = this.data;
    if (!spot) return;
    wx.setClipboardData({
      data: `${spot.lat.toFixed(6)},${spot.lng.toFixed(6)}`,
      success: () => wx.showToast({ title: '坐标已复制', icon: 'none' })
    });
  },

  onPreviewPhoto(event) {
    const current = event.currentTarget.dataset.url;
    wx.previewImage({
      current,
      urls: this.data.photos.map((photo) => photo.url)
    });
  },

  onMapTap() {
    this.onNavigateTap();
  },

  onEditTap() {
    this.needsRefresh = true;
    wx.navigateTo({ url: `/pages/spot/create?id=${this.data.id}` });
  },

  onDeleteTap() {
    const { spot } = this.data;
    if (!spot) return;

    wx.showModal({
      title: '删除机位',
      content: '删除后其他人将看不到这个机位，确定继续吗？',
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        const result = await request({ url: `/spots/${spot.id}`, method: 'DELETE' }).catch(
          (error) => {
            wx.showToast({ title: error.message || '删除失败', icon: 'none' });
            return null;
          }
        );
        if (result) {
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 600);
        }
      }
    });
  }
});
