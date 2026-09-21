const { request } = require('../../utils/request');
const auth = require('../../utils/auth');
const format = require('../../utils/format');
const shootingTime = require('../../utils/shooting-time');
const FEEDBACK_OPTIONS = [
  { kind: 'still_accessible', label: '仍可拍摄' },
  { kind: 'location_changed', label: '位置有变化' },
  { kind: 'access_restricted', label: '入口受限' },
  { kind: 'obstructed', label: '现场遮挡' }
];

Page({
  data: {
    id: '',
    spot: null,
    photos: [],
    marker: [],
    loading: true,
    distanceText: '',
    createdText: '',
    params: [],
    favoritePending: false,
    favoriteStateReady: false,
    feedbackOptions: FEEDBACK_OPTIONS, feedbackItems: [], feedbackCursor: '', myFeedback: null,
    feedbackKind: '', feedbackLoading: false, feedbackMoreLoading: false, feedbackLoaded: false,
    feedbackError: '', feedbackActionError: '', feedbackNotice: '', feedbackPending: false,
    shootingDate: '', shootingRows: [], shootingNotes: [], shootingLoading: false,
    shootingLoaded: false, shootingError: ''
  },

  onLoad(query) {
    this.unloaded = false;
    this.detailRevision = 0;
    this.favoriteRevision = 0;
    this.feedbackRevision = 0;
    this.shootingRevision = 0;
    this.feedbackMutationRevision = 0;
    this.toolsReady = false;
    this.setData({ id: query.id });
    this.loadDetail();
  },

  onReady() {
    this.toolsReady = true;
    if (!this.data.shootingDate) this.setData({ shootingDate: shootingTime.beijingDate() });
    if (this.data.spot && !this.data.loading) this.refreshDetailTools();
  },

  onUnload() {
    this.unloaded = true;
    this.detailRevision += 1;
    this.feedbackRevision += 1;
    this.shootingRevision += 1;
    this.feedbackMutationRevision += 1;
  },

  onShow() {
    const accountChanged = this.data.spot && this.favoriteOwnerId !== undefined
      && this.favoriteOwnerId !== this.currentFeedbackUser();
    if (this.toolsReady && this.feedbackOwnerId !== this.currentFeedbackUser()) {
      this.resetFeedbackIdentity(this.currentFeedbackUser(), true);
      if (this.data.spot && !this.needsRefresh && !accountChanged) this.refreshDetailTools();
    }
    if (accountChanged) {
      this.needsRefresh = false;
      return this.loadDetail();
    }
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

    const revision = ++this.detailRevision;
    this.feedbackRevision += 1;
    this.shootingRevision += 1;
    const favoriteRevision = this.favoriteRevision;
    this.setData({ loading: true, favoriteStateReady: false,
      feedbackLoading: false, feedbackMoreLoading: false, shootingLoading: false });
    let favoriteStateReady = false;
    try {
      // Public detail accepts anonymous access. Validate the session separately so
      // an expired token cannot silently turn an existing favorite into "not saved".
      await auth.ensureLogin();
      if (this.unloaded || revision !== this.detailRevision) return;
      await request({ url: '/auth/me' });
      favoriteStateReady = true;
    } catch (_) {
      // Login failure must not prevent browsing public spots, but a toggle then
      // needs to retry this load instead of guessing the current favorite state.
    }
    if (this.unloaded || revision !== this.detailRevision) return;
    const location = (getApp() && getApp().globalData.lastLocation) || null;
    const query = location
      ? `?viewerLat=${location.latitude}&viewerLng=${location.longitude}`
      : '';
    const detailUserId = this.currentFeedbackUser();

    const spot = await request({ url: `/spots/${this.data.id}${query}` }).catch((error) => {
      if (!this.unloaded && revision === this.detailRevision) {
        wx.showToast({ title: error.message || '加载失败', icon: 'none' });
      }
      return null;
    });

    if (this.unloaded || revision !== this.detailRevision) return;
    if (!spot) {
      this.setData({ loading: false });
      return;
    }
    if (detailUserId !== this.currentFeedbackUser()) return this.loadDetail();

    // A detail request started before a completed toggle must not undo that toggle.
    if (favoriteRevision !== this.favoriteRevision && this.data.spot
      && this.data.spot.id === spot.id && this.favoriteOwnerId === detailUserId) {
      spot.isFavorited = this.data.spot.isFavorited;
      spot.favoriteCount = this.data.spot.favoriteCount;
      favoriteStateReady = this.data.favoriteStateReady;
    }
    this.favoriteOwnerId = detailUserId;
    spot.favoriteCount = Number.isSafeInteger(spot.favoriteCount) && spot.favoriteCount >= 0 ? spot.favoriteCount : 0;

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
      favoriteStateReady,
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
    if (this.toolsReady) this.refreshDetailTools();
  },

  // Independent cards start after the view is ready. They never re-fetch spot
  // detail (and therefore never increase its view counter) on their own.
  refreshDetailTools() {
    const userId = this.currentFeedbackUser();
    if (this.feedbackOwnerId !== userId) this.resetFeedbackIdentity(userId, this.feedbackOwnerId !== undefined);
    this.feedbackRevision += 1;
    this.shootingRevision += 1;
    this.setData({ feedbackLoading: false, feedbackMoreLoading: false, shootingLoading: false });
    if (!this.data.spot || this.data.spot.status !== 'active' || this.unloaded) {
      this.setData({ feedbackItems: [], myFeedback: null, feedbackCursor: '', feedbackLoaded: false,
        feedbackError: '', shootingRows: [], shootingNotes: [], shootingLoaded: false, shootingError: '' });
      return;
    }
    this.loadFeedback(true);
    this.loadShootingTimes();
  },

  currentFeedbackUser() {
    const user = typeof auth.currentUser === 'function' ? auth.currentUser() : null;
    return user && typeof user.id === 'string' ? user.id : null;
  },
  resetFeedbackIdentity(userId, notify = false) {
    this.feedbackRevision += 1;
    this.feedbackMutationRevision += 1;
    this.feedbackOwnerId = userId;
    this.feedbackKindTouched = false;
    this.lastFeedbackAction = null;
    this.setData({ feedbackItems: [], feedbackCursor: '', myFeedback: null, feedbackKind: '',
      feedbackLoaded: false, feedbackLoading: false, feedbackMoreLoading: false, feedbackPending: false,
      feedbackError: '', feedbackActionError: '',
      feedbackNotice: notify ? '当前账号已变化，请重新选择现场情况后提交。' : '' });
  },
  feedbackIdentityChanged(userId) {
    if (userId === this.currentFeedbackUser()) return false;
    this.resetFeedbackIdentity(this.currentFeedbackUser(), true);
    this.loadFeedback(true);
    return true;
  },

  async loadFeedback(reset = true) {
    const { spot } = this.data;
    if (!spot || spot.status !== 'active' || this.unloaded || this.data.feedbackPending) return;
    if (!reset && (this.data.feedbackLoading || this.data.feedbackMoreLoading || !this.data.feedbackCursor)) return;
    const revision = ++this.feedbackRevision;
    const detailRevision = this.detailRevision;
    const userId = this.currentFeedbackUser();
    const cursor = reset ? '' : this.data.feedbackCursor;
    this.feedbackRetryMore = !reset;
    this.setData({ feedbackLoading: reset, feedbackMoreLoading: !reset, feedbackError: '' });
    try {
      const result = await request({ url: `/spots/${spot.id}/feedback?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` });
      if (this.unloaded || revision !== this.feedbackRevision || detailRevision !== this.detailRevision) return;
      if (this.feedbackIdentityChanged(userId)) return;
      const items = (result.items || []).map(item => this.feedbackView(item));
      const merged = reset ? items : this.data.feedbackItems.concat(items);
      const seen = new Set();
      this.setData({ feedbackItems: merged.filter(item => !seen.has(item.id) && seen.add(item.id)),
        feedbackCursor: result.nextCursor || '', myFeedback: result.myFeedback ? this.feedbackView(result.myFeedback) : null,
        feedbackLoaded: true, feedbackLoading: false, feedbackMoreLoading: false });
      if (reset && !this.feedbackKindTouched) this.setData({ feedbackKind: result.myFeedback ? result.myFeedback.kind : '' });
    } catch (error) {
      if (this.unloaded || revision !== this.feedbackRevision || detailRevision !== this.detailRevision) return;
      if (this.feedbackIdentityChanged(userId)) return;
      this.setData({ feedbackLoading: false, feedbackMoreLoading: false, feedbackError: error.message || '反馈加载失败，请重试' });
    }
  },
  feedbackView(item) {
    return { ...item, updatedText: shootingTime.beijingTime(item.updatedAt),
      label: (FEEDBACK_OPTIONS.find(option => option.kind === item.kind) || {}).label || item.label || '现场反馈' };
  },
  onFeedbackRetry() { return this.loadFeedback(!this.feedbackRetryMore); },
  onFeedbackMore() { return this.loadFeedback(false); },
  onChooseFeedback(event) {
    if (this.data.feedbackPending || this.data.loading) return;
    const kind = event.currentTarget.dataset.kind;
    if (!FEEDBACK_OPTIONS.some(option => option.kind === kind)) return;
    this.feedbackKindTouched = true;
    this.setData({ feedbackKind: kind, feedbackActionError: '', feedbackNotice: '' });
  },
  onSubmitFeedback() {
    if (!FEEDBACK_OPTIONS.some(option => option.kind === this.data.feedbackKind)) {
      wx.showToast({ title: '请先选择一种现场情况', icon: 'none' });
      return;
    }
    return this.writeFeedback('PUT', this.data.feedbackKind);
  },
  onWithdrawFeedback() {
    if (!this.data.myFeedback) return;
    return this.writeFeedback('DELETE');
  },
  onFeedbackActionRetry() {
    if (this.lastFeedbackAction) {
      if (this.lastFeedbackAction.userId && this.feedbackIdentityChanged(this.lastFeedbackAction.userId)) return;
      return this.writeFeedback(this.lastFeedbackAction.method, this.lastFeedbackAction.kind);
    }
  },
  async writeFeedback(method, kind) {
    const { spot } = this.data;
    if (!spot || spot.status !== 'active' || this.unloaded || this.data.loading || this.data.feedbackPending) return;
    if (this.feedbackOwnerId !== undefined && this.feedbackIdentityChanged(this.feedbackOwnerId)) return;
    const revision = ++this.feedbackMutationRevision;
    const detailRevision = this.detailRevision;
    const startUserId = this.currentFeedbackUser();
    let writeUserId = startUserId;
    this.feedbackRevision += 1;
    this.lastFeedbackAction = { method, kind, userId: startUserId };
    this.setData({ feedbackPending: true, feedbackLoading: false, feedbackMoreLoading: false, feedbackActionError: '' });
    try {
      await auth.ensureLogin();
      if (this.unloaded || revision !== this.feedbackMutationRevision) return;
      if (startUserId && this.feedbackIdentityChanged(startUserId)) return;
      writeUserId = this.currentFeedbackUser();
      if (!writeUserId) throw new Error('无法确认当前账号，请重新登录后重试');
      this.feedbackOwnerId = writeUserId;
      this.lastFeedbackAction = { method, kind, userId: writeUserId };
      const result = await request({ url: `/spots/${spot.id}/feedback`, method, boundUserId: writeUserId,
        ...(method === 'PUT' ? { data: { kind } } : {}) });
      if (this.unloaded || revision !== this.feedbackMutationRevision) return;
      if (this.feedbackIdentityChanged(writeUserId)) return;
      if (detailRevision === this.detailRevision) {
        const mine = method === 'PUT' ? this.feedbackView(result.feedback) : null;
        this.feedbackKindTouched = false;
        this.setData({ myFeedback: mine, feedbackKind: mine ? mine.kind : '', feedbackCursor: '',
          feedbackItems: (mine ? [mine] : []).concat(this.data.feedbackItems.filter(item => !item.isMine)), feedbackError: '' });
        wx.showToast({ title: mine ? '反馈已更新 · 未经核实' : '反馈已撤回', icon: 'none' });
      }
      this.lastFeedbackAction = null;
      this.setData({ feedbackPending: false });
      return this.loadFeedback(true);
    } catch (error) {
      if (this.unloaded || revision !== this.feedbackMutationRevision) return;
      if (writeUserId && this.feedbackIdentityChanged(writeUserId)) return;
      this.setData({ feedbackActionError: error.message || '反馈提交失败，请重试' });
      wx.showToast({ title: error.message || '反馈提交失败，请重试', icon: 'none' });
    } finally {
      if (!this.unloaded && revision === this.feedbackMutationRevision) this.setData({ feedbackPending: false });
    }
  },

  onShootingDateChange(event) {
    const date = event.detail.value;
    if (!shootingTime.validDate(date)) {
      wx.showToast({ title: '请选择 2000—2100 年的有效日期', icon: 'none' });
      return;
    }
    this.setData({ shootingDate: date });
    return this.loadShootingTimes();
  },
  onShootingRetry() { return this.loadShootingTimes(); },
  async loadShootingTimes() {
    const { spot, shootingDate } = this.data;
    if (!spot || spot.status !== 'active' || this.unloaded) return;
    const revision = ++this.shootingRevision;
    const detailRevision = this.detailRevision;
    this.setData({ shootingLoading: true, shootingLoaded: false, shootingError: '', shootingRows: [], shootingNotes: [] });
    try {
      const result = await request({ url: `/spots/${spot.id}/shooting-times?date=${encodeURIComponent(shootingDate)}` });
      if (this.unloaded || revision !== this.shootingRevision || detailRevision !== this.detailRevision) return;
      this.setData({ shootingRows: shootingTime.rows(result), shootingNotes: result.notes || [],
        shootingLoading: false, shootingLoaded: true });
    } catch (error) {
      if (this.unloaded || revision !== this.shootingRevision || detailRevision !== this.detailRevision) return;
      this.setData({ shootingLoading: false, shootingError: error.message || '拍摄时间计算失败，请重试' });
    }
  },

  async onFavoriteTap() {
    const { spot, favoritePending, favoriteStateReady, loading } = this.data;
    if (!spot || favoritePending || loading || this.unloaded) return;
    if (!favoriteStateReady) return this.loadDetail();
    const startUserId = this.currentFeedbackUser();
    if (this.favoriteOwnerId !== undefined && this.favoriteOwnerId !== startUserId) return this.loadDetail();
    if (!spot.isFavorited && spot.status !== 'active') {
      wx.showToast({ title: '仅公开作品可以收藏', icon: 'none' });
      return;
    }
    const isFavorited = !spot.isFavorited;
    const spotId = spot.id;
    let writeUserId = startUserId;
    this.setData({ favoritePending: true });
    try {
      await auth.ensureLogin();
      if (this.unloaded) return;
      if (!this.data.spot || this.data.spot.id !== spotId || this.data.id !== spotId) return;
      writeUserId = this.currentFeedbackUser();
      if (!writeUserId) throw new Error('无法确认当前账号，请重新登录后重试');
      if (startUserId && writeUserId !== startUserId) {
        wx.showToast({ title: '当前账号已变化，请重新确认收藏状态', icon: 'none' });
        return this.loadDetail();
      }
      const result = await request({
        url: `/spots/${spotId}/favorite`, method: isFavorited ? 'PUT' : 'DELETE',
        boundUserId: writeUserId
      });
      // The operation may complete after the user has already returned to the
      // feed; notify that visible page even if this detail has been unloaded.
      this.notifyFavoriteCountChange();
      if (this.unloaded) return;
      if (!this.data.spot || this.data.spot.id !== spotId || this.data.id !== spotId) return;
      if (writeUserId && this.currentFeedbackUser() !== writeUserId) return this.loadDetail();
      this.favoriteRevision += 1;
      const favoriteCount = Number.isSafeInteger(result.favoriteCount) && result.favoriteCount >= 0
        ? result.favoriteCount : this.data.spot.favoriteCount;
      this.setData({ spot: { ...this.data.spot, isFavorited: result.isFavorited, favoriteCount }, favoriteStateReady: true });
      wx.showToast({ title: result.isFavorited ? '已加入想去清单' : '已取消收藏', icon: 'none' });
    } catch (error) {
      if (!this.unloaded) wx.showToast({ title: error.message || '收藏操作失败，请重试', icon: 'none' });
      if (!this.unloaded && writeUserId && this.currentFeedbackUser() !== writeUserId) return this.loadDetail();
    } finally {
      if (!this.unloaded) this.setData({ favoritePending: false });
    }
  },

  notifyFavoriteCountChange() {
    const app = getApp();
    if (app && typeof app.notifyFavoriteCountChange === 'function') app.notifyFavoriteCountChange(this);
    else if (app && app.globalData) app.globalData.favoriteCountRevision = (app.globalData.favoriteCountRevision || 0) + 1;
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

  /** 举报（作者本人看不到这个入口） */
  onReportTap() {
    const reasons = ['违法违规内容', '侵犯他人权益', '虚假或误导信息', '地点敏感或危险', '其他'];
    wx.showActionSheet({
      itemList: reasons,
      success: async (res) => {
        const reason = reasons[res.tapIndex];
        const result = await request({
          url: `/spots/${this.data.id}/report`,
          method: 'POST',
          data: { reason }
        }).catch((error) => {
          wx.showToast({ title: error.message || '举报失败', icon: 'none' });
          return null;
        });
        if (result) {
          wx.showToast({ title: '已收到举报，我们会尽快核实', icon: 'none' });
        }
      }
    });
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
