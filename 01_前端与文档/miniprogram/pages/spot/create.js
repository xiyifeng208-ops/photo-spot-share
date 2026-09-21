const config = require('../../config/index');
const { request } = require('../../utils/request');
const auth = require('../../utils/auth');
const geo = require('../../utils/geo');
const format = require('../../utils/format');
const { uploadPhotos } = require('../../utils/upload');
const drafts = require('../../utils/drafts');
const regions = require('../../utils/publish-region');
const REVERSE_DEBOUNCE_MS = 500;
const AUTOSAVE_MS = 500;

Page({
  data: {
    step: 1, editId: '', isEdit: false, submitting: false, initializing: true, editLoadError: false,
    pointPending: false,
    latitude: config.defaultCenter.latitude, longitude: config.defaultCenter.longitude, scale: 16,
    addressText: '正在获取地址…', addressInput: '', geoMeta: null, geoConfigured: true,
    locating: false, located: false, locationConfirmed: false,
    regionLabel: '请选择省份 / 城市', regionIndices: [0, 0],
    regionColumns: [regions.provinces.map(p => p.name), regions.provinces[0].cities.map(c => c.name)],
    title: '', description: '', accessNote: '', heading: '', bestTimes: [], bestSeasons: [],
    focalLength: '', difficulty: null,
    photos: [], maxPhotos: config.maxPhotos, agreed: false,
    draftId: '', draftStatus: '草稿仅保存在本机', draftSaving: false, missingPhotoCount: 0,
    headingOptions: format.HEADING_OPTIONS, bestTimeOptions: format.BEST_TIME_OPTIONS,
    seasonOptions: format.SEASON_OPTIONS, focalLengthOptions: format.FOCAL_LENGTH_OPTIONS,
    difficultyOptions: format.DIFFICULTY_OPTIONS
  },

  async onLoad(query = {}) {
    this.unloaded = false;
    this.reverseSeq = 0;
    this.interactionSeq = 0;
    this.addressRevision = 0;
    this.editVersion = 0;
    this.savedVersion = 0;
    this.published = false;
    this.geoDirty = false;
    this.mapContext = wx.createMapContext('pickerMap', this);
    this.setData({ isEdit: Boolean(query.id), editId: query.id || '' });
    this.syncOptionSelection();
    const user = await auth.ensureLogin().catch(() => null);
    if (this.unloaded) return;
    this.draftOwner = user && user.id;
    if (!this.draftOwner && !query.id) this.setData({ draftStatus: '无法确定账号，尚不能保存草稿；可点保存重试' });
    if (query.id) {
      wx.setNavigationBarTitle({ title: '编辑机位' });
      const loaded = await this.loadForEdit(query.id);
      if (!this.unloaded) this.setData({ initializing: false, editLoadError: !loaded });
      return;
    }
    if (query.draftId) {
      try { await this.restoreDraft(query.draftId); }
      catch (error) {
        if (!this.unloaded) {
          this.setData({ draftStatus: error.message || '草稿恢复失败，请返回重试', initializing: false });
          wx.showToast({ title: error.message || '草稿恢复失败', icon: 'none' });
        }
        this.restoreFailed = true;
      }
      return;
    }
    if (this.draftOwner && query.fresh !== '1') {
      try {
        const existing = await drafts.list(this.draftOwner);
        if (this.unloaded) return;
        if (existing.length) {
          const choice = await new Promise(resolve => wx.showActionSheet({
            itemList: ['继续最近一份草稿', '查看发布草稿', '新建机位'],
            success: result => resolve(result.tapIndex), fail: () => resolve(-1)
          }));
          if (this.unloaded) return;
          if (choice === 0) {
            try { await this.restoreDraft(existing[0].id); }
            catch (error) {
              this.restoreFailed = true;
              this.setData({ draftStatus: error.message || '草稿恢复失败，请返回重试', initializing: false });
              wx.showToast({ title: error.message || '草稿恢复失败', icon: 'none' });
            }
            return;
          }
          if (choice === 1) { wx.redirectTo({ url: '/pages/drafts/index' }); return; }
          if (choice === -1) { wx.navigateBack(); return; }
          if (existing.length >= drafts.MAX_DRAFTS) this.setData({ draftStatus: '已有 10 份草稿；新内容需清理草稿后才能保存' });
        }
      } catch (error) { this.setData({ draftStatus: error.message || '读取本机草稿失败，可稍后重试' }); }
    }
    if (this.unloaded) return;
    this.setData({ initializing: false, locating: true });
    const revision = this.interactionSeq;
    const location = await geo.getUserLocation({ highAccuracy: true, timeoutMs: 6000 });
    if (this.unloaded) return;
    this.setData({ locating: false });
    if (revision !== this.interactionSeq) return;
    if (location) {
      this.setData({ scale: 17, located: true });
      await this.reverseGeocodeAt(location.latitude, location.longitude);
    } else await this.reverseGeocodeAt(this.data.latitude, this.data.longitude);
  },

  onShow() {
    if (this.data.step === 1) this.mapContext = wx.createMapContext('pickerMap', this);
  },
  onHide() { this.flushDraft().catch(() => {}); },
  onUnload() {
    clearTimeout(this.reverseTimer);
    clearTimeout(this.draftTimer);
    this.reverseSeq += 1;
    this.flushDraft().catch(() => {});
    this.unloaded = true;
  },

  async loadForEdit(id) {
    const spot = await request({ url: `/spots/${id}` }).catch(error => {
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
      return null;
    });
    if (!spot || this.unloaded) return false;
    const meta = { province: spot.province, city: spot.city, district: spot.district, address: spot.address };
    this.setData({ latitude: spot.lat, longitude: spot.lng, scale: 16,
      addressText: [spot.province, spot.city, spot.district, spot.address].filter(Boolean).join(' ') || '请补充地区和地址',
      addressInput: spot.address || '', geoMeta: meta, locationConfirmed: true,
      title: spot.title, description: spot.description || '', accessNote: spot.accessNote || '',
      heading: spot.heading || '', bestTimes: spot.bestTimes || [], bestSeasons: spot.bestSeasons || [],
      focalLength: spot.focalLength || '', difficulty: spot.difficulty == null ? null : spot.difficulty,
      photos: (spot.photos || []).map(photo => ({ key: photo.key, url: photo.url })), step: 2 });
    this.syncRegion(meta);
    this.syncOptionSelection();
    return true;
  },
  async onRetryEdit() {
    this.setData({ initializing: true });
    const loaded = await this.loadForEdit(this.data.editId);
    if (!this.unloaded) this.setData({ initializing: false, editLoadError: !loaded });
  },

  syncOptionSelection() {
    const mark = (options, selected) => options.map(option => ({ ...option, selected: (selected || []).includes(option.value) }));
    this.setData({ bestTimeOptions: mark(format.BEST_TIME_OPTIONS, this.data.bestTimes),
      seasonOptions: mark(format.SEASON_OPTIONS, this.data.bestSeasons) });
  },
  syncRegion(meta) {
    const region = regions.normalize(meta || {});
    const indices = regions.indicesFor(meta || {});
    this.regionDraftIndices = indices;
    this.setData({ regionLabel: region ? region.label : '请选择省份 / 城市', regionIndices: indices,
      regionColumns: [regions.provinces.map(p => p.name), regions.provinces[indices[0]].cities.map(c => c.name)] });
    return region;
  },
  onRegionColumnChange(event) {
    const indices = (this.regionDraftIndices || this.data.regionIndices).slice();
    indices[event.detail.column] = Number(event.detail.value);
    if (event.detail.column === 0) indices[1] = 0;
    this.regionDraftIndices = indices;
    this.setData({ regionIndices: indices,
      regionColumns: [regions.provinces.map(p => p.name), regions.provinces[indices[0]].cities.map(c => c.name)] });
  },
  onRegionPickerCancel() { this.syncRegion(this.data.geoMeta); },
  onChooseRegion(event) {
    if (this.data.submitting) return;
    const region = regions.fromIndices(event.detail.value);
    if (!region) return;
    this.invalidateGeo();
    this.geoDirty = true;
    const meta = { province: region.province, city: region.city, district: region.district, address: this.data.addressInput || null };
    this.setData({ geoMeta: meta, addressText: this.data.addressInput || region.label });
    this.syncRegion(meta);
    this.markEdited();
  },
  invalidateGeo() {
    this.reverseSeq = (this.reverseSeq || 0) + 1;
    this.interactionSeq = (this.interactionSeq || 0) + 1;
    clearTimeout(this.reverseTimer);
    this.reverseTimer = null;
  },

  // ---------- Picking a point / explicit location metadata ----------
  onMapTouchStart() { this.mapTouched = true; this.invalidateGeo(); },
  onRegionChange(event) {
    if (event.type !== 'end' || this.data.initializing || this.data.submitting || event.causedBy === 'update') return;
    if (!this.mapTouched && !['gesture', 'drag', 'scale'].includes(event.causedBy)) return;
    this.mapTouched = false;
    this.invalidateGeo();
    this.geoDirty = true;
    this.setData({ locationConfirmed: false, pointPending: true, geoMeta: null });
    this.syncRegion(null);
    this.markEdited();
    // Capture while the native map still exists, not after the debounce/unmount.
    const revision = this.reverseSeq;
    this.pendingCenter = geo.getCenterLocation(this.mapContext).then(center => {
      if (this.unloaded || revision !== this.reverseSeq) return false;
      this.setData({ latitude: center.latitude, longitude: center.longitude, pointPending: false, locationConfirmed: true });
      this.pointFailed = false;
      this.markEdited(false);
      this.scheduleReverse();
      return true;
    }).catch(() => {
      if (!this.unloaded && revision === this.reverseSeq) {
        this.pointFailed = true;
        this.setData({ pointPending: false, addressText: '选点尚未读取成功，请重试拖动或使用当前位置' });
      }
      return false;
    });
    return this.pendingCenter;
  },
  scheduleReverse() {
    clearTimeout(this.reverseTimer);
    this.reverseTimer = setTimeout(() => {
      this.reverseTimer = null;
      this.reverseGeocodeAt(this.data.latitude, this.data.longitude);
    }, REVERSE_DEBOUNCE_MS);
  },
  async reverseGeocode() {
    const revision = this.reverseSeq;
    const center = await geo.getCenterLocation(this.mapContext).catch(() => null);
    if (!center || this.unloaded || revision !== this.reverseSeq) return;
    return this.reverseGeocodeAt(center.latitude, center.longitude);
  },
  async reverseGeocodeAt(latitude, longitude) {
    if (this.unloaded) return;
    const seq = ++this.reverseSeq;
    const addressRevision = this.addressRevision;
    this.setData({ latitude, longitude, addressText: '正在获取地址…', geoMeta: null });
    this.syncRegion(null);
    let meta;
    let failure;
    try { meta = await request({ url: `/geo/reverse?lng=${longitude}&lat=${latitude}` }); }
    catch (error) { failure = error; }
    if (this.unloaded || seq !== this.reverseSeq) return;
    if (failure || !meta || !meta.configured) {
      this.setData({ geoConfigured: Boolean(failure),
        addressText: failure ? `${failure.message || '地址服务调用失败'}；可在下方手动填写地址` :
          '未接入逆地理编码（服务端没配高德 Key），请手动选择地区并填写地址' });
      if (this.editVersion) this.markEdited(false);
      return;
    }
    const region = regions.normalize(meta);
    const result = region ? { province: region.province, city: region.city, district: region.district, address: meta.address } : {
      province: meta.province || null, city: meta.city || null, district: meta.district || null, address: meta.address || null };
    const address = addressRevision !== this.addressRevision ? this.data.addressInput : (meta.address || '');
    this.setData({ geoConfigured: true, geoMeta: result, addressInput: address,
      addressText: address || (region ? region.label : '地址不完整，请选择省份 / 城市并填写详细地址') });
    this.syncRegion(result);
    if (this.editVersion) this.markEdited(false);
  },
  async onUseCurrentLocation() {
    if (this.data.submitting) return;
    this.invalidateGeo();
    const revision = this.interactionSeq;
    const location = await geo.getUserLocation();
    if (this.unloaded || revision !== this.interactionSeq) return;
    if (!location) {
      const opened = await geo.openLocationSetting();
      if (!opened && !this.unloaded) wx.showToast({ title: '未获得定位权限', icon: 'none' });
      return;
    }
    this.geoDirty = true;
    this.pointFailed = false;
    this.setData({ scale: 17, locationConfirmed: true, pointPending: false });
    this.markEdited();
    await this.reverseGeocodeAt(location.latitude, location.longitude);
  },
  async onNextStep() {
    if (this.data.initializing || this.data.submitting) return;
    if (this.pendingCenter) await this.pendingCenter;
    if (this.unloaded) return;
    if (this.pointFailed || this.data.pointPending) {
      wx.showToast({ title: '请先完成选点，可重试拖动或使用当前位置', icon: 'none' }); return;
    }
    if (this.reverseTimer) {
      clearTimeout(this.reverseTimer);
      this.reverseTimer = null;
      this.reverseGeocodeAt(this.data.latitude, this.data.longitude);
    }
    this.setData({ step: 2, locationConfirmed: true });
    this.markEdited();
  },
  onBackToStep1() {
    if (this.data.submitting) return;
    this.setData({ step: 1 }, () => { this.mapContext = wx.createMapContext('pickerMap', this); });
    this.markEdited();
  },
  onToggleAgree() { if (!this.data.submitting) this.setData({ agreed: !this.data.agreed }); },
  onOpenLegal(event) { wx.navigateTo({ url: `/pages/legal/index?type=${event.currentTarget.dataset.type}` }); },

  // ---------- Form ----------
  onInput(event) {
    if (this.data.submitting) return;
    const field = event.currentTarget.dataset.field;
    if (!['title', 'description', 'accessNote', 'addressInput'].includes(field)) return;
    this.setData({ [field]: event.detail.value });
    if (field === 'addressInput') { this.addressRevision += 1; this.geoDirty = true; }
    this.markEdited();
  },
  onPickSingle(event) {
    if (this.data.submitting) return;
    const { field, value } = event.currentTarget.dataset;
    if (!['heading', 'focalLength'].includes(field)) return;
    this.setData({ [field]: this.data[field] === value ? '' : value });
    this.markEdited();
  },
  onToggleMulti(event) {
    if (this.data.submitting) return;
    const { field, value } = event.currentTarget.dataset;
    if (!['bestTimes', 'bestSeasons'].includes(field)) return;
    const list = this.data[field] || [];
    this.setData({ [field]: list.includes(value) ? list.filter(item => item !== value) : list.concat(value) });
    this.syncOptionSelection();
    this.markEdited();
  },
  onPickDifficulty(event) {
    if (this.data.submitting) return;
    const value = Number(event.currentTarget.dataset.value);
    this.setData({ difficulty: [1, 2, 3].includes(value) ? value : null });
    this.markEdited();
  },
  onChoosePhoto() {
    if (this.data.submitting) return;
    const remaining = this.data.maxPhotos - this.data.photos.length;
    if (remaining <= 0) { wx.showToast({ title: `最多 ${this.data.maxPhotos} 张`, icon: 'none' }); return; }
    wx.chooseMedia({ count: remaining, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success: res => {
        if (this.unloaded || this.data.submitting) return;
        const added = res.tempFiles.map(file => ({ tempPath: file.tempFilePath, url: file.tempFilePath }));
        this.setData({ photos: this.data.photos.concat(added).slice(0, this.data.maxPhotos) });
        this.markEdited();
      }
    });
  },
  onRemovePhoto(event) {
    if (this.data.submitting) return;
    const photos = this.data.photos.slice();
    photos.splice(Number(event.currentTarget.dataset.index), 1);
    this.setData({ photos });
    this.markEdited();
  },
  onPreviewPhoto(event) {
    const photo = this.data.photos[Number(event.currentTarget.dataset.index)];
    if (photo) wx.previewImage({ current: photo.url, urls: this.data.photos.map(item => item.url) });
  },

  // ---------- Local drafts (new publications only) ----------
  markEdited(userAction = true) {
    if (this.published || this.data.isEdit || this.restoreFailed) return;
    if (userAction) this.interactionSeq = (this.interactionSeq || 0) + 1;
    this.editVersion = (this.editVersion || 0) + 1;
    if (!this.data.draftId) this.setData({ draftId: drafts.createId() });
    this.setData({ draftStatus: this.draftOwner ? '有修改，等待保存…' : '无法确定账号，尚不能保存草稿；可点保存重试' });
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.flushDraft().catch(() => {}), AUTOSAVE_MS);
  },
  async restoreDraft(id) {
    const restored = await drafts.load(this.draftOwner, id);
    if (this.unloaded) return;
    this.invalidateGeo();
    this.addressRevision += 1;
    this.setData({ ...drafts.formSnapshot(restored), photos: restored.photos, draftId: id,
      agreed: false, initializing: false, missingPhotoCount: restored.missingPhotos,
      addressText: restored.addressInput || '请确认地区和详细地址', draftStatus: '已恢复本机草稿' });
    this.syncRegion(restored.geoMeta);
    this.syncOptionSelection();
    this.editVersion = this.savedVersion = 0;
    if (restored.missingPhotos) wx.showToast({ title: `${restored.missingPhotos} 张照片已失效，请重新选择`, icon: 'none' });
  },
  async onSaveDraft() {
    if (this.data.isEdit || this.published || this.data.submitting) return;
    if (!this.draftOwner) {
      const user = await auth.ensureLogin().catch(() => null);
      this.draftOwner = user && user.id;
    }
    if (!this.editVersion) {
      wx.showToast({ title: this.data.draftId ? '草稿已经保存' : '填写内容后即可保存草稿', icon: 'none' });
      return;
    }
    await this.flushDraft(true).catch(() => {});
  },
  flushDraft(notify = false) {
    clearTimeout(this.draftTimer);
    if (this.data.isEdit || this.published || this.restoreFailed || !this.editVersion || this.editVersion === this.savedVersion) return Promise.resolve();
    if (this.draftSavePromise) return this.draftSavePromise;
    const operation = async () => {
      while (!this.published && this.editVersion !== this.savedVersion) {
        const current = auth.currentUser();
        if (!this.draftOwner || !current || current.id !== this.draftOwner) throw new Error('无法确定当前账号，尚不能保存草稿；请重新登录后重试');
        const version = this.editVersion;
        const snapshot = { ...this.data, photos: this.data.photos.map(photo => ({ ...photo })) };
        if (!this.unloaded) this.setData({ draftSaving: true, draftStatus: '正在保存草稿和照片…' });
        const saved = await drafts.save(this.draftOwner, this.data.draftId, snapshot, { isCurrent: () => {
          if (this.published) return false;
          const activeUser = auth.currentUser();
          if (!activeUser || activeUser.id !== this.draftOwner) throw new Error('账号已变化，草稿保存已停止');
          return true;
        } });
        if (!saved || this.published) break;
        const paths = new Map(snapshot.photos.map((photo, index) => [photo.tempPath, saved.photos[index].path]));
        const photos = this.data.photos.map(photo => paths.has(photo.tempPath) ?
          { tempPath: paths.get(photo.tempPath), url: paths.get(photo.tempPath) } : photo);
        if (this.unloaded) this.data.photos = photos;
        else this.setData({ photos });
        this.savedVersion = version;
      }
      if (!this.unloaded && !this.published) {
        this.setData({ draftStatus: '已保存到本机 · 不跨设备同步', draftSaving: false });
        if (notify) wx.showToast({ title: '草稿已保存', icon: 'success' });
      }
    };
    this.draftSavePromise = operation().catch(error => {
      if (!this.unloaded && !this.published) {
        this.setData({ draftStatus: `保存失败：${error.message || '请重试'}。请检查空间或清理草稿后重试。`, draftSaving: false });
        if (notify) wx.showToast({ title: error.message || '草稿保存失败', icon: 'none' });
      }
      throw error;
    }).finally(() => { this.draftSavePromise = null; });
    return this.draftSavePromise;
  },
  async onOpenDrafts() {
    if (this.data.submitting) return;
    try { await this.flushDraft(); }
    catch (error) {
      const leave = await new Promise(resolve => wx.showModal({ title: '草稿尚未保存',
        content: '本次修改未能保存，离开会丢失未保存内容。仍要去草稿箱吗？',
        success: result => resolve(result.confirm), fail: () => resolve(false) }));
      if (!leave) return;
    }
    if (!this.unloaded) wx.redirectTo({ url: '/pages/drafts/index' });
  },

  async onSubmit() {
    if (this.published || this.data.submitting || this.data.initializing || this.data.editLoadError || this.restoreFailed) return;
    if (this.data.pointPending || this.pointFailed) { wx.showToast({ title: '请先完成地图选点', icon: 'none' }); return; }
    const title = (this.data.title || '').trim();
    if (title.length < 2) { wx.showToast({ title: '标题至少 2 个字', icon: 'none' }); return; }
    if (!this.data.photos.length) { wx.showToast({ title: '至少上传 1 张样张', icon: 'none' }); return; }
    if (!this.data.isEdit && !this.data.agreed) { wx.showToast({ title: '请先阅读并同意用户协议', icon: 'none' }); return; }
    const region = regions.normalize(this.data.geoMeta || {});
    if ((!this.data.isEdit || this.geoDirty) && !region) {
      wx.showToast({ title: '请先选择完整的省份 / 城市', icon: 'none' }); return;
    }
    const manualAddress = (this.data.addressInput || '').trim();
    if ((!this.data.isEdit || this.geoDirty) && !manualAddress) {
      wx.showToast({ title: '请填写详细地址', icon: 'none' }); return;
    }
    this.setData({ submitting: true });
    wx.showLoading({ title: this.data.isEdit ? '保存中…' : '发布中…', mask: true });
    try {
      await auth.ensureLogin();
      const current = auth.currentUser();
      if (this.draftOwner && (!current || current.id !== this.draftOwner)) throw new Error('当前账号已变化，请返回后重新打开');
      await this.flushDraft().catch(() => {});
      const sourcePhotos = this.data.photos.slice();
      const tempPaths = sourcePhotos.filter(photo => photo.tempPath).map(photo => photo.tempPath);
      const uploaded = tempPaths.length ? await uploadPhotos(tempPaths) : { keys: [] };
      let index = 0;
      const photoKeys = sourcePhotos.map(photo => photo.key || uploaded.keys[index++]);
      const payload = { title, description: this.data.description || '', photoKeys,
        difficulty: this.data.difficulty, heading: this.data.heading || null,
        bestTimes: this.data.bestTimes.slice(), bestSeasons: this.data.bestSeasons.slice(),
        focalLength: this.data.focalLength || null, accessNote: this.data.accessNote || null };
      if (!this.data.isEdit || this.geoDirty) {
        payload.lat = this.data.latitude;
        payload.lng = this.data.longitude;
        payload.geo = { province: region.province, city: region.city, district: region.district, address: manualAddress.slice(0, 120) };
      }
      const saved = await request({ url: this.data.isEdit ? `/spots/${this.data.editId}` : '/spots',
        method: this.data.isEdit ? 'PATCH' : 'POST', data: payload });
      if (!saved || !saved.id) throw new Error('未收到发布成功确认，草稿已保留');
      this.published = true;
      clearTimeout(this.draftTimer);
      this.reverseSeq += 1;
      if (!this.data.isEdit && this.draftOwner && this.data.draftId) {
        const cleanup = await drafts.remove(this.draftOwner, this.data.draftId).catch(() => {
          wx.showModal({ title: '作品已发布', content: '本机草稿清理失败，请到草稿箱删除，避免重复发布。', showCancel: false });
        });
        if (cleanup && cleanup.cleanupPending) wx.showToast({ title: '已发布，残留草稿照片将稍后重试清理', icon: 'none' });
      }
      wx.hideLoading();
      const pending = saved.status === 'pending';
      wx.showToast({ title: this.data.isEdit ? '已更新' : pending ? '已提交，审核通过后公开' : '发布成功', icon: pending ? 'none' : 'success' });
      setTimeout(() => {
        if (this.unloaded) return;
        if (this.data.isEdit) wx.navigateBack();
        else wx.redirectTo({ url: `/pages/spot/detail?id=${saved.id}` });
      }, 700);
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: error.message || '发布失败，草稿已保留', icon: 'none' });
    } finally { if (!this.unloaded) this.setData({ submitting: false }); }
  }
});
